export enum WhatsAppProviderType {
  OFFICIAL = 'official',
  QR_SESSION = 'qr_session',
}

export type WhatsAppConnectionStatus = 'pending' | 'connecting' | 'online' | 'offline' | 'failed' | 'disconnecting'

export type WhatsAppConnection = {
  id: string
  workspace_id: string
  provider_type: WhatsAppProviderType
  session_name: string
  phone_number: string | null
  status: WhatsAppConnectionStatus
  qr_code: string | null
  official_phone_number_id: string | null
  official_business_account_id: string | null
  webhook_secret: string | null
  is_active: boolean
  last_seen_at: string | null
  created_at: string
}

export type WhatsAppMessagePayload = {
  connectionId: string
  to: string
  message: string
  workspaceId: string
}

export type WhatsAppTemplatePayload = {
  connectionId: string
  to: string
  templateName: string
  language: string
  workspaceId: string
  components?: unknown[]
}

export type CreateQrSessionInput = {
  workspaceId: string
  sessionName: string
}

export type ConnectOfficialInput = {
  workspaceId: string
  sessionName: string
  accessToken: string
  phoneNumberId: string
  businessAccountId: string
}

export type WhatsAppProviderStatus = {
  status: WhatsAppConnectionStatus
  phoneNumber?: string
  qrCode?: string
  lastSeenAt?: string
}
