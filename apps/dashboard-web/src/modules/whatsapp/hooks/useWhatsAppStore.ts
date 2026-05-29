import { create } from 'zustand'
import { type WhatsAppConnection, type WhatsAppConnectionStatus } from '../types'

type WhatsAppStore = {
  connections: WhatsAppConnection[]
  selectedConnection: WhatsAppConnection | null
  loading: boolean
  qrCode: string | null
  status: WhatsAppConnectionStatus
  logs: string[]
  setConnections: (connections: WhatsAppConnection[]) => void
  upsertConnection: (connection: WhatsAppConnection) => void
  selectConnection: (connection: WhatsAppConnection | null) => void
  setLoading: (loading: boolean) => void
  setQrCode: (qrCode: string | null) => void
  setStatus: (status: WhatsAppConnectionStatus) => void
  pushLog: (log: string) => void
}

export const useWhatsAppStore = create<WhatsAppStore>((set) => ({
  connections: [],
  selectedConnection: null,
  loading: false,
  qrCode: null,
  status: 'offline',
  logs: [],
  setConnections: (connections) => set({ connections }),
  upsertConnection: (connection) =>
    set((state) => ({
      connections: [connection, ...state.connections.filter((item) => item.id !== connection.id)],
      selectedConnection: state.selectedConnection?.id === connection.id ? connection : state.selectedConnection,
      status: connection.status,
      qrCode: connection.qr_code,
    })),
  selectConnection: (connection) => set({ selectedConnection: connection }),
  setLoading: (loading) => set({ loading }),
  setQrCode: (qrCode) => set({ qrCode }),
  setStatus: (status) => set({ status }),
  pushLog: (log) => set((state) => ({ logs: [`${new Date().toISOString()} ${log}`, ...state.logs].slice(0, 50) })),
}))
