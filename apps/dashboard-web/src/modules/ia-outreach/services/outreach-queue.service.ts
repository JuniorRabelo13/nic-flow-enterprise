import { logger } from '../../../enterprise/observability/logger'
import { supabase } from '../../whatsapp/services/supabase.client'
import { createOutreachDomainError, normalizeOutreachError } from './outreach-errors'
import {
  trackOutreachActionFailed,
  trackOutreachActionStarted,
  trackOutreachActionSucceeded,
} from './outreach-telemetry'
import {
  shouldAllowOutreachLocalFallback,
  throwOutreachLocalFallbackDisabled,
  throwOutreachPersistenceUnavailable,
  throwOutreachReadUnavailable,
} from './outreach-runtime'
import {
  calculateAccountWarmupProfile,
  generateIndependentSeed,
  generateNonPatternSchedule,
  registerWarmupEvent,
  shouldPauseAccount,
} from './outreach-warmup-engine'
import {
  type QueueBuildResult,
  type QueueItemInput,
  type OutreachAccount,
  type OutreachAccountCampaign,
  type OutreachMessageQueue,
  type OutreachMessageVariant,
  type OutreachRecipient,
  type WarmupProfile,
  type WarmupScheduleSlot,
} from '../types'

const outreachAccountsTable = 'whatsapp_outreach_accounts'
const outreachAccountCampaignsTable = 'outreach_account_campaigns'
const outreachMessageVariantsTable = 'outreach_message_variants'
const outreachRecipientsTable = 'outreach_recipients'
const outreachMessageQueueTable = 'outreach_message_queue'

const tableMissingErrorCodes = new Set(['42P01', 'PGRST205'])
const activeQueueStatuses: OutreachMessageQueue['status'][] = ['pending', 'scheduled', 'processing']
const blockedAccountStatuses: OutreachAccount['status'][] = ['paused', 'risk', 'blocked', 'disconnected']
const blockedCampaignStatuses: OutreachAccountCampaign['status'][] = ['paused', 'completed', 'stopped']
const recipientCandidateStatuses: OutreachRecipient['status'][] = ['queued', 'scheduled', 'contacted']
const workspaceScopeValidationMessage = 'Não foi possível validar o workspace desta operação.'
const queueBackendRequiredMessage = 'Esta operação exige persistência real disponível.'

const localQueueItems: OutreachMessageQueue[] = []

type QueueScope = {
  workspaceId: string
  accountId: string
  accountCampaignId: string
}

const nowIso = () => new Date().toISOString()

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const buildSeedHash = (input: string) =>
  input.split('').reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)

const dayIds = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const parseTimeToMinutes = (value: string | null | undefined, fallback: number) => {
  const raw = value?.slice(0, 5) ?? ''
  const [hourRaw, minuteRaw] = raw.split(':')
  const hour = Number.parseInt(hourRaw ?? '', 10)
  const minute = Number.parseInt(minuteRaw ?? '', 10)
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return fallback
  }
  return clamp(hour, 0, 23) * 60 + clamp(minute, 0, 59)
}

const isTableMissingError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const errorCode = 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  return tableMissingErrorCodes.has(errorCode)
}

const assertQueueReadAvailable = (action: string, context?: Record<string, unknown>) => {
  if (!supabase) {
    if (shouldAllowOutreachLocalFallback()) {
      return
    }
    throwOutreachReadUnavailable(action, context)
  }
}

const assertQueuePersistenceAvailable = (action: string, context?: Record<string, unknown>) => {
  if (!supabase) {
    if (shouldAllowOutreachLocalFallback()) {
      return
    }
    throwOutreachLocalFallbackDisabled(action, context)
  }
}

const handleQueueTableMissing = (action: string, context?: Record<string, unknown>) => {
  if (shouldAllowOutreachLocalFallback()) {
    return
  }
  throwOutreachPersistenceUnavailable(action, context)
}

const createQueueBackendRequiredError = (operation: string, context?: Record<string, unknown>) =>
  createOutreachDomainError('OUTREACH_BACKEND_UNAVAILABLE', queueBackendRequiredMessage, {
    operation,
    backend_required: true,
    local_fallback_allowed: shouldAllowOutreachLocalFallback(),
    ...(context ?? {}),
  })

const assertCriticalQueuePersistenceAvailable = (operation: string, context?: Record<string, unknown>) => {
  if (!supabase) {
    throw createQueueBackendRequiredError(operation, context)
  }
}

const parseDateOrNull = (value: string | null | undefined) => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const assertNonEmpty = (value: string, message: string) => {
  if (!value.trim()) {
    throw new Error(message)
  }
}

const ensureQueueScope = async (accountCampaignId: string): Promise<QueueScope | null> => {
  assertQueueReadAvailable('ensure_queue_scope', { accountCampaignId })

  if (!supabase) {
    return null
  }

  const { data: accountCampaign, error: accountCampaignError } = await supabase
    .from(outreachAccountCampaignsTable)
    .select('workspace_id, account_id')
    .eq('id', accountCampaignId)
    .maybeSingle<Pick<OutreachAccountCampaign, 'workspace_id' | 'account_id'>>()

  if (accountCampaignError) {
    if (isTableMissingError(accountCampaignError)) {
      handleQueueTableMissing('ensure_queue_scope', { accountCampaignId })
      return null
    }
    throw accountCampaignError
  }

  if (!accountCampaign) {
    return null
  }

  return {
    workspaceId: accountCampaign.workspace_id,
    accountId: accountCampaign.account_id,
    accountCampaignId,
  }
}

const resolveQueueWorkspaceScope = async (
  accountCampaignId: string,
  workspaceId?: string,
): Promise<{ workspaceId: string; scope: QueueScope | null }> => {
  const providedWorkspaceId = workspaceId?.trim()
  const scope = await ensureQueueScope(accountCampaignId)

  if (providedWorkspaceId) {
    if (scope?.workspaceId && scope.workspaceId !== providedWorkspaceId) {
      throw createOutreachDomainError('WORKSPACE_SCOPE_VIOLATION', 'A ação não pertence ao workspace atual.', {
        accountCampaignId,
        expectedWorkspaceId: providedWorkspaceId,
        resolvedWorkspaceId: scope.workspaceId,
      })
    }
    return { workspaceId: providedWorkspaceId, scope }
  }

  if (scope?.workspaceId) {
    return { workspaceId: scope.workspaceId, scope }
  }

  throw createOutreachDomainError('OUTREACH_WORKSPACE_REQUIRED', workspaceScopeValidationMessage, {
    accountCampaignId,
  })
}

const isInsideOperationalWindow = (
  account: Pick<OutreachAccount, 'start_time' | 'end_time' | 'active_days'>,
  scheduledFor: string,
) => {
  const date = parseDateOrNull(scheduledFor)
  if (!date) {
    return false
  }

  const activeDays = Array.isArray(account.active_days) && account.active_days.length > 0
    ? account.active_days
    : ['mon', 'tue', 'wed', 'thu', 'fri']
  const dayId = dayIds[date.getDay()]
  if (!activeDays.includes(dayId)) {
    return false
  }

  const minuteOfDay = date.getHours() * 60 + date.getMinutes()
  const startMinutes = parseTimeToMinutes(account.start_time, 9 * 60)
  const endMinutes = parseTimeToMinutes(account.end_time, 18 * 60)
  if (endMinutes <= startMinutes) {
    return minuteOfDay >= startMinutes || minuteOfDay <= endMinutes
  }
  return minuteOfDay >= startMinutes && minuteOfDay <= endMinutes
}

const createLocalQueueItem = (payload: QueueItemInput): OutreachMessageQueue => ({
  id: crypto.randomUUID(),
  workspace_id: payload.workspaceId,
  account_id: payload.accountId,
  account_campaign_id: payload.accountCampaignId,
  recipient_id: payload.recipientId,
  variant_id: payload.variantId ?? null,
  scheduled_for: payload.scheduledFor,
  status: payload.status ?? 'scheduled',
  attempts: 0,
  last_error: null,
  created_at: nowIso(),
  updated_at: nowIso(),
})

const fetchAccountCampaign = async (
  accountCampaignId: string,
  options: { requireRealPersistence?: boolean } = {},
) => {
  assertQueueReadAvailable('fetch_account_campaign', { accountCampaignId })

  if (!supabase) {
    if (options.requireRealPersistence) {
      throw createQueueBackendRequiredError('fetch_account_campaign', { accountCampaignId })
    }
    return null
  }

  const { data, error } = await supabase
    .from(outreachAccountCampaignsTable)
    .select('*')
    .eq('id', accountCampaignId)
    .maybeSingle<OutreachAccountCampaign>()

  if (error) {
    if (isTableMissingError(error)) {
      if (options.requireRealPersistence) {
        throw createQueueBackendRequiredError('fetch_account_campaign', { accountCampaignId })
      }
      handleQueueTableMissing('fetch_account_campaign', { accountCampaignId })
      return null
    }
    throw error
  }

  return data
}

const fetchAccount = async (
  accountId: string,
  options: { requireRealPersistence?: boolean } = {},
) => {
  assertQueueReadAvailable('fetch_account', { accountId })

  if (!supabase) {
    if (options.requireRealPersistence) {
      throw createQueueBackendRequiredError('fetch_account', { accountId })
    }
    return null
  }

  const { data, error } = await supabase
    .from(outreachAccountsTable)
    .select('*')
    .eq('id', accountId)
    .maybeSingle<OutreachAccount>()

  if (error) {
    if (isTableMissingError(error)) {
      if (options.requireRealPersistence) {
        throw createQueueBackendRequiredError('fetch_account', { accountId })
      }
      handleQueueTableMissing('fetch_account', { accountId })
      return null
    }
    throw error
  }

  return data
}

const fetchRecipientCandidates = async (
  workspaceId: string,
  accountCampaignId: string,
  options: { requireRealPersistence?: boolean } = {},
): Promise<OutreachRecipient[]> => {
  assertQueueReadAvailable('fetch_recipient_candidates', { workspaceId, accountCampaignId })

  if (!supabase) {
    if (options.requireRealPersistence) {
      throw createQueueBackendRequiredError('fetch_recipient_candidates', { workspaceId, accountCampaignId })
    }
    return []
  }

  const { data, error } = await supabase
    .from(outreachRecipientsTable)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('account_campaign_id', accountCampaignId)
    .in('status', recipientCandidateStatuses)
    .order('created_at', { ascending: true })

  if (error) {
    if (isTableMissingError(error)) {
      if (options.requireRealPersistence) {
        throw createQueueBackendRequiredError('fetch_recipient_candidates', { workspaceId, accountCampaignId })
      }
      handleQueueTableMissing('fetch_recipient_candidates', { workspaceId, accountCampaignId })
      return []
    }
    throw error
  }

  return (data ?? []) as OutreachRecipient[]
}

const fetchLastScheduledFor = async (accountCampaignId: string) => {
  const queueItems = await listQueueByAccountCampaign(accountCampaignId)
  const active = queueItems
    .filter((item) => activeQueueStatuses.includes(item.status))
    .map((item) => parseDateOrNull(item.scheduled_for))
    .filter((item): item is Date => item !== null)
    .sort((left, right) => right.getTime() - left.getTime())
  return active.length > 0 ? active[0].toISOString() : null
}

const ensureVariantIsolation = (
  variant: OutreachMessageVariant | null,
  accountCampaignId: string,
) => {
  if (!variant) {
    return
  }

  if (variant.account_campaign_id !== accountCampaignId) {
    throw new Error('Variante fora do escopo da conta+campanha.')
  }
}

const ensureRecipientIsolation = (recipient: OutreachRecipient, accountCampaignId: string) => {
  if (recipient.account_campaign_id !== accountCampaignId) {
    throw new Error('Recipient fora do escopo da conta+campanha.')
  }
}

const mapQueueSummary = (queueItems: OutreachMessageQueue[]) => {
  const summary: Record<OutreachMessageQueue['status'], number> = {
    pending: 0,
    scheduled: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  }

  for (const item of queueItems) {
    summary[item.status] += 1
  }

  return summary
}

const makeQueueBuildResult = (payload: {
  workspaceId: string
  accountId: string
  accountCampaignId: string
  totalRecipients: number
  eligibleRecipients: number
  alreadyQueued: number
  scheduled: number
  skipped: number
  failed: number
  nextScheduledFor: string | null
  message: string
  firstScheduledFor?: string | null
  lastScheduledFor?: string | null
}) => ({
  workspaceId: payload.workspaceId,
  accountId: payload.accountId,
  accountCampaignId: payload.accountCampaignId,
  totalRecipients: payload.totalRecipients,
  eligibleRecipients: payload.eligibleRecipients,
  alreadyQueued: payload.alreadyQueued,
  scheduled: payload.scheduled,
  skipped: payload.skipped,
  failed: payload.failed,
  nextScheduledFor: payload.nextScheduledFor,
  message: payload.message,
  createdCount: payload.scheduled,
  skippedCount: payload.skipped + payload.failed,
  firstScheduledFor: payload.firstScheduledFor ?? payload.nextScheduledFor,
  lastScheduledFor: payload.lastScheduledFor ?? payload.nextScheduledFor,
  note: payload.message,
})

const buildWarmupProfileSeed = (account: OutreachAccount, accountCampaign: OutreachAccountCampaign): WarmupProfile => {
  const profile = calculateAccountWarmupProfile(account)
  return {
    ...profile,
    seed: generateIndependentSeed(account.id, accountCampaign.id),
  }
}

export const getEligibleRecipients = async (accountCampaignId: string): Promise<OutreachRecipient[]> => {
  assertQueueReadAvailable('get_eligible_recipients', { accountCampaignId })

  if (!supabase) {
    return []
  }

  const scope = await ensureQueueScope(accountCampaignId)
  if (!scope) {
    return []
  }
  const { data: recipients, error } = await supabase
    .from(outreachRecipientsTable)
    .select('*')
    .eq('workspace_id', scope.workspaceId)
    .eq('account_campaign_id', accountCampaignId)
    .in('status', recipientCandidateStatuses)
    .order('created_at', { ascending: true })

  if (error) {
    if (isTableMissingError(error)) {
      handleQueueTableMissing('get_eligible_recipients', { accountCampaignId })
      return []
    }
    throw error
  }

  const activeQueue = await listQueueByAccountCampaign(accountCampaignId)
  const activeRecipientIds = new Set(
    activeQueue.filter((item) => activeQueueStatuses.includes(item.status)).map((item) => item.recipient_id),
  )

  return (recipients ?? [])
    .map((item) => item as OutreachRecipient)
    .filter((recipient) => !activeRecipientIds.has(recipient.id))
}

export const getAvailableMessageVariants = async (
  accountCampaignId: string,
  options: { requireRealPersistence?: boolean } = {},
): Promise<OutreachMessageVariant[]> => {
  assertQueueReadAvailable('get_available_message_variants', { accountCampaignId })

  if (!supabase) {
    if (options.requireRealPersistence) {
      throw createQueueBackendRequiredError('get_available_message_variants', { accountCampaignId })
    }
    return []
  }

  const scope = await ensureQueueScope(accountCampaignId)
  if (!scope) {
    return []
  }
  const { data, error } = await supabase
    .from(outreachMessageVariantsTable)
    .select('*')
    .eq('workspace_id', scope.workspaceId)
    .eq('account_campaign_id', accountCampaignId)
    .order('variant_index', { ascending: true })

  if (error) {
    if (isTableMissingError(error)) {
      if (options.requireRealPersistence) {
        throw createQueueBackendRequiredError('get_available_message_variants', { accountCampaignId })
      }
      handleQueueTableMissing('get_available_message_variants', { accountCampaignId })
      return []
    }
    throw error
  }

  return (data ?? []) as OutreachMessageVariant[]
}

export const selectVariantForRecipient = async (
  accountCampaignId: string,
  recipientId: string,
  seedScope?: string,
  availableVariants?: OutreachMessageVariant[],
): Promise<OutreachMessageVariant | null> => {
  const variants = availableVariants ?? await getAvailableMessageVariants(accountCampaignId)
  if (variants.length === 0) {
    return null
  }

  const seed = Math.abs(buildSeedHash(`${accountCampaignId}:${recipientId}:${seedScope ?? ''}`))
  const index = seed % variants.length
  return variants[index] ?? null
}

export const calculateNextScheduleSlot = async (
  accountId: string,
  accountCampaignId: string,
): Promise<WarmupScheduleSlot> => {
  const [accountCampaign, account] = await Promise.all([
    fetchAccountCampaign(accountCampaignId),
    fetchAccount(accountId),
  ])

  if (!accountCampaign || !account) {
    throw new Error('Conta ou vínculo conta+campanha indisponível para cálculo da fila estrutural.')
  }

  const warmupProfile = buildWarmupProfileSeed(account, accountCampaign)
  const lastScheduledFor = await fetchLastScheduledFor(accountCampaignId)
  const slots = generateNonPatternSchedule({
    workspaceId: account.workspace_id,
    accountId,
    accountCampaignId,
    warmupProfile,
    desiredCount: 1,
    referenceAt: lastScheduledFor ?? undefined,
    minSpacingMinutes: 7,
  })

  const slot = slots[0]
  if (!slot) {
    throw new Error('Não foi possível calcular próximo slot estrutural.')
  }
  return slot
}

export const createQueueItem = async (payload: QueueItemInput): Promise<OutreachMessageQueue> => {
  trackOutreachActionStarted({
    action: 'create_queue_item',
    workspace_id: payload.workspaceId || undefined,
    account_id: payload.accountId || undefined,
    account_campaign_id: payload.accountCampaignId || undefined,
    recipient_id: payload.recipientId || undefined,
  })

  try {
    assertQueuePersistenceAvailable('create_queue_item', {
      workspaceId: payload.workspaceId,
      accountId: payload.accountId,
      accountCampaignId: payload.accountCampaignId,
      recipientId: payload.recipientId,
    })
    assertCriticalQueuePersistenceAvailable('create_queue_item', {
      workspaceId: payload.workspaceId,
      accountId: payload.accountId,
      accountCampaignId: payload.accountCampaignId,
      recipientId: payload.recipientId,
    })

    assertNonEmpty(payload.workspaceId, 'workspace_id obrigatório para criar item de fila.')
    assertNonEmpty(payload.accountId, 'account_id obrigatório para criar item de fila.')
    assertNonEmpty(payload.accountCampaignId, 'account_campaign_id obrigatório para criar item de fila.')
    assertNonEmpty(payload.recipientId, 'recipient_id obrigatório para criar item de fila.')
    assertNonEmpty(payload.variantId ?? '', 'variant_id obrigatório para criar item de fila estrutural.')

    if (!supabase) {
      const duplicate = localQueueItems.find(
        (item) =>
          item.account_campaign_id === payload.accountCampaignId &&
          item.recipient_id === payload.recipientId &&
          activeQueueStatuses.includes(item.status),
      )
      if (duplicate) {
        trackOutreachActionSucceeded({
          action: 'create_queue_item',
          workspace_id: payload.workspaceId,
          account_id: payload.accountId,
          account_campaign_id: payload.accountCampaignId,
          recipient_id: payload.recipientId,
          queue_item_id: duplicate.id,
          safe_context: {
            deduplicated: true,
            persistence_mode: 'local_fallback',
          },
        })
        return duplicate
      }

      const localItem = createLocalQueueItem(payload)
      localQueueItems.unshift(localItem)
      trackOutreachActionSucceeded({
        action: 'create_queue_item',
        workspace_id: payload.workspaceId,
        account_id: payload.accountId,
        account_campaign_id: payload.accountCampaignId,
        recipient_id: payload.recipientId,
        queue_item_id: localItem.id,
        safe_context: {
          deduplicated: false,
          persistence_mode: 'local_fallback',
        },
      })
      return localItem
    }

    const [accountCampaign, account] = await Promise.all([
      fetchAccountCampaign(payload.accountCampaignId, { requireRealPersistence: true }),
      fetchAccount(payload.accountId, { requireRealPersistence: true }),
    ])

    if (!accountCampaign || !account) {
      throw createOutreachDomainError('INVALID_ACCOUNT_CAMPAIGN', 'Execução conta+campanha inválida para esta ação.')
    }

    if (accountCampaign.workspace_id !== payload.workspaceId || account.workspace_id !== payload.workspaceId) {
      throw createOutreachDomainError('WORKSPACE_SCOPE_VIOLATION', 'A ação não pertence ao workspace atual.')
    }

    if (accountCampaign.account_id !== payload.accountId) {
      throw new Error('Conta não pertence ao vínculo conta+campanha informado.')
    }

    if (blockedCampaignStatuses.includes(accountCampaign.status)) {
      throw new Error(`Campanha da conta em estado ${accountCampaign.status}, sem agendamento estrutural.`)
    }

    if (blockedAccountStatuses.includes(account.status)) {
      throw new Error(`Conta em estado ${account.status}, sem agendamento estrutural.`)
    }

    if (!isInsideOperationalWindow(account, payload.scheduledFor)) {
      throw new Error('Tentativa de agendamento fora da janela operacional da conta.')
    }

    const { data: recipient, error: recipientError } = await supabase
      .from(outreachRecipientsTable)
      .select('*')
      .eq('id', payload.recipientId)
      .eq('workspace_id', payload.workspaceId)
      .maybeSingle<OutreachRecipient>()

    if (recipientError) {
      if (isTableMissingError(recipientError)) {
        throw createQueueBackendRequiredError('create_queue_item_recipient_scope', {
          workspaceId: payload.workspaceId,
          accountCampaignId: payload.accountCampaignId,
        })
      }
      throw recipientError
    }

    if (!recipient) {
      throw new Error('Recipient não encontrado para criação de fila.')
    }
    ensureRecipientIsolation(recipient, payload.accountCampaignId)

    let variant: OutreachMessageVariant | null = null
    if (payload.variantId) {
      const { data: selectedVariant, error: variantError } = await supabase
        .from(outreachMessageVariantsTable)
        .select('*')
        .eq('id', payload.variantId)
        .eq('workspace_id', payload.workspaceId)
        .maybeSingle<OutreachMessageVariant>()

      if (variantError) {
        if (isTableMissingError(variantError)) {
          throw createQueueBackendRequiredError('create_queue_item_variant_scope', {
            workspaceId: payload.workspaceId,
            accountCampaignId: payload.accountCampaignId,
          })
        }
        throw variantError
      }
      variant = selectedVariant ?? null
      if (!variant) {
        throw new Error('Variante não encontrada no escopo da execução.')
      }
      ensureVariantIsolation(variant, payload.accountCampaignId)
    }

    const { data: duplicate, error: duplicateError } = await supabase
      .from(outreachMessageQueueTable)
      .select('*')
      .eq('workspace_id', payload.workspaceId)
      .eq('account_campaign_id', payload.accountCampaignId)
      .eq('recipient_id', payload.recipientId)
      .in('status', activeQueueStatuses)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<OutreachMessageQueue>()

    if (duplicateError && !isTableMissingError(duplicateError)) {
      throw duplicateError
    }
    if (duplicate) {
      trackOutreachActionSucceeded({
        action: 'create_queue_item',
        workspace_id: payload.workspaceId,
        account_id: payload.accountId,
        account_campaign_id: payload.accountCampaignId,
        recipient_id: payload.recipientId,
        queue_item_id: duplicate.id,
        safe_context: {
          deduplicated: true,
          persistence_mode: 'supabase',
        },
      })
      return duplicate
    }

    const row = {
      workspace_id: payload.workspaceId,
      account_id: payload.accountId,
      account_campaign_id: payload.accountCampaignId,
      recipient_id: payload.recipientId,
      variant_id: variant?.id ?? null,
      scheduled_for: payload.scheduledFor,
      status: payload.status ?? 'scheduled',
    }

    const { data: created, error: createError } = await supabase.from(outreachMessageQueueTable).insert(row).select('*').single()
    if (createError) {
      if (isTableMissingError(createError)) {
        throw createQueueBackendRequiredError('create_queue_item_persistence', {
          workspaceId: payload.workspaceId,
          accountCampaignId: payload.accountCampaignId,
        })
      }
      const normalizedError = normalizeOutreachError(createError, 'DUPLICATE_ACTIVE_QUEUE_ITEM')
      throw normalizedError
    }

    const queueItem = created as OutreachMessageQueue
    trackOutreachActionSucceeded({
      action: 'create_queue_item',
      workspace_id: queueItem.workspace_id,
      account_id: queueItem.account_id,
      account_campaign_id: queueItem.account_campaign_id,
      recipient_id: queueItem.recipient_id,
      queue_item_id: queueItem.id,
      safe_context: {
        deduplicated: false,
        persistence_mode: 'supabase',
      },
    })
    return queueItem
  } catch (error) {
    trackOutreachActionFailed({
      action: 'create_queue_item',
      error,
      workspace_id: payload.workspaceId || undefined,
      account_id: payload.accountId || undefined,
      account_campaign_id: payload.accountCampaignId || undefined,
      recipient_id: payload.recipientId || undefined,
      safe_context: {
        backend_required: true,
        local_fallback_allowed: shouldAllowOutreachLocalFallback(),
        operation: 'create_queue_item',
      },
    })
    throw error
  }
}

export const listQueueByAccount = async (accountId: string): Promise<OutreachMessageQueue[]> => {
  trackOutreachActionStarted({
    action: 'list_queue',
    account_id: accountId,
  })

  try {
    assertQueueReadAvailable('list_queue_by_account', { accountId })

    if (!supabase) {
      const localRows = localQueueItems.filter((item) => item.account_id === accountId)
      trackOutreachActionSucceeded({
        action: 'list_queue',
        account_id: accountId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachMessageQueueTable)
      .select('*')
      .eq('account_id', accountId)
      .order('scheduled_for', { ascending: true, nullsFirst: false })

    if (error) {
      if (isTableMissingError(error)) {
        handleQueueTableMissing('list_queue_by_account', { accountId })
        const localRows = localQueueItems.filter((item) => item.account_id === accountId)
        trackOutreachActionSucceeded({
          action: 'list_queue',
          account_id: accountId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_local_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachMessageQueue[]
    trackOutreachActionSucceeded({
      action: 'list_queue',
      account_id: accountId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_queue',
      error,
      account_id: accountId,
    })
    throw error
  }
}

export const listQueueByAccounts = async (accountIds: string[]): Promise<Record<string, OutreachMessageQueue[]>> => {
  const uniqueIds = [...new Set(accountIds.map((id) => id.trim()).filter((id) => id.length > 0))]
  const emptyMap: Record<string, OutreachMessageQueue[]> = {}
  for (const accountId of uniqueIds) {
    emptyMap[accountId] = []
  }

  trackOutreachActionStarted({
    action: 'list_queue',
    safe_context: {
      account_count: uniqueIds.length,
      batch_mode: true,
    },
  })

  try {
    if (uniqueIds.length === 0) {
      trackOutreachActionSucceeded({
        action: 'list_queue',
        safe_context: {
          account_count: 0,
          queue_items_count: 0,
          batch_mode: true,
        },
      })
      return emptyMap
    }

    assertQueueReadAvailable('list_queue_by_accounts', { accountCount: uniqueIds.length })

    let rows: OutreachMessageQueue[] = []
    let source: 'supabase' | 'local_fallback' | 'table_missing_local_fallback' = 'supabase'

    if (!supabase) {
      rows = localQueueItems.filter((item) => uniqueIds.includes(item.account_id))
      source = 'local_fallback'
    } else {
      const { data, error } = await supabase
        .from(outreachMessageQueueTable)
        .select('*')
        .in('account_id', uniqueIds)
        .order('scheduled_for', { ascending: true, nullsFirst: false })

      if (error) {
        if (isTableMissingError(error)) {
          handleQueueTableMissing('list_queue_by_accounts', { accountCount: uniqueIds.length })
          rows = localQueueItems.filter((item) => uniqueIds.includes(item.account_id))
          source = 'table_missing_local_fallback'
        } else {
          throw error
        }
      } else {
        rows = (data ?? []) as OutreachMessageQueue[]
      }
    }

    const grouped: Record<string, OutreachMessageQueue[]> = {}
    for (const accountId of uniqueIds) {
      grouped[accountId] = []
    }
    for (const row of rows) {
      if (!grouped[row.account_id]) {
        grouped[row.account_id] = []
      }
      grouped[row.account_id].push(row)
    }

    for (const accountId of Object.keys(grouped)) {
      grouped[accountId].sort((left, right) => (left.scheduled_for ?? '').localeCompare(right.scheduled_for ?? ''))
    }

    trackOutreachActionSucceeded({
      action: 'list_queue',
      safe_context: {
        account_count: uniqueIds.length,
        queue_items_count: rows.length,
        batch_mode: true,
        source,
      },
    })

    return grouped
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_queue',
      error,
      safe_context: {
        account_count: uniqueIds.length,
        batch_mode: true,
      },
    })
    throw error
  }
}

export const listQueueByAccountCampaign = async (accountCampaignId: string): Promise<OutreachMessageQueue[]> => {
  trackOutreachActionStarted({
    action: 'list_queue',
    account_campaign_id: accountCampaignId,
  })

  try {
    assertQueueReadAvailable('list_queue_by_account_campaign', { accountCampaignId })

    if (!supabase) {
      const localRows = localQueueItems.filter((item) => item.account_campaign_id === accountCampaignId)
      trackOutreachActionSucceeded({
        action: 'list_queue',
        account_campaign_id: accountCampaignId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachMessageQueueTable)
      .select('*')
      .eq('account_campaign_id', accountCampaignId)
      .order('scheduled_for', { ascending: true, nullsFirst: false })

    if (error) {
      if (isTableMissingError(error)) {
        handleQueueTableMissing('list_queue_by_account_campaign', { accountCampaignId })
        const localRows = localQueueItems.filter((item) => item.account_campaign_id === accountCampaignId)
        trackOutreachActionSucceeded({
          action: 'list_queue',
          account_campaign_id: accountCampaignId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_local_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachMessageQueue[]
    trackOutreachActionSucceeded({
      action: 'list_queue',
      account_campaign_id: accountCampaignId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_queue',
      error,
      account_campaign_id: accountCampaignId,
    })
    throw error
  }
}

export const cancelPendingQueueForAccountCampaign = async (
  accountCampaignId: string,
  workspaceId?: string,
): Promise<number> => {
  try {
    assertQueuePersistenceAvailable('cancel_pending_queue_for_account_campaign', { accountCampaignId, workspaceId: workspaceId ?? null })
    assertCriticalQueuePersistenceAvailable('cancel_pending_queue_for_account_campaign', {
      accountCampaignId,
      workspaceId: workspaceId ?? null,
    })

    const scoped = await resolveQueueWorkspaceScope(accountCampaignId, workspaceId)

    if (!supabase) {
      let affected = 0
      for (const item of localQueueItems) {
        if (
          item.workspace_id === scoped.workspaceId &&
          item.account_campaign_id === accountCampaignId &&
          (item.status === 'pending' || item.status === 'scheduled')
        ) {
          item.status = 'cancelled'
          item.updated_at = nowIso()
          affected += 1
        }
      }
      return affected
    }

    const { data, error } = await supabase
      .from(outreachMessageQueueTable)
      .update({ status: 'cancelled' })
      .eq('workspace_id', scoped.workspaceId)
      .eq('account_campaign_id', accountCampaignId)
      .in('status', ['pending', 'scheduled'])
      .select('id')

    if (error) {
      if (isTableMissingError(error)) {
        throw createQueueBackendRequiredError('cancel_pending_queue_for_account_campaign', {
          accountCampaignId,
          workspaceId: scoped.workspaceId,
        })
      }
      throw error
    }

    return (data ?? []).length
  } catch (error) {
    trackOutreachActionFailed({
      action: 'cancel_queue',
      error,
      workspace_id: workspaceId,
      account_campaign_id: accountCampaignId,
      safe_context: {
        backend_required: true,
        local_fallback_allowed: shouldAllowOutreachLocalFallback(),
        operation: 'cancel_pending_queue_for_account_campaign',
        has_workspace: Boolean(workspaceId?.trim()),
      },
    })
    throw error
  }
}

export const buildAccountCampaignQueue = async (accountCampaignId: string): Promise<QueueBuildResult> => {
  trackOutreachActionStarted({
    action: 'generate_queue',
    account_campaign_id: accountCampaignId,
    safe_context: {
      source: 'build_account_campaign_queue',
    },
  })

  const completeQueueBuild = (result: QueueBuildResult): QueueBuildResult => {
    trackOutreachActionSucceeded({
      action: 'generate_queue',
      workspace_id: result.workspaceId || undefined,
      account_id: result.accountId || undefined,
      account_campaign_id: result.accountCampaignId || undefined,
      safe_context: {
        source: 'build_account_campaign_queue',
        total_recipients: result.totalRecipients,
        eligible_recipients: result.eligibleRecipients,
        already_queued: result.alreadyQueued,
        scheduled: result.scheduled,
        skipped: result.skipped,
        failed: result.failed,
      },
    })
    return result
  }

  try {
    assertQueuePersistenceAvailable('build_account_campaign_queue', { accountCampaignId })
    assertCriticalQueuePersistenceAvailable('build_account_campaign_queue', { accountCampaignId })

    const accountCampaign = await fetchAccountCampaign(accountCampaignId, { requireRealPersistence: true })
  if (!accountCampaign) {
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: '',
      accountId: '',
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: 'Vínculo conta+campanha não encontrado. Fila estrutural não criada.',
    }))
  }

  if (!accountCampaign.workspace_id || !accountCampaign.account_id || !accountCampaign.id) {
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: accountCampaign.workspace_id ?? '',
      accountId: accountCampaign.account_id ?? '',
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: 'Escopo obrigatório da execução está incompleto para gerar fila.',
    }))
  }

  const account = await fetchAccount(accountCampaign.account_id, { requireRealPersistence: true })
  if (!account) {
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: accountCampaign.workspace_id,
      accountId: accountCampaign.account_id,
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: 'Conta não encontrada. Fila estrutural não criada.',
    }))
  }

  if (blockedCampaignStatuses.includes(accountCampaign.status)) {
    await registerWarmupEvent({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      eventType: 'system_pause',
      eventPayload: { reason: `account_campaign_status_${accountCampaign.status}` },
    })
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: `Vínculo em estado ${accountCampaign.status}; sem preparação de fila.`,
    }))
  }

  if (blockedAccountStatuses.includes(account.status)) {
    await registerWarmupEvent({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      eventType: 'system_pause',
      eventPayload: { reason: `account_status_${account.status}` },
    })
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: `Conta em estado ${account.status}; sem geração de fila estrutural.`,
    }))
  }

  const pauseDecision = shouldPauseAccount(account)
  if (pauseDecision.pauseRecommended) {
    await registerWarmupEvent({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      eventType: 'system_pause',
      eventPayload: { reason: pauseDecision.reason },
    })
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: pauseDecision.reason ?? 'Aquecimento pausado para esta conta.',
    }))
  }

  const variants = await getAvailableMessageVariants(accountCampaignId, { requireRealPersistence: true })
  if (variants.length === 0) {
    await registerWarmupEvent({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      eventType: 'system_pause',
      eventPayload: { reason: 'no_variants_available_for_execution' },
    })
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: 'Execução sem variações disponíveis. Fila estrutural não foi gerada.',
    }))
  }

  const recipientCandidates = await fetchRecipientCandidates(account.workspace_id, accountCampaignId, { requireRealPersistence: true })
  const totalRecipients = recipientCandidates.length
  if (totalRecipients === 0) {
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients: 0,
      eligibleRecipients: 0,
      alreadyQueued: 0,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: 'Sem destinatários elegíveis para esta execução.',
    }))
  }

  const existingQueue = await listQueueByAccountCampaign(accountCampaignId)
  const activeQueueItems = existingQueue.filter((item) => activeQueueStatuses.includes(item.status))
  const activeRecipientIds = new Set(activeQueueItems.map((item) => item.recipient_id))
  const eligibleRecipients = recipientCandidates.filter((recipient) => !activeRecipientIds.has(recipient.id))
  const alreadyQueued = totalRecipients - eligibleRecipients.length
  if (eligibleRecipients.length === 0) {
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients,
      eligibleRecipients: 0,
      alreadyQueued,
      scheduled: 0,
      skipped: 0,
      failed: 0,
      nextScheduledFor: null,
      message: 'Todos os destinatários elegíveis já possuem item ativo na fila.',
    }))
  }

  const warmupProfile = buildWarmupProfileSeed(account, accountCampaign)
  const activeCount = activeQueueItems.length
  const availableCapacity = Math.max(0, warmupProfile.dailyLimit - activeCount)
  const desiredCount = Math.min(eligibleRecipients.length, availableCapacity)
  if (desiredCount <= 0) {
    return completeQueueBuild(makeQueueBuildResult({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      totalRecipients,
      eligibleRecipients: eligibleRecipients.length,
      alreadyQueued,
      scheduled: 0,
      skipped: eligibleRecipients.length,
      failed: 0,
      nextScheduledFor: null,
      message: 'Capacidade diária já preenchida para esta execução nesta etapa estrutural.',
    }))
  }
  const lastScheduledFor = await fetchLastScheduledFor(accountCampaignId)
  const slots = generateNonPatternSchedule({
    workspaceId: account.workspace_id,
    accountId: account.id,
    accountCampaignId,
    warmupProfile,
    desiredCount,
    referenceAt: lastScheduledFor ?? undefined,
    minSpacingMinutes: 7,
  })

  let createdCount = 0
  let skippedCount = 0
  let failedCount = 0
  const scheduledDates: string[] = []
  const firstWarmup = existingQueue.length === 0

  if (firstWarmup) {
    await registerWarmupEvent({
      workspaceId: account.workspace_id,
      accountId: account.id,
      accountCampaignId,
      eventType: 'warmup_started',
      eventPayload: {
        seed: warmupProfile.seed,
        hourlyRange: warmupProfile.hourlyRange,
        dailyLimit: warmupProfile.dailyLimit,
      },
    })
  }

  for (let index = 0; index < desiredCount; index += 1) {
    const recipient = eligibleRecipients[index]
    const slot = slots[index]
    if (!recipient || !slot) {
      skippedCount += 1
      await registerWarmupEvent({
        workspaceId: account.workspace_id,
        accountId: account.id,
        accountCampaignId,
        eventType: 'message_skipped',
        eventPayload: { reason: 'missing_recipient_or_slot', slotIndex: index },
      })
      continue
    }

    try {
      ensureRecipientIsolation(recipient, accountCampaignId)
      const variant = await selectVariantForRecipient(
        accountCampaignId,
        recipient.id,
        `${slot.slotIndex}:${slot.jitterMinutes}:${warmupProfile.seed}`,
        variants,
      )
      if (!variant) {
        failedCount += 1
        await registerWarmupEvent({
          workspaceId: account.workspace_id,
          accountId: account.id,
          accountCampaignId,
          eventType: 'message_skipped',
          eventPayload: {
            recipientId: recipient.id,
            reason: 'variant_not_found_for_execution',
          },
        })
        continue
      }
      const created = await createQueueItem({
        workspaceId: account.workspace_id,
        accountId: account.id,
        accountCampaignId,
        recipientId: recipient.id,
        variantId: variant.id,
        scheduledFor: slot.scheduledFor,
        status: 'scheduled',
      })
      createdCount += 1
      scheduledDates.push(created.scheduled_for ?? slot.scheduledFor)
      await registerWarmupEvent({
        workspaceId: account.workspace_id,
        accountId: account.id,
        accountCampaignId,
        eventType: 'message_scheduled',
        eventPayload: {
          queueId: created.id,
          recipientId: created.recipient_id,
          slotIndex: slot.slotIndex,
        },
      })
    } catch (error) {
      const normalizedError = normalizeOutreachError(error)
      if (normalizedError.code === 'DUPLICATE_ACTIVE_QUEUE_ITEM') {
        skippedCount += 1
      } else {
        failedCount += 1
      }
      await registerWarmupEvent({
        workspaceId: account.workspace_id,
        accountId: account.id,
        accountCampaignId,
        eventType: 'message_skipped',
        eventPayload: {
          recipientId: recipient.id,
          reason: normalizedError.message,
        },
      })
    }
  }

  const overflowSkipped = Math.max(0, eligibleRecipients.length - desiredCount)
  if (overflowSkipped > 0) {
    const overflowRecipients = eligibleRecipients.slice(desiredCount)
    for (const recipient of overflowRecipients) {
      await registerWarmupEvent({
        workspaceId: account.workspace_id,
        accountId: account.id,
        accountCampaignId,
        eventType: 'message_skipped',
        eventPayload: {
          recipientId: recipient.id,
          reason: 'capacity_exceeded_for_current_window',
        },
      })
    }
  }
  skippedCount += overflowSkipped

  const sortedScheduled = scheduledDates
    .map((value) => parseDateOrNull(value))
    .filter((value): value is Date => value !== null)
    .sort((left, right) => left.getTime() - right.getTime())

  const nextScheduledFor = sortedScheduled[0]?.toISOString() ?? null
  const result: QueueBuildResult = makeQueueBuildResult({
    workspaceId: account.workspace_id,
    accountId: account.id,
    accountCampaignId,
    totalRecipients,
    eligibleRecipients: eligibleRecipients.length,
    alreadyQueued,
    scheduled: createdCount,
    skipped: skippedCount,
    failed: failedCount,
    nextScheduledFor,
    message: 'Fila estrutural preparada. Nenhuma mensagem real é enviada nesta etapa.',
    firstScheduledFor: nextScheduledFor,
    lastScheduledFor: sortedScheduled[sortedScheduled.length - 1]?.toISOString() ?? null,
  })

  logger.info('ia_outreach_queue_build', {
    workspaceId: result.workspaceId,
    accountId: result.accountId,
    accountCampaignId: result.accountCampaignId,
    totalRecipients: result.totalRecipients,
    eligibleRecipients: result.eligibleRecipients,
    alreadyQueued: result.alreadyQueued,
    scheduled: result.scheduled,
    skipped: result.skipped,
    failed: result.failed,
    queueSummary: mapQueueSummary(await listQueueByAccountCampaign(accountCampaignId)),
    mode: 'structural_only',
  })

    return completeQueueBuild(result)
  } catch (error) {
    trackOutreachActionFailed({
      action: 'generate_queue',
      error,
      account_campaign_id: accountCampaignId,
      safe_context: {
        backend_required: true,
        local_fallback_allowed: shouldAllowOutreachLocalFallback(),
        operation: 'build_account_campaign_queue',
        source: 'build_account_campaign_queue',
      },
    })
    throw error
  }
}

export const scheduleNextMessagesForAccount = async (accountId: string): Promise<QueueBuildResult[]> => {
  trackOutreachActionStarted({
    action: 'generate_queue',
    account_id: accountId,
    safe_context: {
      operation: 'schedule_next_messages_for_account',
    },
  })

  try {
    assertQueuePersistenceAvailable('schedule_next_messages_for_account', { accountId })
    assertCriticalQueuePersistenceAvailable('schedule_next_messages_for_account', { accountId })

    const account = await fetchAccount(accountId, { requireRealPersistence: true })
    if (!account) {
      trackOutreachActionSucceeded({
        action: 'generate_queue',
        account_id: accountId,
        safe_context: {
          operation: 'schedule_next_messages_for_account',
          execution_count: 0,
          skipped_reason: 'account_not_found',
        },
      })
      return []
    }

    const supabaseClient = supabase
    if (!supabaseClient) {
      throw createQueueBackendRequiredError('schedule_next_messages_for_account', { accountId })
    }

    const { data: accountCampaigns, error } = await supabaseClient
      .from(outreachAccountCampaignsTable)
      .select('*')
      .eq('workspace_id', account.workspace_id)
      .eq('account_id', accountId)
      .in('status', ['draft', 'active'])
      .order('created_at', { ascending: true })

    if (error) {
      if (isTableMissingError(error)) {
        throw createQueueBackendRequiredError('schedule_next_messages_for_account', {
          accountId,
          workspaceId: account.workspace_id,
        })
      }
      throw error
    }

    const result: QueueBuildResult[] = []
    for (const item of (accountCampaigns ?? []) as OutreachAccountCampaign[]) {
      const prepared = await buildAccountCampaignQueue(item.id)
      result.push(prepared)
    }

    trackOutreachActionSucceeded({
      action: 'generate_queue',
      account_id: accountId,
      workspace_id: account.workspace_id,
      safe_context: {
        operation: 'schedule_next_messages_for_account',
        execution_count: result.length,
      },
    })

    return result
  } catch (error) {
    trackOutreachActionFailed({
      action: 'generate_queue',
      error,
      account_id: accountId,
      safe_context: {
        backend_required: true,
        local_fallback_allowed: shouldAllowOutreachLocalFallback(),
        operation: 'schedule_next_messages_for_account',
      },
    })
    throw error
  }
}
