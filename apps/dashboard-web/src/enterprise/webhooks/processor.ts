import { eventBus, type EnterpriseEvent } from '../queue/eventBus'

export type WebhookEnvelope<TPayload = unknown> = {
  id: string
  provider: 'stripe' | 'evolution' | 'internal'
  event: EnterpriseEvent<TPayload>
  signature: string
}

export const processWebhookEnvelope = async <TPayload>(envelope: WebhookEnvelope<TPayload>) => {
  await eventBus.emit({
    ...envelope.event,
    type: `${envelope.provider}.${envelope.event.type}`,
  })
}
