import { monitoredFetch } from '../../../enterprise/requests/monitoredFetch'
import { sanitizePayload } from '../../../enterprise/security/sanitize'
import { type IWhatsAppProvider } from './whatsapp-provider.interface'
import { type CreateQrSessionInput, type WhatsAppMessagePayload, type WhatsAppProviderStatus } from '../types'

const evolutionApiUrl = import.meta.env.VITE_EVOLUTION_API_URL ?? import.meta.env.VITE_EVOLUTION_API_BASE_URL
const evolutionApiKey = import.meta.env.VITE_EVOLUTION_API_KEY

const evolutionUrl = (path: string) => {
  if (!evolutionApiUrl) {
    throw new Error('VITE_EVOLUTION_API_URL is not configured')
  }

  return `${evolutionApiUrl}${path}`
}

const headers = () => ({
  apikey: evolutionApiKey ?? '',
})

export class EvolutionProvider implements IWhatsAppProvider {
  async createSession(input: CreateQrSessionInput) {
    return monitoredFetch<WhatsAppProviderStatus>(evolutionUrl('/instance/create'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(sanitizePayload({ instanceName: input.sessionName, workspaceId: input.workspaceId })),
      cachePolicy: 'network-only',
      retry: 2,
    })
  }

  async getQRCode(sessionName: string) {
    return monitoredFetch<WhatsAppProviderStatus>(evolutionUrl(`/instance/connect/${encodeURIComponent(sessionName)}`), {
      method: 'GET',
      headers: headers(),
      cachePolicy: 'network-only',
      retry: 2,
    })
  }

  async checkStatus(sessionName: string) {
    return this.getStatus(sessionName)
  }

  async connect(sessionName: string) {
    return this.getQRCode(sessionName)
  }

  async disconnect(sessionName: string) {
    await monitoredFetch(evolutionUrl(`/instance/logout/${encodeURIComponent(sessionName)}`), {
      method: 'DELETE',
      headers: headers(),
      cachePolicy: 'network-only',
      retry: 1,
    })
  }

  async sendMessage(payload: WhatsAppMessagePayload) {
    await monitoredFetch(evolutionUrl(`/message/sendText/${encodeURIComponent(payload.connectionId)}`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(sanitizePayload({ number: payload.to, text: payload.message, workspaceId: payload.workspaceId })),
      cachePolicy: 'network-only',
      retry: 2,
    })
  }

  async getStatus(sessionName: string) {
    return monitoredFetch<WhatsAppProviderStatus>(evolutionUrl(`/instance/connectionState/${encodeURIComponent(sessionName)}`), {
      method: 'GET',
      headers: headers(),
      cachePolicy: 'network-only',
      retry: 1,
    })
  }
}

export const evolutionProvider = new EvolutionProvider()
