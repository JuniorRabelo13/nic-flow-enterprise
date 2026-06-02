import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const telemetryPath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/services/outreach-telemetry.ts',
)

test('maskPhoneNumber obfuscates phone values with safe mask', async () => {
  const telemetryModule = await loadTsModule(telemetryPath, {
    '../../../enterprise/config/env': {
      enterpriseEnv: { appEnv: 'test' },
    },
    '../../../enterprise/observability/logger': {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    './outreach-errors': {
      extractOutreachErrorTelemetry: () => ({
        code: 'UNKNOWN_OUTREACH_ERROR',
        constraint: null,
        safeMessage: 'Falha desconhecida',
      }),
    },
  })

  assert.equal(telemetryModule.maskPhoneNumber('61999990000'), '61*****000')
})

test('trackOutreachActionFailed and trackOutreachDomainError keep action/error_code and hide sensitive phone data', async () => {
  const logCalls = {
    info: [],
    warn: [],
    error: [],
  }

  const telemetryModule = await loadTsModule(telemetryPath, {
    '../../../enterprise/config/env': {
      enterpriseEnv: { appEnv: 'test' },
    },
    '../../../enterprise/observability/logger': {
      logger: {
        info: (event, payload) => logCalls.info.push({ event, payload }),
        warn: (event, payload) => logCalls.warn.push({ event, payload }),
        error: (event, payload) => logCalls.error.push({ event, payload }),
      },
    },
    './outreach-errors': {
      extractOutreachErrorTelemetry: () => ({
        code: 'OUTREACH_BACKEND_UNAVAILABLE',
        constraint: null,
        safeMessage: 'Esta ação exige conexão real com o backend.',
      }),
    },
  })

  telemetryModule.trackOutreachActionFailed({
    action: 'load_warmup_suggestions',
    error: new Error('database down'),
    workspace_id: 'ws_1',
    safe_context: {
      phoneNumber: '61999990000',
      opaque: 'ok',
      nested: {
        telefone: '61999990000',
      },
    },
  })

  telemetryModule.trackOutreachDomainError({
    action: 'calculate_warmup_window',
    workspace_id: 'ws_1',
    error_code: 'OUTREACH_BACKEND_UNAVAILABLE',
    safe_context: {
      msisdn: '61999990000',
    },
  })

  assert.equal(logCalls.warn.length, 2)

  const failedPayload = logCalls.warn[0].payload
  assert.equal(logCalls.warn[0].event, 'ia_outreach_telemetry')
  assert.equal(failedPayload.module, 'ia-outreach')
  assert.equal(failedPayload.action, 'load_warmup_suggestions')
  assert.equal(failedPayload.error_code, 'OUTREACH_BACKEND_UNAVAILABLE')
  assert.equal(failedPayload.safe_context.phoneNumber, '61*****000')
  assert.equal(failedPayload.safe_context.nested.telefone, '61*****000')
  assert.notEqual(failedPayload.safe_context.phoneNumber, '61999990000')

  const domainPayload = logCalls.warn[1].payload
  assert.equal(logCalls.warn[1].event, 'ia_outreach_telemetry')
  assert.equal(domainPayload.module, 'ia-outreach')
  assert.equal(domainPayload.action, 'calculate_warmup_window')
  assert.equal(domainPayload.safe_context.msisdn, '61*****000')

  const serialized = JSON.stringify({ failedPayload, domainPayload })
  assert.doesNotMatch(serialized, /61999990000/)
})
