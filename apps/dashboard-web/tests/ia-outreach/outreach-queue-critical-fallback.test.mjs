import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const queueServicePath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/services/outreach-queue.service.ts',
)

const createOutreachErrorStubs = () => ({
  createOutreachDomainError: (code, message, details) => ({
    name: 'OutreachDomainError',
    code,
    message,
    details,
  }),
  normalizeOutreachError: (error) => {
    if (error && typeof error === 'object' && 'code' in error) {
      return error
    }
    return {
      name: 'OutreachDomainError',
      code: 'UNKNOWN_OUTREACH_ERROR',
      message: error instanceof Error ? error.message : 'Erro desconhecido',
    }
  },
})

const createRuntimeStubs = () => ({
  shouldAllowOutreachLocalFallback: () => true,
  throwOutreachLocalFallbackDisabled: (action, context) => {
    throw new Error(`local_fallback_disabled:${action}:${JSON.stringify(context ?? {})}`)
  },
  throwOutreachPersistenceUnavailable: (action, context) => {
    throw new Error(`persistence_unavailable:${action}:${JSON.stringify(context ?? {})}`)
  },
  throwOutreachReadUnavailable: (action, context) => {
    throw new Error(`read_unavailable:${action}:${JSON.stringify(context ?? {})}`)
  },
})

const createWarmupEngineStubs = () => ({
  calculateAccountWarmupProfile: () => ({
    workspaceId: 'ws_test',
    accountId: 'acc_test',
    seed: 'seed',
    timezone: 'America/Sao_Paulo',
    activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    windowStartTime: '09:00',
    windowEndTime: '18:00',
    hourlyRange: { min: 1, max: 2 },
    dailyLimit: 10,
    warmupLevel: 1,
    pauseRecommended: false,
    reason: null,
  }),
  generateIndependentSeed: () => 'seed',
  generateNonPatternSchedule: () => [],
  registerWarmupEvent: async () => undefined,
  shouldPauseAccount: () => ({ pauseRecommended: false, reason: null }),
})

const createLoggerStub = () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
})

test('buildAccountCampaignQueue fails fast with controlled error when backend persistence is unavailable', async () => {
  const telemetry = {
    started: [],
    succeeded: [],
    failed: [],
  }

  const queueModule = await loadTsModule(queueServicePath, {
    '../../../enterprise/observability/logger': createLoggerStub(),
    '../../whatsapp/services/supabase.client': {
      supabase: null,
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  await assert.rejects(
    async () => {
      await queueModule.buildAccountCampaignQueue('ac_critical')
    },
    (error) => {
      assert.equal(error.code, 'OUTREACH_BACKEND_UNAVAILABLE')
      assert.equal(error.message, 'Esta operação exige persistência real disponível.')
      return true
    },
  )

  assert.equal(telemetry.failed.length, 1)
  assert.equal(telemetry.failed[0].action, 'generate_queue')
  assert.equal(telemetry.failed[0].safe_context.backend_required, true)
  assert.equal(telemetry.failed[0].safe_context.local_fallback_allowed, true)
  assert.equal(telemetry.failed[0].safe_context.operation, 'build_account_campaign_queue')
})

test('createQueueItem does not return fake success without real persistence', async () => {
  const telemetry = {
    started: [],
    succeeded: [],
    failed: [],
  }

  const queueModule = await loadTsModule(queueServicePath, {
    '../../../enterprise/observability/logger': createLoggerStub(),
    '../../whatsapp/services/supabase.client': {
      supabase: null,
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  await assert.rejects(
    async () => {
      await queueModule.createQueueItem({
        workspaceId: 'ws_test',
        accountId: 'acc_test',
        accountCampaignId: 'ac_test',
        recipientId: 'rec_test',
        variantId: 'var_test',
        scheduledFor: '2026-06-01T12:00:00.000Z',
        status: 'scheduled',
      })
    },
    (error) => {
      assert.equal(error.code, 'OUTREACH_BACKEND_UNAVAILABLE')
      assert.equal(error.message, 'Esta operação exige persistência real disponível.')
      return true
    },
  )

  assert.equal(telemetry.started.length, 1)
  assert.equal(telemetry.succeeded.length, 0)
  assert.equal(telemetry.failed.length, 1)
  assert.equal(telemetry.failed[0].action, 'create_queue_item')
  assert.equal(telemetry.failed[0].safe_context.backend_required, true)
  assert.equal(telemetry.failed[0].safe_context.local_fallback_allowed, true)
  assert.equal(telemetry.failed[0].safe_context.operation, 'create_queue_item')
})

test('listQueueByAccounts keeps safe local-read behavior under local fallback', async () => {
  const telemetry = {
    started: [],
    succeeded: [],
    failed: [],
  }

  const queueModule = await loadTsModule(queueServicePath, {
    '../../../enterprise/observability/logger': createLoggerStub(),
    '../../whatsapp/services/supabase.client': {
      supabase: null,
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const grouped = await queueModule.listQueueByAccounts(['acc_1', 'acc_2'])
  const normalizedGrouped = JSON.parse(JSON.stringify(grouped))

  assert.deepStrictEqual(normalizedGrouped, {
    acc_1: [],
    acc_2: [],
  })
  assert.equal(telemetry.failed.length, 0)
  assert.ok(telemetry.succeeded.some((event) => event.action === 'list_queue'))
  assert.ok(telemetry.succeeded.some((event) => event.safe_context?.source === 'local_fallback'))
})
