import { logger } from './observability/logger'
import { sentry } from './observability/sentry'

let initialized = false

export const initializeEnterpriseRuntime = () => {
  if (initialized) {
    return
  }

  initialized = true

  window.addEventListener('error', (event) => {
    sentry.captureException(event.error, { source: event.filename, line: event.lineno })
  })

  window.addEventListener('unhandledrejection', (event) => {
    sentry.captureException(event.reason, { source: 'unhandledrejection' })
  })

  logger.info('enterprise_runtime_initialized')
}

export * from './analytics/client'
export * from './billing/plans'
export * from './billing/stripe'
export * from './crm/client'
export * from './queue/eventBus'
export * from './queue/jobQueue'
export * from './requests/monitoredFetch'
export * from './security/headers'
export * from './webhooks/processor'
