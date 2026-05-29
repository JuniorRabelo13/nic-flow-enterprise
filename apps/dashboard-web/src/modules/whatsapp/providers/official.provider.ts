import { monitoredFetch } from '../../../enterprise/requests/monitoredFetch'
import { sanitizePayload } from '../../../enterprise/security/sanitize'
import {
  type ConnectOfficialInput,
  type WhatsAppMessagePayload,
  type WhatsAppProviderStatus,
  type WhatsAppTemplatePayload,
} from '../types'
import { type IWhatsAppProvider } from './whatsapp-provider.interface'

export class OfficialWhatsAppProvider implements IWhatsAppProvider {
  async connectOfficialAPI(input: ConnectOfficialInput) {
    return monitoredFetch<WhatsAppProviderStatus>('/whatsapp/official/connect', {
      method: 'POST',
      body: JSON.stringify(sanitizePayload(input)),
      cachePolicy: 'network-only',
      retry: 1,
    })
  }

  async validateToken(input: Pick<ConnectOfficialInput, 'accessToken' | 'phoneNumberId' | 'businessAccountId'>) {
    return monitoredFetch<{ valid: boolean }>('/whatsapp/official/validate-token', {
      method: 'POST',
      body: JSON.stringify(sanitizePayload(input)),
      cachePolicy: 'network-only',
    })
  }

  async subscribeWebhook(connectionId: string) {
    return monitoredFetch<{ subscribed: boolean }>('/whatsapp/official/webhook/subscribe', {
      method: 'POST',
      body: JSON.stringify({ connectionId }),
      cachePolicy: 'network-only',
    })
  }

  async sendTemplate(payload: WhatsAppTemplatePayload) {
    await monitoredFetch('/whatsapp/official/messages/template', {
      method: 'POST',
      body: JSON.stringify(sanitizePayload(payload)),
      cachePolicy: 'network-only',
      retry: 2,
    })
  }

  async connect(connectionId: string) {
    return monitoredFetch<WhatsAppProviderStatus>(`/whatsapp/official/connections/${connectionId}/connect`, {
      method: 'POST',
      cachePolicy: 'network-only',
      retry: 1,
    })
  }

  async disconnect(connectionId: string) {
    await monitoredFetch(`/whatsapp/official/connections/${connectionId}/disconnect`, {
      method: 'POST',
      cachePolicy: 'network-only',
      retry: 1,
    })
  }

  async sendMessage(payload: WhatsAppMessagePayload) {
    await monitoredFetch('/whatsapp/official/messages/text', {
      method: 'POST',
      body: JSON.stringify(sanitizePayload(payload)),
      cachePolicy: 'network-only',
      retry: 2,
    })
  }

  async getStatus(connectionId: string) {
    return monitoredFetch<WhatsAppProviderStatus>(`/whatsapp/official/connections/${connectionId}/status`, {
      method: 'GET',
      cachePolicy: 'network-only',
    })
  }
}

export const officialWhatsAppProvider = new OfficialWhatsAppProvider()
