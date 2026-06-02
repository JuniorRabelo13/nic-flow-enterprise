import { enterpriseEnv } from '../../../enterprise/config/env'
import { logger } from '../../../enterprise/observability/logger'
import { bruteForceRateLimiter } from '../../../enterprise/security/rateLimit'
import { sanitizePayload } from '../../../enterprise/security/sanitize'
import { officialWhatsAppProvider } from '../providers/official.provider'
import {
  type ConnectOfficialInput,
  type CreateQrSessionInput,
  type WhatsAppConnection,
  type WhatsAppMessagePayload,
  type WhatsAppProviderStatus,
  WhatsAppProviderType,
} from '../types'
import { requireSupabaseAuth, supabase, supabasePreviewConfigErrorMessage } from './supabase.client'

type SessionAction = 'create' | 'qr' | 'reconnect' | 'disconnect' | 'status'

type EdgeSessionResponse = {
  requestId: string
  action: SessionAction
  workspaceId: string
  connection: WhatsAppConnection
  provider: WhatsAppProviderStatus & {
    providerInstanceId?: string
    rawState?: string
  }
  idempotent?: boolean
}

const table = 'whatsapp_sessions'
const edgeFunctionName = 'whatsapp-evolution-session'

const validateWorkspace = (workspaceId: string) => {
  if (!workspaceId || !/^[a-zA-Z0-9_-]{3,80}$/.test(workspaceId)) {
    throw new Error('Invalid workspace_id')
  }
}

const requireEdgeSessionFeature = () => {
  if (!enterpriseEnv.whatsappEdgeSessionFeatureEnabled) {
    throw new Error('QR session via Edge Function está desabilitada. Defina VITE_FEATURE_WHATSAPP_EDGE_SESSION=true para habilitar.')
  }
}

const invokeQrSessionAction = async (
  action: SessionAction,
  payload: {
    workspaceId: string
    connectionId?: string
    sessionName?: string
    displayName?: string
  },
) => {
  requireEdgeSessionFeature()
  const client = requireSupabaseAuth()
  const { data: sessionData, error: sessionError } = await client.auth.getSession()
  if (sessionError || !sessionData.session?.access_token) {
    throw new Error('Authenticated Supabase session is required')
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${sessionData.session.access_token}`,
  }

  if (action === 'create' && payload.sessionName) {
    headers['x-idempotency-key'] = `create:${payload.workspaceId}:${payload.sessionName}`
  }

  const { data, error } = await client.functions.invoke<EdgeSessionResponse>(edgeFunctionName, {
    body: sanitizePayload({ action, ...payload }),
    headers,
  })

  if (error) {
    throw error
  }
  if (!data?.connection || !data?.provider) {
    throw new Error('Edge Function returned an invalid response')
  }

  return data
}

export const whatsappService = {
  async listConnections(workspaceId: string) {
    validateWorkspace(workspaceId)
    if (!supabase) {
      return []
    }

    const { data, error } = await supabase
      .from(table)
      .select('id, workspace_id, provider_type, session_name, display_name, phone_number, status, qr_code, provider_instance_id, is_active, last_seen_at, qr_expires_at, connected_at, disconnected_at, last_error, created_at, updated_at, deleted_at')
      .eq('workspace_id', workspaceId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    return (data ?? []) as WhatsAppConnection[]
  },

  async createQrSession(input: CreateQrSessionInput) {
    validateWorkspace(input.workspaceId)
    const sessionName = input.sessionName.trim()
    if (!sessionName) {
      throw new Error('Session name is required')
    }

    const response = await invokeQrSessionAction('create', {
      workspaceId: input.workspaceId,
      sessionName,
      displayName: sessionName,
    })

    return response.provider
  },

  async connectOfficial(input: ConnectOfficialInput) {
    validateWorkspace(input.workspaceId)
    if (!input.sessionName.trim() || !input.accessToken.trim() || !input.phoneNumberId.trim() || !input.businessAccountId.trim()) {
      throw new Error('Official WhatsApp connection data is incomplete')
    }

    if (!bruteForceRateLimiter.consume(`official:${input.workspaceId}`)) {
      throw new Error('Too many official API connection attempts')
    }

    const result = await officialWhatsAppProvider.connectOfficialAPI(input)
    logger.info('whatsapp_official_connect_requested', {
      workspaceId: input.workspaceId,
      phoneNumberId: input.phoneNumberId,
      businessAccountId: input.businessAccountId,
    })
    return result
  },

  async sendMessage(payload: WhatsAppMessagePayload) {
    validateWorkspace(payload.workspaceId)
    const connection = await this.getConnection(payload.connectionId, payload.workspaceId)
    if (connection.provider_type === WhatsAppProviderType.QR_SESSION) {
      throw new Error('QR session messaging requires server-side function whatsapp-evolution-message.')
    }

    await officialWhatsAppProvider.sendMessage(payload)
  },

  async disconnect(connection: WhatsAppConnection) {
    if (connection.provider_type === WhatsAppProviderType.QR_SESSION) {
      await invokeQrSessionAction('disconnect', {
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        sessionName: connection.session_name,
      })
      return
    }

    await officialWhatsAppProvider.disconnect(connection.id)
    if (supabase) {
      const { error } = await supabase
        .from(table)
        .update({ status: 'offline', is_active: false })
        .eq('id', connection.id)
        .eq('workspace_id', connection.workspace_id)
      if (error) {
        throw error
      }
    }
  },

  async reconnect(connection: WhatsAppConnection) {
    if (connection.provider_type === WhatsAppProviderType.QR_SESSION) {
      const response = await invokeQrSessionAction('reconnect', {
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        sessionName: connection.session_name,
      })
      return response.provider
    }

    const status = await officialWhatsAppProvider.connect(connection.id)
    if (supabase) {
      const { error } = await supabase
        .from(table)
        .update({ status: status.status, qr_code: status.qrCode ?? null, is_active: true })
        .eq('id', connection.id)
        .eq('workspace_id', connection.workspace_id)
      if (error) {
        throw error
      }
    }
    return status
  },

  async getConnection(connectionId: string, workspaceId: string) {
    validateWorkspace(workspaceId)
    if (!supabase) {
      throw new Error(supabasePreviewConfigErrorMessage)
    }

    const { data, error } = await supabase.from(table).select('*').eq('id', connectionId).eq('workspace_id', workspaceId).single()
    if (error) {
      throw error
    }

    return data as WhatsAppConnection
  },
}
