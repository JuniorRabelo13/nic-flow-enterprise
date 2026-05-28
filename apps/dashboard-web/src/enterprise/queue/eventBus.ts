export type EnterpriseEvent<TPayload = unknown> = {
  type: string
  workspaceId?: string
  payload: TPayload
  occurredAt: string
}

type Handler<TPayload> = (event: EnterpriseEvent<TPayload>) => void | Promise<void>

class EventBus {
  private handlers = new Map<string, Set<Handler<unknown>>>()

  on<TPayload>(type: string, handler: Handler<TPayload>) {
    const handlers = this.handlers.get(type) ?? new Set()
    handlers.add(handler as Handler<unknown>)
    this.handlers.set(type, handlers)
    return () => handlers.delete(handler as Handler<unknown>)
  }

  async emit<TPayload>(event: EnterpriseEvent<TPayload>) {
    const handlers = this.handlers.get(event.type) ?? new Set()
    await Promise.all(Array.from(handlers).map((handler) => handler(event as EnterpriseEvent<unknown>)))
  }
}

export const eventBus = new EventBus()
