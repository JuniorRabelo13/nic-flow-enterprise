import { logger } from '../../../enterprise/observability/logger'
import { bruteForceRateLimiter } from '../../../enterprise/security/rateLimit'
import { sanitizePayload } from '../../../enterprise/security/sanitize'
import { evolutionProvider } from '../providers/evolution.provider'
import { officialWhatsAppProvider } from '../providers/official.provider'
import { type IWhatsAppProvider } from '../providers/whatsapp-provider.interface'
import {
  type ConnectOfficialInput,
  type CreateQrSessionInput,
  type WhatsAppConnection,
  type WhatsAppMessagePayload,
  WhatsAppProviderType,
} from '../types'
import { supabase } from './supabase.client'

const table = 'whatsapp_connections'

const providerByType: Record<WhatsAppProviderType, IWhatsAppProvider> = {
  [WhatsAppProviderType.OFFICIAL]: officialWhatsAppProvider,
  [WhatsAppProviderType.QR_SESSION]: evolutionProvider,
}

const validateWorkspace = (workspaceId: string) => {
  if (!workspaceId || !/^[a-zA-Z0-9_-]{3,80}$/.test(workspaceId)) {
    throw new Error('Invalid workspace_id')
  }
}

export const whatsappService = {
  async listConnections(workspaceId: string) {
    validateWorkspace(workspaceId)
    if (!supabase) {
      return []
    }

    const { data, error } = await supabase
      .from(table)
      .select('id, workspace_id, provider_type, session_name, phone_number, status, qr_code, official_phone_number_id, official_business_account_id, is_active, last_seen_at, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    return (data ?? []).map((connection) => ({ ...connection, webhook_secret: null })) as WhatsAppConnection[]
  },

  async createQrSession(input: CreateQrSessionInput) {
    validateWorkspace(input.workspaceId)
    if (!input.sessionName.trim()) {
      throw new Error('Session name is required')
    }

    const safeInput = sanitizePayload(input)
    const status = await evolutionProvider.createSession(safeInput)
    const qrStatus = await evolutionProvider.getQRCode(safeInput.sessionName)

    if (!supabase) {
      return { ...status, qrCode: qrStatus.qrCode }
    }

    const { error } = await supabase.from(table).insert({
      workspace_id: safeInput.workspaceId,
      provider_type: WhatsAppProviderType.QR_SESSION,
      session_name: safeInput.sessionName,
      status: qrStatus.status,
      qr_code: qrStatus.qrCode ?? null,
      is_active: true,
    })

    if (error) {
      throw error
    }

    return { ...status, qrCode: qrStatus.qrCode }
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
    const provider = providerByType[connection.provider_type]
    await provider.sendMessage(payload)
  },

  async disconnect(connection: WhatsAppConnection) {
    const provider = providerByType[connection.provider_type]
    await provider.disconnect(connection.session_name)
    if (supabase) {
      const { error } = await supabase.from(table).update({ status: 'offline', is_active: false }).eq('id', connection.id).eq('workspace_id', connection.workspace_id)
      if (error) {
        throw error
      }
    }
  },

  async reconnect(connection: WhatsAppConnection) {
    const provider = providerByType[connection.provider_type]
    const status = await provider.connect(connection.session_name)
    if (supabase) {
      const { error } = await supabase.from(table).update({ status: status.status, qr_code: status.qrCode ?? null, is_active: true }).eq('id', connection.id).eq('workspace_id', connection.workspace_id)
      if (error) {
        throw error
      }
    }
    return status
  },

  async getConnection(connectionId: string, workspaceId: string) {
    validateWorkspace(workspaceId)
    if (!supabase) {
      throw new Error('Supabase is not configured')
    }

    const { data, error } = await supabase.from(table).select('*').eq('id', connectionId).eq('workspace_id', workspaceId).single()
    if (error) {
      throw error
    }

    return data as WhatsAppConnection
  },
}
