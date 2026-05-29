import { createClient, type SupabaseClient, type User } from 'https://esm.sh/@supabase/supabase-js@2.75.0'

type Json = Record<string, unknown>

type Action = 'create' | 'qr' | 'reconnect' | 'disconnect' | 'status'

type SessionRequest = {
  action: Action
  workspaceId: string
  connectionId?: string
  sessionName?: string
  displayName?: string
  idempotencyKey?: string
}

type ConnectionStatus = 'pending' | 'connecting' | 'online' | 'offline' | 'failed' | 'disconnecting'

type WhatsAppConnection = {
  id: string
  workspace_id: string
  provider_type: 'official' | 'qr_session'
  session_name: string
  display_name?: string | null
  phone_number: string | null
  status: ConnectionStatus
  qr_code: string | null
  provider_instance_id?: string | null
  is_active: boolean
  last_seen_at: string | null
  qr_expires_at?: string | null
  connected_at?: string | null
  disconnected_at?: string | null
  last_error?: string | null
  created_by?: string | null
  created_at: string
  updated_at?: string
  deleted_at?: string | null
}

type ProviderStatus = {
  status: ConnectionStatus
  phoneNumber?: string
  qrCode?: string
  lastSeenAt?: string
  providerInstanceId?: string
  rawState?: string
}

type SuccessResponse = {
  requestId: string
  action: Action
  workspaceId: string
  connection: WhatsAppConnection
  provider: ProviderStatus
  idempotent?: boolean
}

type IdempotencyRow = {
  id: string
  request_hash: string
  response: SuccessResponse | null
  status: 'processing' | 'succeeded' | 'failed'
  locked_until: string | null
  expires_at: string
}

type IdempotencyLease = {
  response: SuccessResponse | null
  lockAcquired: boolean
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Json,
  ) {
    super(message)
  }
}

class EvolutionApiError extends HttpError {
  constructor(status: number, method: string, path: string) {
    super(status >= 500 ? 502 : status, 'EVOLUTION_API_ERROR', 'Evolution API request failed', {
      providerStatus: status,
      method,
      path,
    })
  }
}

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const evolutionApiBaseUrl = (Deno.env.get('EVOLUTION_API_BASE_URL') ?? Deno.env.get('EVOLUTION_API_URL') ?? '').replace(/\/+$/, '')
const evolutionApiKey = Deno.env.get('EVOLUTION_API_KEY') ?? ''
const appEnv = (Deno.env.get('APP_ENV') ?? Deno.env.get('ENVIRONMENT') ?? 'production').toLowerCase()
const isLocalDevelopment = ['development', 'local', 'test'].includes(appEnv)
const configuredCorsOrigins = Deno.env.get('CORS_ALLOWED_ORIGINS')
const allowedOrigins = (configuredCorsOrigins ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)
const parsedEvolutionTimeoutMs = Number(Deno.env.get('EVOLUTION_API_TIMEOUT_MS') ?? 10_000)
const evolutionTimeoutMs = Number.isFinite(parsedEvolutionTimeoutMs) && parsedEvolutionTimeoutMs >= 1_000 && parsedEvolutionTimeoutMs <= 30_000
  ? parsedEvolutionTimeoutMs
  : 10_000

const rateLimits: Record<Action, { max: number; windowSeconds: number }> = {
  create: { max: 8, windowSeconds: 60 },
  qr: { max: 30, windowSeconds: 60 },
  reconnect: { max: 10, windowSeconds: 60 },
  disconnect: { max: 10, windowSeconds: 60 },
  status: { max: 60, windowSeconds: 60 },
}

const inMemoryRateLimit = new Map<string, number[]>()

const requiredEnv = {
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceRoleKey,
  EVOLUTION_API_BASE_URL: evolutionApiBaseUrl,
  EVOLUTION_API_KEY: evolutionApiKey,
}

let supabaseClient: SupabaseClient | null = null

const getSupabase = () => {
  if (!supabaseClient) {
    supabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  return supabaseClient
}

const makeCorsHeaders = (request: Request) => {
  const requestOrigin = request.headers.get('Origin') ?? ''
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key, x-request-id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }

  if (configuredCorsOrigins) {
    if (allowedOrigins.includes('*')) {
      if (isLocalDevelopment) {
        corsHeaders['Access-Control-Allow-Origin'] = requestOrigin || '*'
      }
    } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      corsHeaders['Access-Control-Allow-Origin'] = requestOrigin
    }
  } else if (isLocalDevelopment) {
    corsHeaders['Access-Control-Allow-Origin'] = requestOrigin || '*'
  }

  return corsHeaders
}

const jsonResponse = (request: Request, body: unknown, status = 200, extraHeaders: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...makeCorsHeaders(request),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      ...extraHeaders,
    },
  })

const log = (level: 'info' | 'warn' | 'error', event: string, fields: Json = {}) => {
  console[level](JSON.stringify({
    event,
    level,
    service: 'whatsapp-evolution-session',
    timestamp: new Date().toISOString(),
    ...fields,
  }))
}

const sanitizeError = (error: unknown, requestId: string) => {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: {
        requestId,
        error: {
          code: error.code,
          message: error.message,
        },
      },
    }
  }

  return {
    status: 500,
    body: {
      requestId,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Unexpected server error',
      },
    },
  }
}

const assertEnv = () => {
  const missing = Object.entries(requiredEnv).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length > 0) {
    throw new HttpError(500, 'MISSING_ENV', 'Server configuration is incomplete', { missing })
  }
}

const readJson = async (request: Request) => {
  try {
    return await request.json()
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON')
  }
}

const isAction = (value: unknown): value is Action =>
  value === 'create' || value === 'qr' || value === 'reconnect' || value === 'disconnect' || value === 'status'

const normalizeInput = (body: unknown, request: Request): SessionRequest => {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'INVALID_BODY', 'Request body is required')
  }

  const payload = body as Record<string, unknown>
  if (!isAction(payload.action)) {
    throw new HttpError(400, 'INVALID_ACTION', 'Action must be one of create, qr, reconnect, disconnect, status')
  }

  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId.trim() : ''
  const connectionId = typeof payload.connectionId === 'string' ? payload.connectionId.trim() : undefined
  const sessionName = typeof payload.sessionName === 'string' ? payload.sessionName.trim() : undefined
  const displayName = typeof payload.displayName === 'string' ? payload.displayName.trim() : undefined
  const headerIdempotencyKey = request.headers.get('x-idempotency-key')?.trim()
  const bodyIdempotencyKey = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey.trim() : undefined
  const idempotencyKey = headerIdempotencyKey || bodyIdempotencyKey

  validateWorkspaceId(workspaceId)
  if (connectionId) {
    validateUuid(connectionId, 'connectionId')
  }
  if (sessionName) {
    validateSessionName(sessionName)
  }
  if (displayName && displayName.length > 120) {
    throw new HttpError(400, 'INVALID_DISPLAY_NAME', 'Display name must be at most 120 characters')
  }
  if (idempotencyKey && !/^[a-zA-Z0-9._:-]{8,160}$/.test(idempotencyKey)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency key format is invalid')
  }

  if (payload.action === 'create' && !sessionName) {
    throw new HttpError(400, 'MISSING_SESSION_NAME', 'sessionName is required for create')
  }
  if (payload.action !== 'create' && !connectionId && !sessionName) {
    throw new HttpError(400, 'MISSING_CONNECTION_REFERENCE', 'connectionId or sessionName is required')
  }

  return {
    action: payload.action,
    workspaceId,
    connectionId,
    sessionName,
    displayName,
    idempotencyKey,
  }
}

const validateWorkspaceId = (workspaceId: string) => {
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(workspaceId)) {
    throw new HttpError(400, 'INVALID_WORKSPACE_ID', 'workspaceId is invalid')
  }
}

const validateUuid = (value: string, fieldName: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'INVALID_UUID', `${fieldName} must be a valid UUID`)
  }
}

const validateSessionName = (sessionName: string) => {
  if (!/^[a-zA-Z0-9_-]{3,80}$/.test(sessionName)) {
    throw new HttpError(400, 'INVALID_SESSION_NAME', 'sessionName must be 3-80 characters and contain only letters, numbers, underscore or hyphen')
  }
}

const getBearerToken = (request: Request) => {
  const authorization = request.headers.get('Authorization') ?? ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  if (!match?.[1]) {
    throw new HttpError(401, 'MISSING_JWT', 'Supabase JWT is required')
  }
  return match[1]
}

const authenticate = async (request: Request) => {
  const token = getBearerToken(request)
  const { data, error } = await getSupabase().auth.getUser(token)
  if (error || !data.user) {
    throw new HttpError(401, 'INVALID_JWT', 'Supabase JWT is invalid or expired')
  }
  return data.user
}

const requireWorkspaceAdmin = async (workspaceId: string, user: User) => {
  const { data, error } = await getSupabase()
    .from('workspace_members')
    .select('role, accepted_at, disabled_at, deleted_at, status')
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    throw new HttpError(500, 'MEMBERSHIP_LOOKUP_FAILED', 'Could not validate workspace membership')
  }
  if (!data) {
    throw new HttpError(403, 'WORKSPACE_MEMBERSHIP_REQUIRED', 'User is not a member of this workspace')
  }
  if (data.deleted_at || data.disabled_at || !data.accepted_at || data.status !== 'active') {
    throw new HttpError(403, 'WORKSPACE_MEMBERSHIP_INACTIVE', 'Workspace membership is not active')
  }
  if (data.role !== 'owner' && data.role !== 'admin') {
    throw new HttpError(403, 'INSUFFICIENT_ROLE', 'Only workspace owner or admin can manage Evolution sessions')
  }
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  const objectValue = value as Record<string, unknown>
  return `{${Object.keys(objectValue).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(',')}}`
}

const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const plusSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

const redactIdentifier = (value: string) => value.length <= 14 ? '[redacted]' : `${value.slice(0, 8)}...${value.slice(-6)}`

const buildProviderInstanceId = async (workspaceId: string, connectionId: string) => {
  const digest = await sha256(`workspace:${workspaceId}:connection:${connectionId}`)
  return `wf_${digest.slice(0, 48)}`
}

const requireProviderInstanceId = (connection: WhatsAppConnection) => {
  if (!connection.provider_instance_id) {
    throw new HttpError(409, 'MISSING_PROVIDER_INSTANCE_ID', 'Connection is missing a safe provider instance id')
  }

  return connection.provider_instance_id
}

const applyRateLimit = async (input: SessionRequest, user: User, requestId: string) => {
  const limit = rateLimits[input.action]
  const scope = `whatsapp-evolution-session:${input.action}:${user.id}`

  const { data, error } = await getSupabase().rpc('consume_rate_limit', {
    target_workspace_id: input.workspaceId,
    target_scope: scope,
    window_seconds: limit.windowSeconds,
    max_requests: limit.max,
  })

  if (error) {
    log(isLocalDevelopment ? 'warn' : 'error', 'rate_limit_rpc_unavailable', {
      requestId,
      workspaceId: input.workspaceId,
      action: input.action,
      userId: user.id,
      code: error.code,
    })
    if (isLocalDevelopment) {
      applyInMemoryRateLimit(input, user)
      return
    }
    throw new HttpError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limit service is unavailable')
  }

  if (data !== true) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests for this action')
  }
}

const applyInMemoryRateLimit = (input: SessionRequest, user: User) => {
  const limit = rateLimits[input.action]
  const key = `${input.workspaceId}:${input.action}:${user.id}`
  const now = Date.now()
  const windowStart = now - limit.windowSeconds * 1000
  const hits = (inMemoryRateLimit.get(key) ?? []).filter((timestamp) => timestamp > windowStart)
  if (hits.length >= limit.max) {
    throw new HttpError(429, 'RATE_LIMITED', 'Too many requests for this action')
  }
  hits.push(now)
  inMemoryRateLimit.set(key, hits)
}

const idempotencyScope = 'whatsapp-evolution-session:create'

const getIdempotencyKey = (input: SessionRequest) => input.idempotencyKey ?? `create:${input.workspaceId}:${input.sessionName}`

const toSafeIdempotencyResponse = (response: SuccessResponse): SuccessResponse => {
  const { qrCode: _qrCode, ...providerWithoutQr } = response.provider

  return {
    ...response,
    connection: {
      ...response.connection,
      qr_code: null,
    },
    provider: providerWithoutQr,
  }
}

const getIdempotentResponse = async (input: SessionRequest, requestHash: string): Promise<IdempotencyLease> => {
  const key = getIdempotencyKey(input)
  const { error } = await getSupabase().from('idempotency_keys').insert({
    workspace_id: input.workspaceId,
    scope: idempotencyScope,
    key,
    request_hash: requestHash,
    status: 'processing',
    locked_until: plusSeconds(120),
    expires_at: plusSeconds(24 * 60 * 60),
  })

  if (!error) {
    return { response: null, lockAcquired: true }
  }
  if (error.code !== '23505') {
    throw new HttpError(500, 'IDEMPOTENCY_STORE_FAILED', 'Could not reserve idempotency key')
  }

  const { data, error: readError } = await getSupabase()
    .from('idempotency_keys')
    .select('id, request_hash, response, status, locked_until, expires_at')
    .eq('workspace_id', input.workspaceId)
    .eq('scope', idempotencyScope)
    .eq('key', key)
    .maybeSingle<IdempotencyRow>()

  if (readError || !data) {
    throw new HttpError(500, 'IDEMPOTENCY_LOOKUP_FAILED', 'Could not read idempotency key')
  }
  if (data.request_hash !== requestHash) {
    throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request')
  }
  if (data.status === 'succeeded' && data.response) {
    return {
      response: {
        ...data.response,
        idempotent: true,
      },
      lockAcquired: false,
    }
  }
  if (data.status === 'processing' && data.locked_until && new Date(data.locked_until).getTime() > Date.now()) {
    throw new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A create request with this idempotency key is already in progress')
  }

  const lockableBefore = new Date().toISOString()
  const { data: updatedLock, error: updateError } = await getSupabase()
    .from('idempotency_keys')
    .update({
      status: 'processing',
      locked_until: plusSeconds(120),
      expires_at: plusSeconds(24 * 60 * 60),
    })
    .eq('workspace_id', input.workspaceId)
    .eq('scope', idempotencyScope)
    .eq('key', key)
    .eq('request_hash', requestHash)
    .neq('status', 'succeeded')
    .or(`locked_until.is.null,locked_until.lt.${lockableBefore}`)
    .select('id')
    .maybeSingle()

  if (updateError) {
    throw new HttpError(500, 'IDEMPOTENCY_LOCK_FAILED', 'Could not lock idempotency key')
  }
  if (!updatedLock) {
    throw new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A create request with this idempotency key is already in progress')
  }

  return { response: null, lockAcquired: true }
}

const completeIdempotency = async (input: SessionRequest, response: SuccessResponse, requestHash: string) => {
  const { data, error } = await getSupabase()
    .from('idempotency_keys')
    .update({
      status: 'succeeded',
      response: toSafeIdempotencyResponse(response),
      locked_until: null,
    })
    .eq('workspace_id', input.workspaceId)
    .eq('scope', idempotencyScope)
    .eq('key', getIdempotencyKey(input))
    .eq('request_hash', requestHash)
    .eq('status', 'processing')
    .select('id')
    .maybeSingle()

  if (error) {
    log('warn', 'idempotency_complete_failed', {
      requestId: response.requestId,
      workspaceId: input.workspaceId,
      action: input.action,
      code: error.code,
    })
    return false
  }

  if (!data) {
    log('warn', 'idempotency_complete_skipped', {
      requestId: response.requestId,
      workspaceId: input.workspaceId,
      action: input.action,
      reason: 'lock_not_owned_or_already_completed',
    })
    return false
  }

  return true
}

const failIdempotency = async (input: SessionRequest, requestId: string, requestHash: string, lockAcquired: boolean) => {
  if (input.action !== 'create' || !lockAcquired) {
    return
  }

  const { error } = await getSupabase()
    .from('idempotency_keys')
    .update({ status: 'failed', locked_until: null })
    .eq('workspace_id', input.workspaceId)
    .eq('scope', idempotencyScope)
    .eq('key', getIdempotencyKey(input))
    .eq('request_hash', requestHash)
    .eq('status', 'processing')

  if (error) {
    log('warn', 'idempotency_fail_failed', {
      requestId,
      workspaceId: input.workspaceId,
      action: input.action,
      code: error.code,
    })
  }
}

const evolutionUrl = (path: string) => `${evolutionApiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`

const evolutionRequest = async (method: 'GET' | 'POST' | 'DELETE', path: string, body?: Json) => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), evolutionTimeoutMs)
  let response: Response

  try {
    response = await fetch(evolutionUrl(path), {
      method,
      headers: {
        apikey: evolutionApiKey,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpError(504, 'EVOLUTION_TIMEOUT', 'Evolution API request timed out', { method, path })
    }

    throw new HttpError(502, 'EVOLUTION_NETWORK_ERROR', 'Evolution API request failed before receiving a response', { method, path })
  } finally {
    clearTimeout(timeoutId)
  }

  const text = await response.text()
  const payload = parseJson(text)

  if (!response.ok) {
    throw new EvolutionApiError(response.status, method, path)
  }

  return payload
}

const cleanupProviderSession = async (providerInstanceId: string, requestId: string, workspaceId: string) => {
  try {
    await evolutionRequest('DELETE', `/instance/logout/${encodeURIComponent(providerInstanceId)}`)
    log('info', 'provider_session_cleanup_completed', {
      requestId,
      workspaceId,
      providerInstanceId: redactIdentifier(providerInstanceId),
    })
  } catch (error) {
    log('error', 'provider_session_cleanup_failed', {
      requestId,
      workspaceId,
      providerInstanceId: redactIdentifier(providerInstanceId),
      errorCode: error instanceof HttpError ? error.code : 'UNKNOWN_ERROR',
    })
  }
}

const parseJson = (text: string): unknown => {
  if (!text) {
    return {}
  }

  try {
    return JSON.parse(text)
  } catch {
    return { text }
  }
}

const readPath = (value: unknown, path: string[]) => {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

const asString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined

const firstString = (value: unknown, paths: string[][]) => {
  for (const path of paths) {
    const found = asString(readPath(value, path))
    if (found) {
      return found
    }
  }
  return undefined
}

const mapStatus = (rawState?: string): ConnectionStatus => {
  const normalized = rawState?.toLowerCase().replace(/[\s-]+/g, '_')
  if (!normalized) {
    return 'pending'
  }
  if (['open', 'opened', 'connected', 'online'].includes(normalized)) {
    return 'online'
  }
  if (['connecting', 'qrcode', 'qr_code', 'pairing', 'created', 'pending'].includes(normalized)) {
    return 'connecting'
  }
  if (['close', 'closed', 'disconnected', 'offline', 'logout', 'logged_out'].includes(normalized)) {
    return 'offline'
  }
  if (['failed', 'error', 'invalid'].includes(normalized)) {
    return 'failed'
  }
  return 'pending'
}

const normalizeProviderStatus = (payload: unknown, fallbackStatus: ConnectionStatus): ProviderStatus => {
  const rawState = firstString(payload, [
    ['instance', 'state'],
    ['instance', 'status'],
    ['state'],
    ['status'],
    ['connectionState'],
    ['connection', 'state'],
  ])
  const status = rawState ? mapStatus(rawState) : fallbackStatus
  const qrCode = firstString(payload, [
    ['qrcode', 'base64'],
    ['qrcode', 'code'],
    ['qrcode'],
    ['qrCode'],
    ['qr'],
    ['base64'],
    ['code'],
  ])
  const phoneNumber = firstString(payload, [
    ['instance', 'owner'],
    ['instance', 'phoneNumber'],
    ['phoneNumber'],
    ['number'],
    ['owner'],
  ])
  const providerInstanceId = firstString(payload, [
    ['instance', 'instanceName'],
    ['instance', 'id'],
    ['instanceName'],
    ['id'],
  ])
  const lastSeenAt = firstString(payload, [
    ['instance', 'lastSeenAt'],
    ['lastSeenAt'],
  ])

  return {
    status,
    phoneNumber,
    qrCode,
    lastSeenAt,
    providerInstanceId,
    rawState,
  }
}

const fetchConnection = async (input: SessionRequest) => {
  let query = getSupabase()
    .from('whatsapp_connections')
    .select('id, workspace_id, provider_type, session_name, display_name, phone_number, status, qr_code, provider_instance_id, is_active, last_seen_at, qr_expires_at, connected_at, disconnected_at, last_error, created_by, created_at, updated_at, deleted_at')
    .eq('workspace_id', input.workspaceId)
    .eq('provider_type', 'qr_session')

  query = input.connectionId ? query.eq('id', input.connectionId) : query.eq('session_name', input.sessionName)
  const { data, error } = await query.maybeSingle<WhatsAppConnection>()

  if (error) {
    throw new HttpError(500, 'CONNECTION_LOOKUP_FAILED', 'Could not load WhatsApp connection')
  }
  if (!data || data.deleted_at) {
    throw new HttpError(404, 'CONNECTION_NOT_FOUND', 'WhatsApp Evolution connection was not found')
  }

  return data
}

const findExistingCreateConnection = async (input: SessionRequest) => {
  const { data, error } = await getSupabase()
    .from('whatsapp_connections')
    .select('id, workspace_id, provider_type, session_name, display_name, phone_number, status, qr_code, provider_instance_id, is_active, last_seen_at, qr_expires_at, connected_at, disconnected_at, last_error, created_by, created_at, updated_at, deleted_at')
    .eq('workspace_id', input.workspaceId)
    .eq('provider_type', 'qr_session')
    .eq('session_name', input.sessionName)
    .is('deleted_at', null)
    .maybeSingle<WhatsAppConnection>()

  if (error) {
    throw new HttpError(500, 'CONNECTION_LOOKUP_FAILED', 'Could not load WhatsApp connection')
  }
  return data ?? null
}

const updateConnection = async (connectionId: string, workspaceId: string, values: Partial<WhatsAppConnection>) => {
  const { data, error } = await getSupabase()
    .from('whatsapp_connections')
    .update(values)
    .eq('id', connectionId)
    .eq('workspace_id', workspaceId)
    .select('id, workspace_id, provider_type, session_name, display_name, phone_number, status, qr_code, provider_instance_id, is_active, last_seen_at, qr_expires_at, connected_at, disconnected_at, last_error, created_by, created_at, updated_at, deleted_at')
    .single<WhatsAppConnection>()

  if (error) {
    throw new HttpError(500, 'CONNECTION_UPDATE_FAILED', 'Could not update WhatsApp connection')
  }

  return data
}

const insertConnection = async (
  input: SessionRequest,
  user: User,
  provider: ProviderStatus,
  connectionId: string,
  providerInstanceId: string,
) => {
  const now = new Date().toISOString()
  const { data, error } = await getSupabase()
    .from('whatsapp_connections')
    .insert({
      id: connectionId,
      workspace_id: input.workspaceId,
      provider_type: 'qr_session',
      session_name: input.sessionName,
      display_name: input.displayName || input.sessionName,
      provider_instance_id: providerInstanceId,
      phone_number: provider.phoneNumber ?? null,
      status: provider.status,
      qr_code: provider.qrCode ?? null,
      qr_expires_at: provider.qrCode ? plusSeconds(60) : null,
      connected_at: provider.status === 'online' ? now : null,
      disconnected_at: null,
      last_error: null,
      is_active: true,
      last_seen_at: provider.lastSeenAt ?? (provider.status === 'online' ? now : null),
      created_by: user.id,
    })
    .select('id, workspace_id, provider_type, session_name, display_name, phone_number, status, qr_code, provider_instance_id, is_active, last_seen_at, qr_expires_at, connected_at, disconnected_at, last_error, created_by, created_at, updated_at, deleted_at')
    .single<WhatsAppConnection>()

  if (error) {
    if (error.code === '23505') {
      const existing = await findExistingCreateConnection(input)
      if (existing) {
        return existing
      }
    }
    throw new HttpError(500, 'CONNECTION_INSERT_FAILED', 'Could not create WhatsApp connection')
  }

  return data
}

const valuesForProviderStatus = (provider: ProviderStatus) => {
  const now = new Date().toISOString()
  return {
    status: provider.status,
    qr_code: provider.qrCode ?? null,
    qr_expires_at: provider.qrCode ? plusSeconds(60) : null,
    provider_instance_id: provider.providerInstanceId ?? null,
    phone_number: provider.phoneNumber ?? null,
    is_active: provider.status !== 'offline' && provider.status !== 'failed',
    last_seen_at: provider.lastSeenAt ?? (provider.status === 'online' ? now : null),
    connected_at: provider.status === 'online' ? now : null,
    disconnected_at: provider.status === 'offline' ? now : null,
    last_error: null,
  }
}

const createSession = async (input: SessionRequest, user: User, requestId: string): Promise<SuccessResponse> => {
  const existing = await findExistingCreateConnection(input)
  if (existing) {
    const provider = normalizeProviderStatus({
      status: existing.status,
      qrcode: { base64: existing.qr_code },
      phoneNumber: existing.phone_number,
      instanceName: existing.provider_instance_id,
      lastSeenAt: existing.last_seen_at,
    }, existing.status)
    return {
      requestId,
      action: input.action,
      workspaceId: input.workspaceId,
      connection: existing,
      provider,
      idempotent: true,
    }
  }

  const connectionId = crypto.randomUUID()
  const providerInstanceId = await buildProviderInstanceId(input.workspaceId, connectionId)
  let providerCreated = false

  try {
    const createPayload = await evolutionRequest('POST', '/instance/create', {
      instanceName: providerInstanceId,
      workspaceId: input.workspaceId,
    })
    providerCreated = true
    const createProvider = normalizeProviderStatus(createPayload, 'connecting')
    const qrPayload = await evolutionRequest('GET', `/instance/connect/${encodeURIComponent(providerInstanceId)}`)
    const qrProvider = normalizeProviderStatus(qrPayload, createProvider.status)
    const provider = {
      ...createProvider,
      ...qrProvider,
      status: qrProvider.qrCode ? 'connecting' : qrProvider.status,
      providerInstanceId,
    } satisfies ProviderStatus
    const connection = await insertConnection(input, user, provider, connectionId, providerInstanceId)
    if (connection.id !== connectionId) {
      await cleanupProviderSession(providerInstanceId, requestId, input.workspaceId)
      const existingProvider = normalizeProviderStatus({
        status: connection.status,
        qrcode: { base64: connection.qr_code },
        phoneNumber: connection.phone_number,
        instanceName: connection.provider_instance_id,
        lastSeenAt: connection.last_seen_at,
      }, connection.status)
      return {
        requestId,
        action: input.action,
        workspaceId: input.workspaceId,
        connection,
        provider: existingProvider,
        idempotent: true,
      }
    }

    return {
      requestId,
      action: input.action,
      workspaceId: input.workspaceId,
      connection,
      provider,
    }
  } catch (error) {
    if (providerCreated) {
      await cleanupProviderSession(providerInstanceId, requestId, input.workspaceId)
    }
    throw error
  }
}

const qrSession = async (input: SessionRequest, requestId: string): Promise<SuccessResponse> => {
  const current = await fetchConnection(input)
  const providerInstanceId = requireProviderInstanceId(current)
  const payload = await evolutionRequest('GET', `/instance/connect/${encodeURIComponent(providerInstanceId)}`)
  const normalizedProvider = normalizeProviderStatus(payload, 'connecting')
  const provider = {
    ...normalizedProvider,
    phoneNumber: normalizedProvider.phoneNumber ?? current.phone_number ?? undefined,
    providerInstanceId,
  }
  const connection = await updateConnection(current.id, input.workspaceId, valuesForProviderStatus({
    ...provider,
    status: provider.qrCode ? 'connecting' : provider.status,
    providerInstanceId,
  }))

  return {
    requestId,
    action: input.action,
    workspaceId: input.workspaceId,
    connection,
    provider,
  }
}

const statusSession = async (input: SessionRequest, requestId: string): Promise<SuccessResponse> => {
  const current = await fetchConnection(input)
  const providerInstanceId = requireProviderInstanceId(current)
  const payload = await evolutionRequest('GET', `/instance/connectionState/${encodeURIComponent(providerInstanceId)}`)
  const normalizedProvider = normalizeProviderStatus(payload, current.status)
  const provider = {
    ...normalizedProvider,
    phoneNumber: normalizedProvider.phoneNumber ?? current.phone_number ?? undefined,
    providerInstanceId,
  }
  const connection = await updateConnection(current.id, input.workspaceId, {
    ...valuesForProviderStatus({
      ...provider,
      providerInstanceId,
    }),
    qr_code: current.qr_code,
    qr_expires_at: current.qr_expires_at,
  })

  return {
    requestId,
    action: input.action,
    workspaceId: input.workspaceId,
    connection,
    provider,
  }
}

const reconnectSession = async (input: SessionRequest, requestId: string) => qrSession({ ...input, action: 'reconnect' }, requestId)

const disconnectSession = async (input: SessionRequest, requestId: string): Promise<SuccessResponse> => {
  const current = await fetchConnection(input)
  const providerInstanceId = requireProviderInstanceId(current)
  await updateConnection(current.id, input.workspaceId, {
    status: 'disconnecting',
    is_active: false,
  })

  let alreadyDisconnected = false
  try {
    await evolutionRequest('DELETE', `/instance/logout/${encodeURIComponent(providerInstanceId)}`)
  } catch (error) {
    if (error instanceof EvolutionApiError && error.details?.providerStatus === 404) {
      alreadyDisconnected = true
    } else {
      await updateConnection(current.id, input.workspaceId, {
        status: 'failed',
        is_active: false,
        last_error: 'Evolution disconnect failed',
      })
      throw error
    }
  }

  const provider: ProviderStatus = {
    status: 'offline',
    providerInstanceId,
    rawState: alreadyDisconnected ? 'not_found' : 'offline',
  }
  const connection = await updateConnection(current.id, input.workspaceId, {
    status: 'offline',
    qr_code: null,
    qr_expires_at: null,
    is_active: false,
    disconnected_at: new Date().toISOString(),
    last_error: null,
  })

  return {
    requestId,
    action: input.action,
    workspaceId: input.workspaceId,
    connection,
    provider,
  }
}

const runAction = async (input: SessionRequest, user: User, requestId: string) => {
  if (input.action === 'create') {
    return createSession(input, user, requestId)
  }
  if (input.action === 'qr') {
    return qrSession(input, requestId)
  }
  if (input.action === 'reconnect') {
    return reconnectSession(input, requestId)
  }
  if (input.action === 'disconnect') {
    return disconnectSession(input, requestId)
  }
  return statusSession(input, requestId)
}

Deno.serve(async (request: Request) => {
  const requestId = request.headers.get('x-request-id')?.trim() || crypto.randomUUID()
  const startedAt = Date.now()

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...makeCorsHeaders(request),
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    })
  }

  if (request.method !== 'POST') {
    return jsonResponse(request, {
      requestId,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Only POST is supported',
      },
    }, 405, { Allow: 'POST, OPTIONS' })
  }

  let input: SessionRequest | null = null
  let requestHash = ''
  let idempotencyLockAcquired = false
  try {
    assertEnv()
    input = normalizeInput(await readJson(request), request)
    const user = await authenticate(request)
    await requireWorkspaceAdmin(input.workspaceId, user)
    await applyRateLimit(input, user, requestId)

    log('info', 'request_started', {
      requestId,
      action: input.action,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      sessionName: input.sessionName,
      userId: user.id,
    })

    requestHash = await sha256(stableStringify({
      action: input.action,
      workspaceId: input.workspaceId,
      sessionName: input.sessionName,
      displayName: input.displayName,
    }))

    if (input.action === 'create') {
      const idempotencyLease = await getIdempotentResponse(input, requestHash)
      idempotencyLockAcquired = idempotencyLease.lockAcquired
      if (idempotencyLease.response) {
        log('info', 'request_idempotent_replay', {
          requestId,
          action: input.action,
          workspaceId: input.workspaceId,
          connectionId: idempotencyLease.response.connection.id,
          userId: user.id,
          durationMs: Date.now() - startedAt,
        })
        return jsonResponse(request, idempotencyLease.response)
      }
    }

    const response = await runAction(input, user, requestId)
    if (input.action === 'create' && idempotencyLockAcquired) {
      await completeIdempotency(input, response, requestHash)
    }

    log('info', 'request_completed', {
      requestId,
      action: input.action,
      workspaceId: input.workspaceId,
      connectionId: response.connection.id,
      status: response.connection.status,
      userId: user.id,
      durationMs: Date.now() - startedAt,
    })

    return jsonResponse(request, response)
  } catch (error) {
    if (input) {
      await failIdempotency(input, requestId, requestHash, idempotencyLockAcquired)
    }

    const { status, body } = sanitizeError(error, requestId)
    log(status >= 500 ? 'error' : 'warn', 'request_failed', {
      requestId,
      action: input?.action,
      workspaceId: input?.workspaceId,
      errorCode: body.error.code,
      status,
      durationMs: Date.now() - startedAt,
    })

    return jsonResponse(request, body, status)
  }
})
