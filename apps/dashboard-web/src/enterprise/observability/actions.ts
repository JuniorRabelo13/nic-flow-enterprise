import { monitoredFetch } from '../requests/monitoredFetch'
import { logger } from './logger'
import { sentry } from './sentry'

export type ActionTracker = {
  name: string
  workspaceId?: string
  metadata?: Record<string, unknown>
}

export const trackAction = async (action: ActionTracker) => {
  logger.info('user_action', action)
  try {
    await monitoredFetch('/observability/actions', {
      method: 'POST',
      body: JSON.stringify(action),
      cachePolicy: 'network-only',
    })
  } catch (error) {
    sentry.captureException(error, { action })
  }
}
