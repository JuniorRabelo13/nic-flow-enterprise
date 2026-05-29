import { metricsStore } from '../../../enterprise/analytics/metrics'

export type WhatsAppMetricName = 'messages_sent' | 'active_sessions' | 'failures' | 'reconnections' | 'uptime_seconds'

export const trackWhatsAppMetric = (name: WhatsAppMetricName, value: number, workspaceId: string) => {
  metricsStore.push({
    name: `whatsapp.${name}`,
    value,
    timestamp: new Date().toISOString(),
    dimensions: { workspaceId },
  })
}
