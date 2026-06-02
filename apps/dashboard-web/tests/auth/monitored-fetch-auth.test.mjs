import assert from 'node:assert/strict'
import { test } from 'node:test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const monitoredFetchPath = path.resolve(__dirname, '../../src/enterprise/requests/monitoredFetch.ts')

const loadMonitoredFetch = async ({ supabaseClient, fetchImpl }) => loadTsModule(monitoredFetchPath, {
  '../config/env': {
    enterpriseEnv: {
      apiBaseUrl: '/api',
      appEnv: 'test',
      appVersion: 'test',
      whatsappEdgeSessionFeatureEnabled: false,
      sentrySampleRate: 0,
    },
  },
  '../security/csrf': {
    getCsrfToken: () => 'csrf-token',
  },
  '../security/fingerprint': {
    getSessionFingerprint: async () => 'fingerprint-token',
  },
  '../security/rateLimit': {
    requestRateLimiter: { consume: () => true },
  },
  '../security/sanitize': {
    sanitizePayload: (value) => value,
  },
  '../performance/resourceCache': {
    resourceCache: {
      get: () => null,
      set: () => undefined,
    },
  },
  '../observability/logger': {
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  },
  '../observability/sentry': {
    sentry: {
      captureException: () => undefined,
    },
  },
  '../../modules/whatsapp/services/supabase.client': {
    supabase: supabaseClient,
  },
}, {
  fetch: fetchImpl,
  Headers,
  Response,
  URL,
  window: { location: { origin: 'https://dashboard.test' } },
  performance: { now: () => 1 },
})

const makeJsonResponse = (body = { ok: true }) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

test('monitoredFetch adds Supabase bearer token when authenticated session exists', async () => {
  let capturedHeaders
  const { monitoredFetch } = await loadMonitoredFetch({
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'jwt-token' } }, error: null }),
      },
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers
      return makeJsonResponse()
    },
  })

  await monitoredFetch('/billing/usage', { method: 'POST', body: JSON.stringify({ metric: 'ai_tokens' }) })

  assert.equal(capturedHeaders.get('Authorization'), 'Bearer jwt-token')
  assert.equal(capturedHeaders.get('X-CSRF-Token'), 'csrf-token')
  assert.equal(capturedHeaders.get('X-Session-Fingerprint'), 'fingerprint-token')
})

test('monitoredFetch preserves explicit Authorization header from caller', async () => {
  let capturedHeaders
  const { monitoredFetch } = await loadMonitoredFetch({
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'jwt-token' } }, error: null }),
      },
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers
      return makeJsonResponse()
    },
  })

  await monitoredFetch('/external', {
    method: 'POST',
    headers: { Authorization: 'Bearer caller-token', 'X-Custom-Header': 'kept' },
  })

  assert.equal(capturedHeaders.get('Authorization'), 'Bearer caller-token')
  assert.equal(capturedHeaders.get('X-Custom-Header'), 'kept')
})

test('monitoredFetch does not add Authorization when no session exists', async () => {
  let capturedHeaders
  const { monitoredFetch } = await loadMonitoredFetch({
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
      },
    },
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers
      return makeJsonResponse()
    },
  })

  await monitoredFetch('/public/health', { method: 'GET', cachePolicy: 'network-only' })

  assert.equal(capturedHeaders.has('Authorization'), false)
})

test('monitoredFetch continues without Authorization when Supabase client is unavailable', async () => {
  let capturedHeaders
  const { monitoredFetch } = await loadMonitoredFetch({
    supabaseClient: null,
    fetchImpl: async (_url, init) => {
      capturedHeaders = init.headers
      return makeJsonResponse()
    },
  })

  await monitoredFetch('/public/health', { method: 'GET', cachePolicy: 'network-only' })

  assert.equal(capturedHeaders.has('Authorization'), false)
  assert.equal(capturedHeaders.get('Content-Type'), 'application/json')
})
