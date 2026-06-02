import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const servicePath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/services/outreach.service.ts',
)

const createRuntimeStubs = () => ({
  shouldAllowOutreachLocalFallback: () => false,
  throwOutreachBackendUnavailable: (action, context) => {
    throw new Error(`backend_unavailable:${action}:${JSON.stringify(context ?? {})}`)
  },
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

const createOutreachErrorStubs = () => ({
  createOutreachDomainError: (code, message, details) => ({
    name: 'OutreachDomainError',
    code,
    message,
    details,
  }),
  isOutreachDomainError: (error) =>
    Boolean(error && typeof error === 'object' && 'code' in error),
  normalizeOutreachError: (error) => error,
})

const createWarmupEngineStubs = () => ({
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
})

const createLoggerStub = () => ({
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
})

test('updateOutreachAccount includes workspace_id in update scope filter', async () => {
  const calls = {
    workspaceLookupEq: [],
    updateEq: [],
  }

  const supabaseStub = {
    from: (table) => {
      assert.equal(table, 'whatsapp_outreach_accounts')

      return {
        select: () => ({
          eq: (field, value) => {
            calls.workspaceLookupEq.push([field, value])
            return {
              maybeSingle: async () => ({
                data: { workspace_id: 'ws_alpha' },
                error: null,
              }),
            }
          },
        }),
        update: () => ({
          eq: (firstField, firstValue) => ({
            eq: (secondField, secondValue) => {
              calls.updateEq.push([firstField, firstValue], [secondField, secondValue])
              return {
                select: () => ({
                  single: async () => ({
                    data: {
                      id: 'acc_1',
                      workspace_id: 'ws_alpha',
                      display_name: 'Conta A',
                      status: 'warming',
                      is_active: true,
                      phone_number: null,
                      connection_type: 'qrcode',
                      health_score: 100,
                      warmup_level: 1,
                      daily_limit: null,
                      hourly_limit_min: null,
                      hourly_limit_max: null,
                      start_time: null,
                      end_time: null,
                      timezone: null,
                      active_days: null,
                      last_connected_at: null,
                      last_activity_at: null,
                      created_at: '2026-06-01T00:00:00.000Z',
                      updated_at: '2026-06-01T00:00:00.000Z',
                    },
                    error: null,
                  }),
                }),
              }
            },
          }),
        }),
      }
    },
  }

  const telemetry = { failed: [] }

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': createLoggerStub(),
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (value) => value,
      trackOutreachActionStarted: () => undefined,
      trackOutreachActionSucceeded: () => undefined,
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { updateOutreachAccount } = serviceModule
  await updateOutreachAccount('acc_1', { is_active: true, status: 'warming' }, 'ws_alpha')

  assert.ok(calls.workspaceLookupEq.some(([field, value]) => field === 'id' && value === 'acc_1'))
  assert.ok(calls.updateEq.some(([field, value]) => field === 'id' && value === 'acc_1'))
  assert.ok(calls.updateEq.some(([field, value]) => field === 'workspace_id' && value === 'ws_alpha'))
  assert.equal(telemetry.failed.length, 0)
})

test('removeRecipientFromAccountCampaign blocks mutation on workspace scope mismatch', async () => {
  let updateCalled = false
  const telemetry = { failed: [] }

  const supabaseStub = {
    from: (table) => {
      assert.equal(table, 'outreach_recipients')
      return {
        select: () => ({
          eq: (_field, _value) => ({
            maybeSingle: async () => ({
              data: { workspace_id: 'ws_real' },
              error: null,
            }),
          }),
        }),
        update: () => {
          updateCalled = true
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: null,
                  }),
                }),
              }),
            }),
          }
        },
      }
    },
  }

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': createLoggerStub(),
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (value) => value,
      trackOutreachActionStarted: () => undefined,
      trackOutreachActionSucceeded: () => undefined,
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { removeRecipientFromAccountCampaign } = serviceModule
  await assert.rejects(
    async () => {
      await removeRecipientFromAccountCampaign('rec_1', 'ws_other')
    },
    (error) => {
      assert.equal(error.code, 'WORKSPACE_SCOPE_VIOLATION')
      return true
    },
  )

  assert.equal(updateCalled, false)
  assert.equal(telemetry.failed.length, 1)
  assert.equal(telemetry.failed[0].action, 'remove_recipient')
})

test('updateRecipientStatus returns controlled workspace error when scope cannot be validated', async () => {
  let updateCalled = false
  const telemetry = { failed: [] }

  const supabaseStub = {
    from: (table) => {
      assert.equal(table, 'outreach_recipients')
      return {
        select: () => ({
          eq: (_field, _value) => ({
            maybeSingle: async () => ({
              data: null,
              error: null,
            }),
          }),
        }),
        update: () => {
          updateCalled = true
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: null,
                  }),
                }),
              }),
            }),
          }
        },
      }
    },
  }

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': createLoggerStub(),
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (value) => value,
      trackOutreachActionStarted: () => undefined,
      trackOutreachActionSucceeded: () => undefined,
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { updateRecipientStatus } = serviceModule
  await assert.rejects(
    async () => {
      await updateRecipientStatus('rec_missing_scope', 'paused')
    },
    (error) => {
      assert.equal(error.code, 'OUTREACH_WORKSPACE_REQUIRED')
      assert.equal(error.message, 'Não foi possível validar o workspace desta operação.')
      return true
    },
  )

  assert.equal(updateCalled, false)
  assert.equal(telemetry.failed.length, 1)
  assert.equal(telemetry.failed[0].action, 'update_recipient_status')
})
