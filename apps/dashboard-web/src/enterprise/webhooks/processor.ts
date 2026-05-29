import { eventBus, type EnterpriseEvent } from '../queue/eventBus'

export type WebhookEnvelope<TPayload = unknown> = {
  id: string
  provider: 'stripe' | 'evolution' | 'internal'
  event: EnterpriseEvent<TPayload>
  signature: string
}

export const processWebhookEnvelope = async <TPayload>(envelope: WebhookEnvelope<TPayload>) => {
  if (!envelope.signature) {
    throw new Error('Webhook signature is required')
  }

  await eventBus.emit({
    ...envelope.event,
    type: `${envelope.provider}.${envelope.event.type}`,
  })
}
