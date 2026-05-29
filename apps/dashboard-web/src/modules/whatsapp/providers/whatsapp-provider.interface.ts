import { type WhatsAppMessagePayload, type WhatsAppProviderStatus } from '../types'

export interface IWhatsAppProvider {
  connect(connectionId: string): Promise<WhatsAppProviderStatus>
  disconnect(connectionId: string): Promise<void>
  sendMessage(payload: WhatsAppMessagePayload): Promise<void>
  getStatus(connectionId: string): Promise<WhatsAppProviderStatus>
}
