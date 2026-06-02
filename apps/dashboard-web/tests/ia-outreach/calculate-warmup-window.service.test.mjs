import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const servicePath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/services/outreach.service.ts',
)

test('calculateWarmupWindow normalizes failures and tracks telemetry on read error', async () => {
  const telemetryCalls = {
    started: [],
    succeeded: [],
    failed: [],
  }

  const normalizedError = {
    name: 'OutreachDomainError',
    code: 'OUTREACH_BACKEND_UNAVAILABLE',
    message: 'Esta ação exige conexão real com o backend.',
  }

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    '../../whatsapp/services/supabase.client': {
      supabase: null,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': {
      createOutreachDomainError: (code, message, details) => ({
        name: 'OutreachDomainError',
        code,
        message,
        details,
      }),
      isOutreachDomainError: (error) =>
        Boolean(error && typeof error === 'object' && 'code' in error),
      normalizeOutreachError: () => normalizedError,
    },
    './outreach-telemetry': {
      maskPhoneNumber: (phoneNumber) => phoneNumber,
      trackOutreachActionStarted: (payload) => telemetryCalls.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetryCalls.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetryCalls.failed.push(payload),
    },
    './outreach-runtime': {
      shouldAllowOutreachLocalFallback: () => false,
      throwOutreachBackendUnavailable: () => {
        throw new Error('Esta ação exige conexão real com o backend.')
      },
      throwOutreachLocalFallbackDisabled: () => {
        throw new Error('O fallback local está desativado neste ambiente.')
      },
      throwOutreachPersistenceUnavailable: () => {
        throw new Error('A persistência do módulo não está disponível.')
      },
      throwOutreachReadUnavailable: () => {
        throw new Error('A leitura do módulo exige conexão real com o backend.')
      },
    },
    './outreach-warmup-engine': {
      calculateAccountWarmupProfile: () => ({
        hourlyRange: { min: 1, max: 2 },
        dailyLimit: 10,
        pauseRecommended: false,
      }),
      buildWarmupProfileSnapshot: () => ({}),
      evaluateWarmupState: () => ({}),
      shouldPauseAccount: () => ({ pauseRecommended: false, reason: null }),
      planWarmupSchedule: () => [],
      generateIndependentSeed: () => 'seed',
      generateNonPatternSchedule: () => [],
      registerWarmupEvent: async () => undefined,
      getWarmupStateFlags: () => ({}),
      formatWarmupEventLabel: () => 'ok',
      resolveWarmupRiskLevel: () => 'low',
    },
  })

  const { calculateWarmupWindow } = serviceModule

  await assert.rejects(
    async () => {
      await calculateWarmupWindow('acc-123')
    },
    (error) => {
      assert.equal(error.code, 'OUTREACH_BACKEND_UNAVAILABLE')
      assert.equal(error.message, 'Esta ação exige conexão real com o backend.')
      return true
    },
  )

  assert.equal(telemetryCalls.started.length, 1)
  assert.equal(telemetryCalls.started[0].action, 'calculate_warmup_window')
  assert.equal(telemetryCalls.started[0].account_id, 'acc-123')

  assert.equal(telemetryCalls.succeeded.length, 0)
  assert.equal(telemetryCalls.failed.length, 1)
  assert.equal(telemetryCalls.failed[0].action, 'calculate_warmup_window')
  assert.equal(telemetryCalls.failed[0].account_id, 'acc-123')
  assert.equal(telemetryCalls.failed[0].error.code, 'OUTREACH_BACKEND_UNAVAILABLE')

  const failurePayload = JSON.stringify(telemetryCalls.failed[0])
  assert.doesNotMatch(failurePayload, /61999990000/)
  assert.doesNotMatch(failurePayload, /token|secret|apikey|api_key/i)
})
