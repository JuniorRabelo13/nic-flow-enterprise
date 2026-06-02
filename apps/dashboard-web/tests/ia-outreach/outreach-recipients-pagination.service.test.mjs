import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { loadTsModule } from '../helpers/load-ts-module.mjs'

const servicePath = path.resolve(
  process.cwd(),
  'src/modules/ia-outreach/services/outreach.service.ts',
)

const buildRecipient = (index, overrides = {}) => ({
  id: `recipient_${index}`,
  workspace_id: 'ws_test',
  account_campaign_id: 'ac_test',
  lead_id: null,
  contact_name: `Contato ${index}`,
  phone_number: `6199999${String(index).padStart(4, '0')}`,
  status: 'queued',
  last_message_at: null,
  replied_at: null,
  created_at: `2026-05-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
  updated_at: `2026-05-01T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
  ...overrides,
})

const createSupabaseStub = ({ data, count, error = null }) => {
  const calls = {
    from: [],
    select: [],
    eq: [],
    or: [],
    order: [],
    range: [],
  }

  const builder = {
    select: (...args) => {
      calls.select.push(args)
      return builder
    },
    eq: (field, value) => {
      calls.eq.push([field, value])
      return builder
    },
    or: (expression) => {
      calls.or.push(expression)
      return builder
    },
    order: (field, options) => {
      calls.order.push([field, options])
      return builder
    },
    range: async (from, to) => {
      calls.range.push([from, to])
      return {
        data,
        count,
        error,
      }
    },
  }

  return {
    supabase: {
      from: (table) => {
        calls.from.push(table)
        return builder
      },
    },
    calls,
  }
}

const createRuntimeStubs = (allowLocalFallback = false) => ({
  shouldAllowOutreachLocalFallback: () => allowLocalFallback,
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

test('listRecipientsByAccountCampaignPaginated applies range and returns pagination contract', async () => {
  const telemetry = { started: [], succeeded: [], failed: [] }
  const data = Array.from({ length: 25 }, (_, index) => buildRecipient(index + 1))
  const supabaseStub = createSupabaseStub({
    data,
    count: 53,
  })

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub.supabase,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (phoneNumber) => phoneNumber,
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { listRecipientsByAccountCampaignPaginated } = serviceModule
  const result = await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: 'ac_test',
    page: 1,
    pageSize: 25,
  })

  assert.equal(supabaseStub.calls.from[0], 'outreach_recipients')
  assert.ok(
    supabaseStub.calls.eq.some(([field, value]) => field === 'account_campaign_id' && value === 'ac_test'),
  )
  assert.ok(!supabaseStub.calls.eq.some(([field]) => field === 'status'))
  assert.deepEqual(supabaseStub.calls.range[0], [0, 24])

  assert.equal(result.items.length, 25)
  assert.equal(result.total, 53)
  assert.equal(result.page, 1)
  assert.equal(result.pageSize, 25)
  assert.equal(result.totalPages, 3)

  assert.equal(telemetry.started[0].action, 'list_recipients')
  assert.equal(telemetry.started[0].safe_context.paginated, true)
  assert.equal(telemetry.started[0].safe_context.filtered, false)
})

test('listRecipientsByAccountCampaignPaginated applies status filter and telemetry marks filtered=true', async () => {
  const telemetry = { started: [], succeeded: [], failed: [] }
  const supabaseStub = createSupabaseStub({
    data: [buildRecipient(1, { status: 'queued' })],
    count: 1,
  })

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub.supabase,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (phoneNumber) => phoneNumber,
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { listRecipientsByAccountCampaignPaginated } = serviceModule
  await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: 'ac_test',
    page: 1,
    pageSize: 25,
    status: 'queued',
  })

  assert.ok(
    supabaseStub.calls.eq.some(([field, value]) => field === 'status' && value === 'queued'),
  )
  assert.equal(telemetry.started[0].safe_context.paginated, true)
  assert.equal(telemetry.started[0].safe_context.filtered, true)
  assert.equal(telemetry.started[0].safe_context.status, 'queued')
})

test('listRecipientsByAccountCampaignPaginated with clear-filters payload does not apply restrictive status/search filters', async () => {
  const telemetry = { started: [], succeeded: [], failed: [] }
  const supabaseStub = createSupabaseStub({
    data: [buildRecipient(1)],
    count: 1,
  })

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub.supabase,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (phoneNumber) => phoneNumber,
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { listRecipientsByAccountCampaignPaginated } = serviceModule
  await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: 'ac_test',
    page: 1,
    pageSize: 25,
    status: 'all',
    search: '',
  })

  assert.ok(!supabaseStub.calls.eq.some(([field]) => field === 'status'))
  assert.equal(supabaseStub.calls.or.length, 0)
  assert.deepEqual(supabaseStub.calls.range[0], [0, 24])

  assert.equal(telemetry.started[0].safe_context.status, 'all')
  assert.equal(telemetry.started[0].safe_context.filtered, false)
  assert.equal(telemetry.started[0].safe_context.has_search, false)
  assert.equal(telemetry.started[0].safe_context.page, 1)
  assert.equal(telemetry.started[0].safe_context.page_size, 25)

  const serializedTelemetry = JSON.stringify(telemetry)
  assert.doesNotMatch(serializedTelemetry, /61999990000/)
})

test('listRecipientsByAccountCampaignPaginated applies server-side search and keeps telemetry safe', async () => {
  const telemetry = { started: [], succeeded: [], failed: [] }
  const searchTerm = '61999990000'
  const supabaseStub = createSupabaseStub({
    data: [buildRecipient(2)],
    count: 1,
  })

  const serviceModule = await loadTsModule(servicePath, {
    '../../../enterprise/observability/logger': {
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    },
    '../../whatsapp/services/supabase.client': {
      supabase: supabaseStub.supabase,
    },
    './outreach-queue.service': {
      buildAccountCampaignQueue: async () => {
        throw new Error('not-used-in-this-test')
      },
    },
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber: (phoneNumber) => phoneNumber,
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const { listRecipientsByAccountCampaignPaginated } = serviceModule
  await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: 'ac_test',
    page: 1,
    pageSize: 25,
    search: searchTerm,
  })

  assert.equal(supabaseStub.calls.or.length, 1)
  assert.match(supabaseStub.calls.or[0], /contact_name\.ilike/)
  assert.match(supabaseStub.calls.or[0], /phone_number\.ilike/)

  assert.equal(telemetry.started[0].safe_context.has_search, true)
  assert.equal(telemetry.started[0].safe_context.search_length, searchTerm.length)
  assert.equal(telemetry.started[0].safe_context.filtered, true)

  const serializedTelemetry = JSON.stringify(telemetry)
  assert.doesNotMatch(serializedTelemetry, /61999990000/)
})

test('listRecipientsByAccountCampaignPaginated uses local fallback with safe filters, pagination and telemetry', async () => {
  const telemetry = { started: [], succeeded: [], failed: [] }
  const maskPhoneNumber = (phoneNumber) => {
    const digits = String(phoneNumber ?? '').replace(/\D/g, '')
    if (!digits) {
      return '***'
    }
    return `***${digits.slice(-4)}`
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
    './outreach-errors': createOutreachErrorStubs(),
    './outreach-telemetry': {
      maskPhoneNumber,
      trackOutreachActionStarted: (payload) => telemetry.started.push(payload),
      trackOutreachActionSucceeded: (payload) => telemetry.succeeded.push(payload),
      trackOutreachActionFailed: (payload) => telemetry.failed.push(payload),
    },
    './outreach-runtime': createRuntimeStubs(true),
    './outreach-warmup-engine': createWarmupEngineStubs(),
  })

  const {
    addRecipientToAccountCampaign,
    createIndependentAccountCampaign,
    createOutreachAccount,
    createOutreachCampaign,
    listRecipientsByAccountCampaignPaginated,
  } = serviceModule

  const workspaceId = 'ws_local_fallback'
  const account = await createOutreachAccount({
    workspaceId,
    displayName: 'Conta Local',
    timezone: 'America/Sao_Paulo',
  })
  const campaign = await createOutreachCampaign({
    workspaceId,
    name: 'Campanha Local',
    baseMessage: 'Mensagem estrutural',
  })
  const execution = await createIndependentAccountCampaign({
    workspaceId,
    accountId: account.id,
    campaignId: campaign.id,
  })

  for (let index = 0; index < 30; index += 1) {
    const status = index % 2 === 0 ? 'queued' : 'paused'
    await addRecipientToAccountCampaign({
      workspaceId,
      accountCampaignId: execution.id,
      contactName: `Contato Fallback ${index + 1}`,
      phoneNumber: `6197000${String(index).padStart(4, '0')}`,
      status,
    })
  }

  await addRecipientToAccountCampaign({
    workspaceId,
    accountCampaignId: execution.id,
    contactName: 'Contato Especial Busca',
    phoneNumber: '61999990000',
    status: 'scheduled',
  })

  await addRecipientToAccountCampaign({
    workspaceId,
    accountCampaignId: execution.id,
    contactName: 'Contato Busca Telefone',
    phoneNumber: '61888887777',
    status: 'failed',
  })

  const clearFiltersResult = await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: execution.id,
    page: 1,
    pageSize: 25,
    status: 'all',
    search: '',
  })

  assert.equal(clearFiltersResult.page, 1)
  assert.equal(clearFiltersResult.pageSize, 25)
  assert.equal(clearFiltersResult.items.length, 25)
  assert.equal(clearFiltersResult.total, 32)
  assert.equal(clearFiltersResult.totalPages, 2)

  const statusFilterResult = await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: execution.id,
    page: 1,
    pageSize: 25,
    status: 'paused',
    search: '',
  })

  assert.equal(statusFilterResult.page, 1)
  assert.equal(statusFilterResult.pageSize, 25)
  assert.ok(statusFilterResult.total > 0)
  assert.ok(statusFilterResult.total < clearFiltersResult.total)
  assert.ok(statusFilterResult.items.every((recipient) => recipient.status === 'paused'))

  const searchByNameResult = await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: execution.id,
    page: 1,
    pageSize: 25,
    status: 'all',
    search: 'Especial Busca',
  })

  assert.equal(searchByNameResult.total, 1)
  assert.equal(searchByNameResult.items[0]?.contact_name, 'Contato Especial Busca')

  const searchByPhoneResult = await listRecipientsByAccountCampaignPaginated({
    accountCampaignId: execution.id,
    page: 1,
    pageSize: 25,
    status: 'all',
    search: '88887777',
  })

  assert.equal(searchByPhoneResult.total, 1)
  assert.equal(searchByPhoneResult.items[0]?.phone_number, '61888887777')

  const paginatedStartedEvents = telemetry.started.filter(
    (event) => event.action === 'list_recipients' && event.safe_context?.paginated === true,
  )
  const paginatedSucceededEvents = telemetry.succeeded.filter(
    (event) => event.action === 'list_recipients' && event.safe_context?.paginated === true,
  )
  const clearFiltersStartedEvent = paginatedStartedEvents.find(
    (event) =>
      event.safe_context?.status === 'all'
      && event.safe_context?.has_search === false
      && event.safe_context?.search_length === 0
      && event.safe_context?.filtered === false
      && event.safe_context?.page === 1
      && event.safe_context?.page_size === 25,
  )
  const clearFiltersSucceededEvent = paginatedSucceededEvents.find(
    (event) =>
      event.safe_context?.status === 'all'
      && event.safe_context?.has_search === false
      && event.safe_context?.search_length === 0
      && event.safe_context?.filtered === false
      && event.safe_context?.source === 'local_fallback',
  )
  const searchEvents = paginatedStartedEvents.filter(
    (event) => event.safe_context?.has_search === true,
  )

  assert.ok(clearFiltersStartedEvent)
  assert.ok(clearFiltersSucceededEvent)
  assert.ok(searchEvents.length >= 2)
  assert.ok(
    searchEvents.every(
      (event) =>
        Number.isInteger(event.safe_context?.search_length)
        && Number(event.safe_context?.search_length) > 0,
    ),
  )

  const serializedPaginatedTelemetry = JSON.stringify({
    started: paginatedStartedEvents,
    succeeded: paginatedSucceededEvents,
    failed: telemetry.failed,
  })
  assert.doesNotMatch(serializedPaginatedTelemetry, /Especial Busca/)
  assert.doesNotMatch(serializedPaginatedTelemetry, /61999990000/)
})
