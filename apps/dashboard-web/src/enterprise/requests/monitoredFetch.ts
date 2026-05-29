import { enterpriseEnv } from '../config/env'
import { getCsrfToken } from '../security/csrf'
import { getSessionFingerprint } from '../security/fingerprint'
import { requestRateLimiter } from '../security/rateLimit'
import { sanitizePayload } from '../security/sanitize'
import { resourceCache } from '../performance/resourceCache'
import { logger } from '../observability/logger'
import { sentry } from '../observability/sentry'

type CachePolicy = 'network-only' | 'cache-first' | 'stale-while-revalidate'

type MonitoredRequestInit = RequestInit & {
  cachePolicy?: CachePolicy
  retry?: number
}

const resolveUrl = (input: string | URL) => {
  const raw = String(input)
  return raw.startsWith('http') ? raw : `${enterpriseEnv.apiBaseUrl}${raw}`
}

const requestKey = (url: string, init: RequestInit) => `${init.method ?? 'GET'}:${url}:${init.body ?? ''}`

const prepareBody = (body: BodyInit | null | undefined) => {
  if (typeof body !== 'string') {
    return body
  }

  try {
    return JSON.stringify(sanitizePayload(JSON.parse(body)))
  } catch {
    return sanitizePayload(body)
  }
}

const parseResponse = async <T>(response: Response): Promise<T> => {
  if (response.status === 204) {
    return undefined as T
  }

  const contentType = response.headers.get('Content-Type') ?? ''
  const text = await response.text()
  if (!text) {
    return undefined as T
  }

  if (contentType.includes('application/json')) {
    return JSON.parse(text) as T
  }

  return text as T
}

export const monitoredFetch = async <T = unknown>(input: string | URL, init: MonitoredRequestInit = {}): Promise<T> => {
  const url = resolveUrl(input)
  const method = init.method ?? 'GET'
  const key = requestKey(url, init)
  const pathname = new URL(url, window.location.origin).pathname

  if (!requestRateLimiter.consume(`${method}:${pathname}`)) {
    throw new Error('Rate limit exceeded')
  }

  if (method === 'GET' && init.cachePolicy !== 'network-only') {
    const cached = resourceCache.get<T>(key)
    if (cached && init.cachePolicy === 'cache-first') {
      return cached
    }
  }

  const headers = new Headers(init.headers)
  headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json')
  headers.set('X-CSRF-Token', getCsrfToken())
  headers.set('X-Session-Fingerprint', await getSessionFingerprint())
  headers.set('X-Request-Source', 'dashboard-web')

  const startedAt = performance.now()
  try {
    const response = await fetch(url, {
      ...init,
      method,
      headers,
      body: prepareBody(init.body),
      credentials: 'include',
    })
    const durationMs = Math.round(performance.now() - startedAt)
    logger.info('http_request', { path: pathname, method, status: response.status, durationMs })

    if (!response.ok) {
      const errorBody = await parseResponse<unknown>(response).catch(() => undefined)
      throw new Error(`Request failed with status ${response.status}${errorBody ? `: ${JSON.stringify(errorBody)}` : ''}`)
    }

    const data = await parseResponse<T>(response)
    if (method === 'GET') {
      resourceCache.set(key, data)
    }
    return data
  } catch (error) {
    sentry.captureException(error, { url, method })
    const retries = init.retry ?? 0
    if (retries > 0) {
      return monitoredFetch<T>(input, { ...init, retry: retries - 1 })
    }
    throw error
  }
}
