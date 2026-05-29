import { useEffect } from 'react'
import { whatsappService } from '../services/whatsapp.service'
import { subscribeToWhatsAppConnections } from '../services/whatsapp.realtime'
import { useWhatsAppStore } from './useWhatsAppStore'

export const useWhatsAppConnections = (workspaceId: string) => {
  const store = useWhatsAppStore()
  const setLoading = useWhatsAppStore((state) => state.setLoading)
  const setConnections = useWhatsAppStore((state) => state.setConnections)
  const upsertConnection = useWhatsAppStore((state) => state.upsertConnection)
  const pushLog = useWhatsAppStore((state) => state.pushLog)

  useEffect(() => {
    let mounted = true
    setLoading(true)

    whatsappService
      .listConnections(workspaceId)
      .then((connections) => {
        if (mounted) {
          setConnections(connections)
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false)
        }
      })

    const unsubscribe = subscribeToWhatsAppConnections(workspaceId, upsertConnection, pushLog)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [pushLog, setConnections, setLoading, upsertConnection, workspaceId])

  return store
}
