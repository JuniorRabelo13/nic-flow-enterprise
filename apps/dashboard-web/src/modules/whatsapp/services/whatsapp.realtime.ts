import { logger } from '../../../enterprise/observability/logger'
import { type WhatsAppConnection } from '../types'
import { supabase } from './supabase.client'

export const subscribeToWhatsAppConnections = (
  workspaceId: string,
  onConnectionChange: (connection: WhatsAppConnection) => void,
  onLog?: (message: string) => void,
) => {
  if (!supabase) {
    logger.warn('whatsapp_realtime_disabled', { reason: 'missing_supabase_config' })
    return () => undefined
  }

  const client = supabase
  const channel = client
    .channel(`whatsapp_connections:${workspaceId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'whatsapp_connections', filter: `workspace_id=eq.${workspaceId}` },
      (payload) => {
        onLog?.(`whatsapp_connection_${payload.eventType.toLowerCase()}`)
        if (payload.new) {
          onConnectionChange(payload.new as WhatsAppConnection)
        }
      },
    )
    .subscribe((status) => onLog?.(`realtime_${status.toLowerCase()}`))

  return () => {
    void client.removeChannel(channel)
  }
}
