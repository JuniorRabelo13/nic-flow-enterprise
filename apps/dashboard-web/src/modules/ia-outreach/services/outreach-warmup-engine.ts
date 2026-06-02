import { logger } from '../../../enterprise/observability/logger'
import { supabase } from '../../whatsapp/services/supabase.client'
import {
  type IndependentScheduleParams,
  type OutreachAccount,
  type OutreachWarmupEvent,
  type WarmupProfile,
  type WarmupScheduleSlot,
} from '../types'

const warmupEventsTable = 'outreach_warmup_events'
const tableMissingErrorCodes = new Set(['42P01', 'PGRST205'])
const weekDayIds = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

const localWarmupEvents: OutreachWarmupEvent[] = []

type RegisterWarmupEventPayload = {
  workspaceId: string
  accountId: string
  accountCampaignId?: string | null
  eventType: OutreachWarmupEvent['event_type']
  eventPayload?: Record<string, unknown> | null
}

type PauseDecision = {
  pauseRecommended: boolean
  reason: string | null
}

const nowIso = () => new Date().toISOString()

const isTableMissingError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const errorCode = 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  return tableMissingErrorCodes.has(errorCode)
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const buildSeedHash = (input: string) =>
  input.split('').reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)

const createSeededRandom = (seed: string) => {
  let state = (Math.abs(buildSeedHash(seed)) || 1) >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

const normalizeTimeValue = (value: string | null | undefined, fallback: string) => {
  const raw = (value ?? '').trim()
  if (!raw) {
    return fallback
  }

  if (/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.slice(0, 5)
  }

  return fallback
}

const toMinutes = (time: string) => {
  const [hourRaw, minuteRaw] = time.split(':')
  const hour = Number.parseInt(hourRaw ?? '0', 10)
  const minute = Number.parseInt(minuteRaw ?? '0', 10)
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return 0
  }
  return clamp(hour, 0, 23) * 60 + clamp(minute, 0, 59)
}

const getActiveDays = (account: Pick<OutreachAccount, 'active_days'>) => {
  if (!Array.isArray(account.active_days) || account.active_days.length === 0) {
    return ['mon', 'tue', 'wed', 'thu', 'fri']
  }
  return account.active_days
}

const moveToNextActiveDay = (date: Date, activeDays: string[]) => {
  const normalized = new Date(date)
  for (let offset = 0; offset < 14; offset += 1) {
    const dayId = weekDayIds[normalized.getDay()]
    if (activeDays.includes(dayId)) {
      return normalized
    }
    normalized.setDate(normalized.getDate() + 1)
    normalized.setHours(0, 0, 0, 0)
  }

  return normalized
}

const alignToWindow = (candidate: Date, profile: WarmupProfile) => {
  const activeDays = profile.activeDays
  const startMinutes = toMinutes(profile.windowStartTime)
  const endMinutes = toMinutes(profile.windowEndTime)

  let aligned = moveToNextActiveDay(candidate, activeDays)
  let minuteOfDay = aligned.getHours() * 60 + aligned.getMinutes()

  if (endMinutes > startMinutes) {
    if (minuteOfDay < startMinutes) {
      aligned.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0)
      minuteOfDay = startMinutes
    }
    if (minuteOfDay > endMinutes) {
      aligned.setDate(aligned.getDate() + 1)
      aligned = moveToNextActiveDay(aligned, activeDays)
      aligned.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0)
    }
    return aligned
  }

  const withinOvernight = minuteOfDay >= startMinutes || minuteOfDay <= endMinutes
  if (!withinOvernight) {
    aligned.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0)
  }
  return aligned
}

const scheduleSpanMinutes = (profile: WarmupProfile) => {
  const startMinutes = toMinutes(profile.windowStartTime)
  const endMinutes = toMinutes(profile.windowEndTime)
  if (endMinutes > startMinutes) {
    return endMinutes - startMinutes
  }
  return 1440 - startMinutes + endMinutes
}

export const generateIndependentSeed = (accountId: string, accountCampaignId: string) => {
  const raw = `${accountId}:${accountCampaignId}:${Math.abs(buildSeedHash(`${accountCampaignId}|${accountId}`))}`
  return `seed_${raw.replace(/[^a-zA-Z0-9:_-]/g, '')}`
}

export const calculateHourlyRange = (
  account: Pick<OutreachAccount, 'id' | 'warmup_level' | 'hourly_limit_min' | 'hourly_limit_max'>,
) => {
  if (typeof account.hourly_limit_min === 'number' && typeof account.hourly_limit_max === 'number') {
    const min = Math.max(1, Math.min(account.hourly_limit_min, account.hourly_limit_max))
    const max = Math.max(min, account.hourly_limit_max)
    return { min, max }
  }

  const seed = Math.abs(buildSeedHash(account.id))
  const baseMin = 6 + (seed % 3)
  const warmupBoost = Math.max(0, account.warmup_level - 1)
  const min = clamp(baseMin + Math.floor(warmupBoost / 2), 4, 20)
  const max = clamp(min + 1 + (seed % 4) + Math.floor(warmupBoost / 3), min + 1, 30)
  return { min, max }
}

export const calculateDailyLimit = (
  account: Pick<OutreachAccount, 'daily_limit' | 'warmup_level'>,
  hourlyRange: { min: number; max: number },
  windowSpanMinutes: number,
) => {
  if (typeof account.daily_limit === 'number' && account.daily_limit > 0) {
    return account.daily_limit
  }

  const activeHours = Math.max(1, Math.floor(windowSpanMinutes / 60))
  const warmupFactor = 0.65 + Math.min(0.25, account.warmup_level * 0.02)
  const projected = Math.floor(activeHours * hourlyRange.max * warmupFactor)
  return clamp(projected, hourlyRange.min * 2, Math.max(hourlyRange.max * 6, 120))
}

export const shouldPauseAccount = (
  account: Pick<OutreachAccount, 'status' | 'health_score' | 'is_active'>,
): PauseDecision => {
  if (!account.is_active) {
    return { pauseRecommended: true, reason: 'Conta inativa para agendamento estrutural.' }
  }

  if (account.status === 'paused' || account.status === 'risk' || account.status === 'blocked') {
    return { pauseRecommended: true, reason: `Conta em status ${account.status}.` }
  }

  if (account.health_score <= 35) {
    return { pauseRecommended: true, reason: 'Saúde da conta abaixo do limiar operacional.' }
  }

  return { pauseRecommended: false, reason: null }
}

export const calculateAccountWarmupProfile = (
  account: Pick<
    OutreachAccount,
    | 'id'
    | 'workspace_id'
    | 'status'
    | 'health_score'
    | 'warmup_level'
    | 'daily_limit'
    | 'hourly_limit_min'
    | 'hourly_limit_max'
    | 'start_time'
    | 'end_time'
    | 'timezone'
    | 'active_days'
    | 'is_active'
  >,
): WarmupProfile => {
  const activeDays = getActiveDays(account)
  const windowStartTime = normalizeTimeValue(account.start_time, '09:00')
  const windowEndTime = normalizeTimeValue(account.end_time, '18:00')
  const hourlyRange = calculateHourlyRange(account)
  const spanMinutes = scheduleSpanMinutes({
    workspaceId: account.workspace_id,
    accountId: account.id,
    seed: `seed_${account.id}`,
    timezone: account.timezone ?? 'America/Sao_Paulo',
    activeDays,
    windowStartTime,
    windowEndTime,
    hourlyRange,
    dailyLimit: 0,
    warmupLevel: account.warmup_level,
    pauseRecommended: false,
    reason: null,
  })
  const dailyLimit = calculateDailyLimit(account, hourlyRange, spanMinutes)
  const pauseDecision = shouldPauseAccount(account)

  return {
    workspaceId: account.workspace_id,
    accountId: account.id,
    seed: `seed_${account.id}`,
    timezone: account.timezone ?? 'America/Sao_Paulo',
    activeDays,
    windowStartTime,
    windowEndTime,
    hourlyRange,
    dailyLimit,
    warmupLevel: account.warmup_level,
    pauseRecommended: pauseDecision.pauseRecommended,
    reason: pauseDecision.reason,
  }
}

export const generateNonPatternSchedule = (params: IndependentScheduleParams): WarmupScheduleSlot[] => {
  const referenceDate = params.referenceAt ? new Date(params.referenceAt) : new Date()
  const base = Number.isNaN(referenceDate.getTime()) ? new Date() : referenceDate
  const minSpacing = Math.max(4, params.minSpacingMinutes ?? 7)
  const random = createSeededRandom(`${params.warmupProfile.seed}:${params.accountCampaignId}:${base.toISOString()}`)
  const result: WarmupScheduleSlot[] = []
  let cursor = alignToWindow(base, params.warmupProfile)

  for (let index = 0; index < params.desiredCount; index += 1) {
    const spacing = minSpacing + Math.floor(random() * 19)
    const jitter = Math.floor(random() * 13) - 6
    const candidate = new Date(cursor.getTime() + (spacing + jitter) * 60 * 1000)
    cursor = alignToWindow(candidate, params.warmupProfile)

    const minuteOfDay = cursor.getHours() * 60 + cursor.getMinutes()
    const startMinutes = toMinutes(params.warmupProfile.windowStartTime)
    const endMinutes = toMinutes(params.warmupProfile.windowEndTime)
    const overnight = endMinutes <= startMinutes
    const outsideWindow = overnight
      ? minuteOfDay < startMinutes && minuteOfDay > endMinutes
      : minuteOfDay < startMinutes || minuteOfDay > endMinutes

    if (outsideWindow) {
      const anchorMinutes = startMinutes + Math.floor(random() * 15)
      cursor.setHours(Math.floor(anchorMinutes / 60), anchorMinutes % 60, 0, 0)
      cursor = alignToWindow(cursor, params.warmupProfile)
    }

    const slotJitter = Math.floor(random() * 9)
    const scheduled = new Date(cursor.getTime() + slotJitter * 60 * 1000)
    cursor = new Date(scheduled.getTime())

    result.push({
      accountId: params.accountId,
      accountCampaignId: params.accountCampaignId,
      seed: params.warmupProfile.seed,
      slotIndex: index,
      jitterMinutes: slotJitter,
      scheduledFor: scheduled.toISOString(),
    })
  }

  return result
}

export const registerWarmupEvent = async (payload: RegisterWarmupEventPayload): Promise<OutreachWarmupEvent> => {
  const row = {
    workspace_id: payload.workspaceId,
    account_id: payload.accountId,
    account_campaign_id: payload.accountCampaignId ?? null,
    event_type: payload.eventType,
    event_payload: payload.eventPayload ?? null,
  }

  if (!supabase) {
    const localEvent: OutreachWarmupEvent = {
      id: crypto.randomUUID(),
      workspace_id: payload.workspaceId,
      account_id: payload.accountId,
      account_campaign_id: payload.accountCampaignId ?? null,
      event_type: payload.eventType,
      event_payload: payload.eventPayload ?? null,
      created_at: nowIso(),
    }
    localWarmupEvents.unshift(localEvent)
    logger.info('ia_outreach_warmup_event_local', {
      eventType: payload.eventType,
      workspaceId: payload.workspaceId,
      accountId: payload.accountId,
      accountCampaignId: payload.accountCampaignId ?? null,
      mode: 'structural_only',
    })
    return localEvent
  }

  const { data, error } = await supabase.from(warmupEventsTable).insert(row).select('*').single()
  if (error) {
    if (isTableMissingError(error)) {
      // TODO: Persistir eventos estruturais quando tabela estiver disponível no ambiente-alvo.
      const fallbackEvent: OutreachWarmupEvent = {
        id: crypto.randomUUID(),
        workspace_id: payload.workspaceId,
        account_id: payload.accountId,
        account_campaign_id: payload.accountCampaignId ?? null,
        event_type: payload.eventType,
        event_payload: payload.eventPayload ?? null,
        created_at: nowIso(),
      }
      localWarmupEvents.unshift(fallbackEvent)
      logger.warn('ia_outreach_warmup_event_table_missing', {
        eventType: payload.eventType,
        workspaceId: payload.workspaceId,
        accountId: payload.accountId,
        accountCampaignId: payload.accountCampaignId ?? null,
        mode: 'structural_only',
      })
      return fallbackEvent
    }
    throw error
  }

  logger.info('ia_outreach_warmup_event_registered', {
    eventType: payload.eventType,
    workspaceId: payload.workspaceId,
    accountId: payload.accountId,
    accountCampaignId: payload.accountCampaignId ?? null,
    mode: 'structural_only',
  })
  return data as OutreachWarmupEvent
}
