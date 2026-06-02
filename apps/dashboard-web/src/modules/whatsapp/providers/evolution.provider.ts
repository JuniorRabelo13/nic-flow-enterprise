import { type IWhatsAppProvider } from './whatsapp-provider.interface'
import { type CreateQrSessionInput, type WhatsAppMessagePayload, type WhatsAppProviderStatus } from '../types'

const directBrowserEvolutionError = () =>
  new Error('Direct Evolution API calls from browser are disabled. Use Edge Function whatsapp-evolution-session.')

export class EvolutionProvider implements IWhatsAppProvider {
  async createSession(input: CreateQrSessionInput) {
    void input
    throw directBrowserEvolutionError()
  }

  async getQRCode(sessionName: string) {
    void sessionName
    throw directBrowserEvolutionError()
  }

  async checkStatus(sessionName: string) {
    void sessionName
    throw directBrowserEvolutionError()
  }

  async connect(sessionName: string): Promise<WhatsAppProviderStatus> {
    void sessionName
    throw directBrowserEvolutionError()
  }

  async disconnect(sessionName: string) {
    void sessionName
    throw directBrowserEvolutionError()
  }

  async sendMessage(payload: WhatsAppMessagePayload) {
    void payload
    throw directBrowserEvolutionError()
  }

  async getStatus(sessionName: string): Promise<WhatsAppProviderStatus> {
    void sessionName
    throw directBrowserEvolutionError()
  }
}

export const evolutionProvider = new EvolutionProvider()
