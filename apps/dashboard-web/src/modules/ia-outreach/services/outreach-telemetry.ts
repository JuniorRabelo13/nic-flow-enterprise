import { enterpriseEnv } from '../../../enterprise/config/env'
import { logger } from '../../../enterprise/observability/logger'
import { type OutreachErrorCode } from '../types'
import { extractOutreachErrorTelemetry } from './outreach-errors'

export type OutreachTelemetryLevel = 'info' | 'warn' | 'error'

export type OutreachTelemetryAction =
  | 'create_campaign'
  | 'create_account_campaign'
  | 'persist_variants'
  | 'add_recipient'
  | 'bulk_add_recipients'
  | 'generate_queue'
  | 'create_queue_item'
  | 'list_accounts'
  | 'list_campaigns'
  | 'list_campaign_executions'
  | 'list_message_variants'
  | 'list_recipients'
  | 'list_queue'
  | 'list_conversations'
  | 'calculate_warmup_window'
  | 'load_warmup_suggestions'
  | 'load_ia_outreach_page_data'
  | 'toggle_account_status'
  | 'update_account'
  | 'remove_recipient'
  | 'update_recipient_status'
  | 'cancel_queue'

export type OutreachTelemetryPayload = {
  module?: 'ia-outreach'
  action: OutreachTelemetryAction
  level?: OutreachTelemetryLevel
  error_code?: OutreachErrorCode
  constraint?: string | null
  message?: string
  workspace_id?: string
  account_id?: string
  account_campaign_id?: string
  campaign_id?: string
  recipient_id?: string
  queue_item_id?: string
  timestamp?: string
  environment?: string
  safe_context?: Record<string, unknown>
}

type TrackActionFailureInput = Omit<
  OutreachTelemetryPayload,
  'level' | 'error_code' | 'constraint' | 'message' | 'timestamp' | 'environment'
> & {
  error: unknown
  fallbackCode?: OutreachErrorCode
}

const basePhonePattern = /\D/g

export const maskPhoneNumber = (phoneNumber: string | null | undefined): string | null => {
  if (typeof phoneNumber !== 'string') {
    return null
  }

  const digitsOnly = phoneNumber.replace(basePhonePattern, '')
  if (!digitsOnly) {
    return null
  }

  if (digitsOnly.length <= 5) {
    const prefix = digitsOnly.slice(0, 1)
    const suffix = digitsOnly.slice(-1)
    return `${prefix}${'*'.repeat(Math.max(1, digitsOnly.length - 2))}${suffix}`
  }

  const prefix = digitsOnly.slice(0, 2)
  const suffix = digitsOnly.slice(-3)
  return `${prefix}*****${suffix}`
}

const safeContextDepthLimit = 3

const toSafeString = (value: unknown, maxLength = 180): string => {
  if (typeof value !== 'string') {
    return ''
  }
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`
}

const shouldMaskPhoneKey = (key: string) => /phone|telefone|msisdn/i.test(key)

const sanitizeSafeContext = (value: unknown, depth = 0): unknown => {
  if (depth > safeContextDepthLimit) {
    return '[max_depth]'
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    return toSafeString(value)
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return { count: value.length }
  }

  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const sanitizedEntries = entries.map(([key, item]) => {
      if (shouldMaskPhoneKey(key)) {
        const masked = maskPhoneNumber(typeof item === 'string' ? item : null)
        return [key, masked ?? '[masked]'] as const
      }
      return [key, sanitizeSafeContext(item, depth + 1)] as const
    })
    return Object.fromEntries(sanitizedEntries)
  }

  return '[unsupported]'
}

const buildTelemetryPayload = (payload: OutreachTelemetryPayload): OutreachTelemetryPayload => ({
  module: 'ia-outreach',
  timestamp: new Date().toISOString(),
  environment: enterpriseEnv.appEnv,
  ...payload,
  safe_context: payload.safe_context ? (sanitizeSafeContext(payload.safe_context) as Record<string, unknown>) : undefined,
})

const logStructuredTelemetry = (payload: OutreachTelemetryPayload) => {
  const built = buildTelemetryPayload(payload)
  const level = built.level ?? 'info'

  if (level === 'error') {
    logger.error('ia_outreach_telemetry', built)
    return
  }

  if (level === 'warn') {
    logger.warn('ia_outreach_telemetry', built)
    return
  }

  logger.info('ia_outreach_telemetry', built)
}

export const trackOutreachActionStarted = (payload: Omit<OutreachTelemetryPayload, 'level'>) => {
  logStructuredTelemetry({
    ...payload,
    level: 'info',
    message: payload.message ?? 'action_started',
  })
}

export const trackOutreachActionSucceeded = (payload: Omit<OutreachTelemetryPayload, 'level'>) => {
  logStructuredTelemetry({
    ...payload,
    level: 'info',
    message: payload.message ?? 'action_succeeded',
  })
}

export const trackOutreachDomainError = (payload: Omit<OutreachTelemetryPayload, 'level'>) => {
  logStructuredTelemetry({
    ...payload,
    level: 'warn',
    message: payload.message ?? 'domain_error',
  })
}

export const trackOutreachActionFailed = (params: TrackActionFailureInput) => {
  const metadata = extractOutreachErrorTelemetry(params.error, params.fallbackCode)
  const payload: OutreachTelemetryPayload = {
    ...params,
    error_code: metadata.code,
    constraint: metadata.constraint,
    message: metadata.safeMessage,
  }

  if (metadata.code !== 'UNKNOWN_OUTREACH_ERROR') {
    trackOutreachDomainError(payload)
    return
  }

  logStructuredTelemetry({
    ...payload,
    level: 'error',
  })
}
