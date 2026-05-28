import { enterpriseEnv } from '../config/env'
import { monitoredFetch } from '../requests/monitoredFetch'

export type WhatsAppSession = {
  id: string
  workspaceId: string
  status: 'connecting' | 'open' | 'closed' | 'reconnecting'
}

export type QrLifecycle = {
  sessionId: string
  qrCode: string
  expiresAt: string
}

const evolutionUrl = (path: string) => {
  if (!enterpriseEnv.evolutionApiBaseUrl) {
    throw new Error('Evolution API base URL is not configured')
  }

  return `${enterpriseEnv.evolutionApiBaseUrl}${path}`
}

const authHeaders = () => ({
  apikey: enterpriseEnv.evolutionApiKey ?? '',
})

export const evolutionClient = {
  createSession(workspaceId: string, sessionId: string) {
    return monitoredFetch<WhatsAppSession>(evolutionUrl('/instance/create'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ instanceName: sessionId, workspaceId }),
      cachePolicy: 'network-only',
    })
  },
  getQrCode(sessionId: string) {
    return monitoredFetch<QrLifecycle>(evolutionUrl(`/instance/connect/${sessionId}`), {
      method: 'GET',
      headers: authHeaders(),
      cachePolicy: 'network-only',
    })
  },
  reconnect(sessionId: string) {
    return monitoredFetch<WhatsAppSession>(evolutionUrl(`/instance/restart/${sessionId}`), {
      method: 'PUT',
      headers: authHeaders(),
      cachePolicy: 'network-only',
      retry: 3,
    })
  },
  syncWebhook(sessionId: string, webhookUrl: string) {
    return monitoredFetch(evolutionUrl(`/webhook/set/${sessionId}`), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url: webhookUrl, webhook_by_events: true }),
      cachePolicy: 'network-only',
    })
  },
}
