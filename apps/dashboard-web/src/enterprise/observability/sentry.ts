import { enterpriseEnv } from '../config/env'
import { logger } from './logger'

type SentryEvent = {
  exception?: { values: Array<{ type: string; value: string; stacktrace?: string }> }
  message?: string
  level: 'error' | 'warning' | 'info'
  platform: 'javascript'
  release: string
  environment: string
  tags?: Record<string, string>
  extra?: Record<string, unknown>
}

const sentryEnvelopeEndpoint = (dsn: string) => {
  const url = new URL(dsn)
  const projectId = url.pathname.replace('/', '')
  return `${url.protocol}//${url.host}/api/${projectId}/envelope/`
}

const postToSentry = (event: SentryEvent) => {
  if (!enterpriseEnv.sentryDsn || Math.random() > enterpriseEnv.sentrySampleRate) {
    return
  }

  const dsn = new URL(enterpriseEnv.sentryDsn)
  const header = JSON.stringify({ dsn: enterpriseEnv.sentryDsn, sent_at: new Date().toISOString() })
  const item = JSON.stringify({ type: 'event' })
  const body = `${header}\n${item}\n${JSON.stringify(event)}`

  navigator.sendBeacon?.(sentryEnvelopeEndpoint(enterpriseEnv.sentryDsn), new Blob([body], { type: 'application/x-sentry-envelope' })) ||
    fetch(sentryEnvelopeEndpoint(enterpriseEnv.sentryDsn), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_key=${dsn.username}` },
      body,
      keepalive: true,
    }).catch((error: unknown) => logger.warn('sentry_delivery_failed', { error }))
}

export const sentry = {
  captureException(error: unknown, extra?: Record<string, unknown>) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    postToSentry({
      level: 'error',
      platform: 'javascript',
      release: enterpriseEnv.appVersion,
      environment: enterpriseEnv.appEnv,
      exception: {
        values: [{ type: normalized.name, value: normalized.message, stacktrace: normalized.stack }],
      },
      extra,
    })
  },
  captureMessage(message: string, level: SentryEvent['level'] = 'info', extra?: Record<string, unknown>) {
    postToSentry({
      message,
      level,
      platform: 'javascript',
      release: enterpriseEnv.appVersion,
      environment: enterpriseEnv.appEnv,
      extra,
    })
  },
}
