import { logger } from '../../../enterprise/observability/logger'
import { supabase } from '../../whatsapp/services/supabase.client'
import { buildAccountCampaignQueue } from './outreach-queue.service'
import {
  createOutreachDomainError,
  isOutreachDomainError,
  normalizeOutreachError,
} from './outreach-errors'
import {
  maskPhoneNumber,
  trackOutreachActionFailed,
  trackOutreachActionStarted,
  trackOutreachActionSucceeded,
} from './outreach-telemetry'
import {
  shouldAllowOutreachLocalFallback,
  throwOutreachBackendUnavailable,
  throwOutreachLocalFallbackDisabled,
  throwOutreachPersistenceUnavailable,
  throwOutreachReadUnavailable,
} from './outreach-runtime'
import {
  type BulkRecipientInput,
  type BulkRecipientResult,
  type CampaignExecutionSummary,
  type CreateCampaignWithExecutionsInput,
  type CreateCampaignWithExecutionsResult,
  type CreateIndependentAccountCampaignInput,
  type CreateOutreachAccountInput,
  type CreateOutreachCampaignInput,
  type MessageVariantPreview,
  type OutreachRecipientInput,
  type OutreachAccount,
  type OutreachAccountCampaign,
  type OutreachCampaign,
  type OutreachConversation,
  type OutreachMessageVariant,
  type OutreachRecipient,
  type RecipientImportPreview,
  type RecipientImportRow,
  type RecipientSummaryByExecution,
  type QueueBuildResult,
  type UpdateOutreachAccountInput,
  type WarmupWindowSuggestion,
} from '../types'

const outreachAccountsTable = 'whatsapp_outreach_accounts'
const outreachCampaignsTable = 'outreach_campaigns'
const outreachAccountCampaignsTable = 'outreach_account_campaigns'
const outreachMessageVariantsTable = 'outreach_message_variants'
const outreachRecipientsTable = 'outreach_recipients'
const outreachConversationsTable = 'outreach_conversations'
const activeRecipientStatuses: OutreachRecipient['status'][] = ['queued', 'scheduled', 'contacted', 'replied', 'paused']
const workspaceScopeValidationMessage = 'Não foi possível validar o workspace desta operação.'

export type ListRecipientsByAccountCampaignPaginatedParams = {
  accountCampaignId: string
  page: number
  pageSize: number
  status?: OutreachRecipient['status']
  search?: string
}

export type ListRecipientsByAccountCampaignPaginatedResult = {
  items: OutreachRecipient[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

const tableMissingErrorCodes = new Set(['42P01', 'PGRST205'])
const localAccountStore: OutreachAccount[] = []
const localCampaignStore: OutreachCampaign[] = []
const localAccountCampaignStore: OutreachAccountCampaign[] = []
const localMessageVariantStore: OutreachMessageVariant[] = []
const localRecipientStore: OutreachRecipient[] = []

const nowIso = () => new Date().toISOString()

const isTableMissingError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const errorCode = 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
  return tableMissingErrorCodes.has(errorCode)
}

const assertOutreachReadAvailable = (action: string, context?: Record<string, unknown>) => {
  if (!supabase) {
    if (shouldAllowOutreachLocalFallback()) {
      return
    }
    throwOutreachReadUnavailable(action, context)
  }
}

const assertOutreachPersistenceAvailable = (action: string, context?: Record<string, unknown>) => {
  if (!supabase) {
    if (shouldAllowOutreachLocalFallback()) {
      return
    }
    throwOutreachLocalFallbackDisabled(action, context)
  }
}

const handleOutreachTableMissing = (action: string, context?: Record<string, unknown>) => {
  if (shouldAllowOutreachLocalFallback()) {
    return
  }
  throwOutreachPersistenceUnavailable(action, context)
}

const buildSeedHash = (input: string) =>
  input.split('').reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)

const normalizeHour = (value: number) => Math.max(0, Math.min(23, value))

const formatHour = (value: number) => `${String(normalizeHour(value)).padStart(2, '0')}:00`

const truncateText = (value: string, maxLength: number) => (value.length > maxLength ? `${value.slice(0, maxLength)}...` : value)

const mapVariantPreview = (variant: OutreachMessageVariant): MessageVariantPreview => ({
  id: variant.id,
  accountCampaignId: variant.account_campaign_id,
  variantIndex: variant.variant_index,
  content: variant.content,
  source: variant.source,
  isBase: variant.is_base,
  createdAt: variant.created_at,
})

const parseRecipientLine = (rawLine: string) => {
  const separators = [',', ';', '|']
  let selectedSeparator: string | null = null
  let splitIndex = -1

  for (const separator of separators) {
    const index = rawLine.indexOf(separator)
    if (index > -1 && (splitIndex === -1 || index < splitIndex)) {
      splitIndex = index
      selectedSeparator = separator
    }
  }

  if (!selectedSeparator || splitIndex === -1) {
    return {
      contactName: null,
      phoneCandidate: rawLine.trim(),
    }
  }

  const contactName = rawLine.slice(0, splitIndex).trim() || null
  const phoneCandidate = rawLine.slice(splitIndex + 1).trim()
  return {
    contactName,
    phoneCandidate,
  }
}

const mapRecipientImportRow = (
  lineNumber: number,
  raw: string,
  contactName: string | null,
  phoneNumberRaw: string,
  normalizedPhoneNumber: string | null,
  reason: string | null,
): RecipientImportRow => ({
  lineNumber,
  raw,
  contactName,
  phoneNumberRaw,
  normalizedPhoneNumber,
  isValid: reason === null,
  reason,
})

const mapRecipientSummary = (
  workspaceId: string,
  accountCampaignId: string,
  recipients: OutreachRecipient[],
): RecipientSummaryByExecution => ({
  workspaceId,
  accountCampaignId,
  total: recipients.length,
  queued: recipients.filter((recipient) => recipient.status === 'queued').length,
  scheduled: recipients.filter((recipient) => recipient.status === 'scheduled').length,
  contacted: recipients.filter((recipient) => recipient.status === 'contacted').length,
  replied: recipients.filter((recipient) => recipient.status === 'replied').length,
  paused: recipients.filter((recipient) => recipient.status === 'paused').length,
  removed: recipients.filter((recipient) => recipient.status === 'removed').length,
  failed: recipients.filter((recipient) => recipient.status === 'failed').length,
})

const logOutreachStructure = (event: string, context: Record<string, unknown>) => {
  logger.info('ia_outreach_structure_event', {
    event,
    mode: 'structural_only',
    sendExecution: 'disabled',
    ...context,
  })
}

const resolveMutationWorkspaceScope = ({
  providedWorkspaceId,
  entityWorkspaceId,
  action,
  context,
}: {
  providedWorkspaceId?: string | null
  entityWorkspaceId?: string | null
  action: string
  context: Record<string, unknown>
}) => {
  const provided = providedWorkspaceId?.trim()
  const scopedWorkspaceId = entityWorkspaceId?.trim()

  if (provided && scopedWorkspaceId && provided !== scopedWorkspaceId) {
    throw createOutreachDomainError('WORKSPACE_SCOPE_VIOLATION', 'A ação não pertence ao workspace atual.', {
      ...context,
      action,
      expectedWorkspaceId: provided,
      resolvedWorkspaceId: scopedWorkspaceId,
    })
  }

  const resolved = provided ?? scopedWorkspaceId ?? null
  if (!resolved) {
    throw createOutreachDomainError('OUTREACH_WORKSPACE_REQUIRED', workspaceScopeValidationMessage, {
      ...context,
      action,
    })
  }

  return resolved
}

const resolveAccountWorkspaceScope = async (accountId: string, workspaceId?: string): Promise<string> => {
  if (!supabase) {
    const account = localAccountStore.find((item) => item.id === accountId) ?? null
    return resolveMutationWorkspaceScope({
      providedWorkspaceId: workspaceId,
      entityWorkspaceId: account?.workspace_id ?? null,
      action: 'update_outreach_account',
      context: { accountId },
    })
  }

  const { data, error } = await supabase
    .from(outreachAccountsTable)
    .select('workspace_id')
    .eq('id', accountId)
    .maybeSingle<{ workspace_id: string | null }>()

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('update_outreach_account_scope', { accountId })
      const localAccount = localAccountStore.find((item) => item.id === accountId) ?? null
      return resolveMutationWorkspaceScope({
        providedWorkspaceId: workspaceId,
        entityWorkspaceId: localAccount?.workspace_id ?? null,
        action: 'update_outreach_account',
        context: { accountId },
      })
    }
    throw error
  }

  return resolveMutationWorkspaceScope({
    providedWorkspaceId: workspaceId,
    entityWorkspaceId: data?.workspace_id ?? null,
    action: 'update_outreach_account',
    context: { accountId },
  })
}

const resolveRecipientWorkspaceScope = async (recipientId: string, workspaceId?: string): Promise<string> => {
  if (!supabase) {
    const recipient = localRecipientStore.find((item) => item.id === recipientId) ?? null
    return resolveMutationWorkspaceScope({
      providedWorkspaceId: workspaceId,
      entityWorkspaceId: recipient?.workspace_id ?? null,
      action: 'update_recipient_scope',
      context: { recipientId },
    })
  }

  const { data, error } = await supabase
    .from(outreachRecipientsTable)
    .select('workspace_id')
    .eq('id', recipientId)
    .maybeSingle<{ workspace_id: string | null }>()

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('update_recipient_scope', { recipientId })
      const localRecipient = localRecipientStore.find((item) => item.id === recipientId) ?? null
      return resolveMutationWorkspaceScope({
        providedWorkspaceId: workspaceId,
        entityWorkspaceId: localRecipient?.workspace_id ?? null,
        action: 'update_recipient_scope',
        context: { recipientId },
      })
    }
    throw error
  }

  return resolveMutationWorkspaceScope({
    providedWorkspaceId: workspaceId,
    entityWorkspaceId: data?.workspace_id ?? null,
    action: 'update_recipient_scope',
    context: { recipientId },
  })
}

const localOutreachAccount = (payload: CreateOutreachAccountInput): OutreachAccount => ({
  id: crypto.randomUUID(),
  workspace_id: payload.workspaceId,
  display_name: payload.displayName,
  phone_number: null,
  connection_type: 'qrcode',
  status: 'draft',
  health_score: 100,
  warmup_level: 1,
  daily_limit: null,
  hourly_limit_min: null,
  hourly_limit_max: null,
  start_time: payload.startTime ?? null,
  end_time: payload.endTime ?? null,
  timezone: payload.timezone ?? null,
  active_days: payload.activeDays ?? null,
  is_active: false,
  last_connected_at: null,
  last_activity_at: null,
  created_at: nowIso(),
  updated_at: nowIso(),
})

const localOutreachCampaign = (payload: CreateOutreachCampaignInput): OutreachCampaign => ({
  id: crypto.randomUUID(),
  workspace_id: payload.workspaceId,
  name: payload.name,
  objective: payload.objective ?? null,
  base_message: payload.baseMessage,
  status: 'draft',
  created_by: null,
  created_at: nowIso(),
  updated_at: nowIso(),
})

const localOutreachAccountCampaign = (payload: CreateIndependentAccountCampaignInput): OutreachAccountCampaign => ({
  id: crypto.randomUUID(),
  workspace_id: payload.workspaceId,
  account_id: payload.accountId,
  campaign_id: payload.campaignId,
  status: 'draft',
  independent_seed: `seed_${crypto.randomUUID()}`,
  warmup_profile: payload.warmupProfile ?? null,
  started_at: null,
  paused_at: null,
  completed_at: null,
  created_at: nowIso(),
  updated_at: nowIso(),
})

const calculateWindowFromSeed = (
  accountId: string,
  account?: Pick<OutreachAccount, 'warmup_level' | 'hourly_limit_min' | 'hourly_limit_max' | 'start_time' | 'end_time'>,
): WarmupWindowSuggestion => {
  const seed = Math.abs(buildSeedHash(accountId))
  const seedA = seed % 4
  const seedB = seed % 6
  const warmupLevel = Math.max(1, account?.warmup_level ?? 1)
  const startHour = Number.parseInt((account?.start_time ?? formatHour(8 + seedA)).slice(0, 2), 10)
  const endHour = Number.parseInt((account?.end_time ?? formatHour(17 + seedA)).slice(0, 2), 10)
  const fallbackMin = Math.max(2, warmupLevel + seedA + 1)
  const fallbackMax = Math.max(fallbackMin + 2, fallbackMin + seedB)
  const hourlyLimitMin = account?.hourly_limit_min ?? fallbackMin
  const hourlyLimitMax = account?.hourly_limit_max ?? fallbackMax

  return {
    accountId,
    suggestedStartTime: formatHour(startHour),
    suggestedEndTime: formatHour(endHour <= startHour ? startHour + 8 : endHour),
    hourlyLimitMin,
    hourlyLimitMax,
    note: 'Janela sugerida com seed independente por conta. Sem envio real nesta etapa.',
  }
}

export const listOutreachAccounts = async (workspaceId: string): Promise<OutreachAccount[]> => {
  trackOutreachActionStarted({
    action: 'list_accounts',
    workspace_id: workspaceId,
  })

  try {
    assertOutreachReadAvailable('list_outreach_accounts', { workspaceId })

    if (!supabase) {
      const localRows = localAccountStore
        .filter((account) => account.workspace_id === workspaceId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
      trackOutreachActionSucceeded({
        action: 'list_accounts',
        workspace_id: workspaceId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachAccountsTable)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_outreach_accounts', { workspaceId })
        logOutreachStructure('list_outreach_accounts_table_missing', { workspaceId })
        const localRows = [] as OutreachAccount[]
        trackOutreachActionSucceeded({
          action: 'list_accounts',
          workspace_id: workspaceId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachAccount[]
    trackOutreachActionSucceeded({
      action: 'list_accounts',
      workspace_id: workspaceId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_accounts',
      error,
      workspace_id: workspaceId,
    })
    throw error
  }
}

export const createOutreachAccount = async (payload: CreateOutreachAccountInput): Promise<OutreachAccount> => {
  const displayName = payload.displayName.trim()
  if (!displayName) {
    throw new Error('Nome da conta é obrigatório.')
  }

  assertOutreachPersistenceAvailable('create_outreach_account', {
    workspaceId: payload.workspaceId,
  })

  if (!supabase) {
    const localAccount = localOutreachAccount({ ...payload, displayName })
    localAccountStore.push(localAccount)
    logOutreachStructure('create_outreach_account_local', { workspaceId: payload.workspaceId, accountId: localAccount.id })
    return localAccount
  }

  const { data, error } = await supabase
    .from(outreachAccountsTable)
    .insert({
      workspace_id: payload.workspaceId,
      display_name: displayName,
      timezone: payload.timezone ?? null,
      start_time: payload.startTime ?? null,
      end_time: payload.endTime ?? null,
      active_days: payload.activeDays ?? null,
    })
    .select('*')
    .single()

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('create_outreach_account', {
        workspaceId: payload.workspaceId,
      })
      const localAccount = localOutreachAccount({ ...payload, displayName })
      localAccountStore.push(localAccount)
      logOutreachStructure('create_outreach_account_table_missing', { workspaceId: payload.workspaceId, accountId: localAccount.id })
      return localAccount
    }
    throw error
  }

  logOutreachStructure('create_outreach_account', { workspaceId: payload.workspaceId, accountId: data.id })
  return data as OutreachAccount
}

export const updateOutreachAccount = async (
  accountId: string,
  payload: UpdateOutreachAccountInput,
  workspaceId?: string,
): Promise<OutreachAccount> => {
  assertOutreachPersistenceAvailable('update_outreach_account', { accountId, workspaceId: workspaceId ?? null })

  try {
    const scopedWorkspaceId = await resolveAccountWorkspaceScope(accountId, workspaceId)

    if (!supabase) {
      const index = localAccountStore.findIndex(
        (account) => account.id === accountId && account.workspace_id === scopedWorkspaceId,
      )
      if (index < 0) {
        throwOutreachBackendUnavailable('update_outreach_account', { accountId, workspaceId: scopedWorkspaceId })
      }

      const current = localAccountStore[index] as OutreachAccount
      const updated: OutreachAccount = {
        ...current,
        ...payload,
        updated_at: nowIso(),
      }
      localAccountStore[index] = updated
      return updated
    }

    const { data, error } = await supabase
      .from(outreachAccountsTable)
      .update(payload)
      .eq('id', accountId)
      .eq('workspace_id', scopedWorkspaceId)
      .select('*')
      .single()

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('update_outreach_account', { accountId, workspaceId: scopedWorkspaceId })
      }
      throw error
    }

    logOutreachStructure('update_outreach_account', { accountId, workspaceId: scopedWorkspaceId })
    return data as OutreachAccount
  } catch (error) {
    trackOutreachActionFailed({
      action: 'update_account',
      error,
      workspace_id: workspaceId,
      account_id: accountId,
      safe_context: {
        has_workspace: Boolean(workspaceId?.trim()),
      },
    })
    throw error
  }
}

export const listOutreachCampaigns = async (workspaceId: string): Promise<OutreachCampaign[]> => {
  trackOutreachActionStarted({
    action: 'list_campaigns',
    workspace_id: workspaceId,
  })

  try {
    assertOutreachReadAvailable('list_outreach_campaigns', { workspaceId })

    if (!supabase) {
      const localRows = localCampaignStore
        .filter((campaign) => campaign.workspace_id === workspaceId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
      trackOutreachActionSucceeded({
        action: 'list_campaigns',
        workspace_id: workspaceId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachCampaignsTable)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_outreach_campaigns', { workspaceId })
        logOutreachStructure('list_outreach_campaigns_table_missing', { workspaceId })
        const localRows = [] as OutreachCampaign[]
        trackOutreachActionSucceeded({
          action: 'list_campaigns',
          workspace_id: workspaceId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachCampaign[]
    trackOutreachActionSucceeded({
      action: 'list_campaigns',
      workspace_id: workspaceId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_campaigns',
      error,
      workspace_id: workspaceId,
    })
    throw error
  }
}

export const createOutreachCampaign = async (payload: CreateOutreachCampaignInput): Promise<OutreachCampaign> => {
  const name = payload.name.trim()
  const baseMessage = payload.baseMessage.trim()

  if (!name || !baseMessage) {
    throw new Error('Nome e mensagem base são obrigatórios.')
  }

  assertOutreachPersistenceAvailable('create_outreach_campaign', {
    workspaceId: payload.workspaceId,
  })

  if (!supabase) {
    const localCampaign = localOutreachCampaign({ ...payload, name, baseMessage })
    localCampaignStore.unshift(localCampaign)
    logOutreachStructure('create_outreach_campaign_local', { workspaceId: payload.workspaceId, campaignId: localCampaign.id })
    return localCampaign
  }

  const { data, error } = await supabase
    .from(outreachCampaignsTable)
    .insert({
      workspace_id: payload.workspaceId,
      name,
      objective: payload.objective ?? null,
      base_message: baseMessage,
    })
    .select('*')
    .single()

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('create_outreach_campaign', {
        workspaceId: payload.workspaceId,
      })
      const localCampaign = localOutreachCampaign({ ...payload, name, baseMessage })
      localCampaignStore.unshift(localCampaign)
      logOutreachStructure('create_outreach_campaign_table_missing', { workspaceId: payload.workspaceId, campaignId: localCampaign.id })
      return localCampaign
    }
    throw error
  }

  logOutreachStructure('create_outreach_campaign', { workspaceId: payload.workspaceId, campaignId: data.id })
  return data as OutreachCampaign
}

export const createIndependentAccountCampaign = async (
  payload: CreateIndependentAccountCampaignInput,
): Promise<OutreachAccountCampaign> => {
  trackOutreachActionStarted({
    action: 'create_account_campaign',
    workspace_id: payload.workspaceId,
    account_id: payload.accountId,
    campaign_id: payload.campaignId,
  })

  const row = {
    workspace_id: payload.workspaceId,
    account_id: payload.accountId,
    campaign_id: payload.campaignId,
    independent_seed: `seed_${crypto.randomUUID()}`,
    warmup_profile: payload.warmupProfile ?? null,
  }

  assertOutreachPersistenceAvailable('create_independent_account_campaign', {
    workspaceId: payload.workspaceId,
    accountId: payload.accountId,
    campaignId: payload.campaignId,
  })

  if (!supabase) {
    const localRow = localOutreachAccountCampaign(payload)
    localAccountCampaignStore.unshift(localRow)
    logOutreachStructure('create_independent_account_campaign_local', {
      workspaceId: payload.workspaceId,
      accountId: payload.accountId,
      campaignId: payload.campaignId,
      accountCampaignId: localRow.id,
    })
    trackOutreachActionSucceeded({
      action: 'create_account_campaign',
      workspace_id: payload.workspaceId,
      account_id: payload.accountId,
      campaign_id: payload.campaignId,
      account_campaign_id: localRow.id,
      safe_context: {
        persistence_mode: 'local_fallback',
      },
    })
    return localRow
  }

  const { data, error } = await supabase.from(outreachAccountCampaignsTable).insert(row).select('*').single()
  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('create_independent_account_campaign', {
        workspaceId: payload.workspaceId,
        accountId: payload.accountId,
        campaignId: payload.campaignId,
      })
      const localRow = localOutreachAccountCampaign(payload)
      localAccountCampaignStore.unshift(localRow)
      logOutreachStructure('create_independent_account_campaign_table_missing', {
        workspaceId: payload.workspaceId,
        accountId: payload.accountId,
        campaignId: payload.campaignId,
        accountCampaignId: localRow.id,
      })
      trackOutreachActionSucceeded({
        action: 'create_account_campaign',
        workspace_id: payload.workspaceId,
        account_id: payload.accountId,
        campaign_id: payload.campaignId,
        account_campaign_id: localRow.id,
        safe_context: {
          persistence_mode: 'table_missing_local_fallback',
        },
      })
      return localRow
    }
    const normalizedError = normalizeOutreachError(error, 'DUPLICATE_ACTIVE_ACCOUNT_CAMPAIGN')
    trackOutreachActionFailed({
      action: 'create_account_campaign',
      error: normalizedError,
      workspace_id: payload.workspaceId,
      account_id: payload.accountId,
      campaign_id: payload.campaignId,
    })
    throw normalizedError
  }

  logOutreachStructure('create_independent_account_campaign', {
    workspaceId: payload.workspaceId,
    accountId: payload.accountId,
    campaignId: payload.campaignId,
    accountCampaignId: data.id,
  })
  trackOutreachActionSucceeded({
    action: 'create_account_campaign',
    workspace_id: payload.workspaceId,
    account_id: payload.accountId,
    campaign_id: payload.campaignId,
    account_campaign_id: data.id,
  })
  return data as OutreachAccountCampaign
}

export const attachCampaignToAccounts = async (campaignId: string, accountIds: string[]): Promise<OutreachAccountCampaign[]> => {
  if (accountIds.length === 0) {
    return []
  }

  if (!supabase && !shouldAllowOutreachLocalFallback()) {
    throwOutreachBackendUnavailable('attach_campaign_to_accounts', { campaignId })
  }

  let workspaceId = 'local-workspace'
  if (supabase) {
    const { data, error } = await supabase.from(outreachCampaignsTable).select('workspace_id').eq('id', campaignId).maybeSingle()
    if (error && !isTableMissingError(error)) {
      throw error
    }
    workspaceId = typeof data?.workspace_id === 'string' ? data.workspace_id : workspaceId
  }

  const results: OutreachAccountCampaign[] = []
  for (const accountId of accountIds) {
    const created = await createIndependentAccountCampaign({ workspaceId, accountId, campaignId })
    results.push(created)
  }

  logOutreachStructure('attach_campaign_to_accounts', { campaignId, workspaceId, accountCount: accountIds.length })
  return results
}

export const generateMessageVariants = async (baseMessage: string, tone: string): Promise<string[]> => {
  const normalized = baseMessage.trim()
  if (!normalized) {
    throw new Error('Mensagem principal é obrigatória para gerar variações.')
  }

  const toneLabel = tone.trim() || 'consultivo'
  const variants = [
    `Oi! Tudo bem? ${normalized}`,
    `Olá! Estou entrando em contato porque ${normalized}`,
    `Passando aqui de forma direta (${toneLabel}): ${normalized}`,
    `Mensagem curta para você (${toneLabel}): ${normalized}`,
  ]

  logOutreachStructure('generate_message_variants_placeholder', {
    variantCount: variants.length,
    tone: toneLabel,
    mode: 'placeholder_tecnico',
  })

  return variants
}

export const persistMessageVariants = async (
  accountCampaignId: string,
  payload: { workspaceId: string; baseMessage: string; variants: string[] },
): Promise<OutreachMessageVariant[]> => {
  trackOutreachActionStarted({
    action: 'persist_variants',
    workspace_id: payload.workspaceId,
    account_campaign_id: accountCampaignId,
  })

  assertOutreachPersistenceAvailable('persist_message_variants', {
    workspaceId: payload.workspaceId,
    accountCampaignId,
  })

  const baseMessage = payload.baseMessage.trim()
  if (!baseMessage) {
    throw new Error('Mensagem base é obrigatória para persistir variações.')
  }

  const normalizedVariants = payload.variants
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, 4)

  const rows = [
    {
      workspace_id: payload.workspaceId,
      account_campaign_id: accountCampaignId,
      variant_index: 0,
      content: baseMessage,
      source: 'user' as const,
      is_base: true,
    },
    ...normalizedVariants.map((content, index) => ({
      workspace_id: payload.workspaceId,
      account_campaign_id: accountCampaignId,
      variant_index: index + 1,
      content,
      source: 'placeholder' as const,
      is_base: false,
    })),
  ]

  if (!supabase) {
    const createdAt = nowIso()
    const localRows = rows.map((row) => ({
      id: crypto.randomUUID(),
      workspace_id: row.workspace_id,
      account_campaign_id: row.account_campaign_id,
      variant_index: row.variant_index,
      content: row.content,
      source: row.source,
      is_base: row.is_base,
      created_at: createdAt,
    })) as OutreachMessageVariant[]
    localMessageVariantStore.unshift(...localRows)
    trackOutreachActionSucceeded({
      action: 'persist_variants',
      workspace_id: payload.workspaceId,
      account_campaign_id: accountCampaignId,
      safe_context: {
        variant_count: localRows.length,
        persistence_mode: 'local_fallback',
      },
    })
    return localRows
  }

  const { data, error } = await supabase
    .from(outreachMessageVariantsTable)
    .insert(rows)
    .select('*')
    .order('variant_index', { ascending: true })

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('persist_message_variants', {
        workspaceId: payload.workspaceId,
        accountCampaignId,
      })
      const createdAt = nowIso()
      const localRows = rows.map((row) => ({
        id: crypto.randomUUID(),
        workspace_id: row.workspace_id,
        account_campaign_id: row.account_campaign_id,
        variant_index: row.variant_index,
        content: row.content,
        source: row.source,
        is_base: row.is_base,
        created_at: createdAt,
      })) as OutreachMessageVariant[]
      localMessageVariantStore.unshift(...localRows)
      trackOutreachActionSucceeded({
        action: 'persist_variants',
        workspace_id: payload.workspaceId,
        account_campaign_id: accountCampaignId,
        safe_context: {
          variant_count: localRows.length,
          persistence_mode: 'table_missing_local_fallback',
        },
      })
      return localRows
    }
    const normalizedError = normalizeOutreachError(error, 'DUPLICATE_VARIANT_INDEX')
    trackOutreachActionFailed({
      action: 'persist_variants',
      error: normalizedError,
      workspace_id: payload.workspaceId,
      account_campaign_id: accountCampaignId,
    })
    throw normalizedError
  }

  const variants = (data ?? []) as OutreachMessageVariant[]
  trackOutreachActionSucceeded({
    action: 'persist_variants',
    workspace_id: payload.workspaceId,
    account_campaign_id: accountCampaignId,
    safe_context: {
      variant_count: variants.length,
      persistence_mode: 'supabase',
    },
  })

  return variants
}

export const listMessageVariantsByAccountCampaign = async (accountCampaignId: string): Promise<OutreachMessageVariant[]> => {
  trackOutreachActionStarted({
    action: 'list_message_variants',
    account_campaign_id: accountCampaignId,
  })

  try {
    assertOutreachReadAvailable('list_message_variants_by_account_campaign', { accountCampaignId })

    if (!supabase) {
      const localRows = localMessageVariantStore
        .filter((variant) => variant.account_campaign_id === accountCampaignId)
        .sort((left, right) => left.variant_index - right.variant_index)
      trackOutreachActionSucceeded({
        action: 'list_message_variants',
        account_campaign_id: accountCampaignId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachMessageVariantsTable)
      .select('*')
      .eq('account_campaign_id', accountCampaignId)
      .order('variant_index', { ascending: true })

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_message_variants_by_account_campaign', { accountCampaignId })
        const localRows = localMessageVariantStore
          .filter((variant) => variant.account_campaign_id === accountCampaignId)
          .sort((left, right) => left.variant_index - right.variant_index)
        trackOutreachActionSucceeded({
          action: 'list_message_variants',
          account_campaign_id: accountCampaignId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_local_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachMessageVariant[]
    trackOutreachActionSucceeded({
      action: 'list_message_variants',
      account_campaign_id: accountCampaignId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_message_variants',
      error,
      account_campaign_id: accountCampaignId,
    })
    throw error
  }
}

const listMessageVariantsByAccountCampaignBatch = async (
  accountCampaignIds: string[],
): Promise<Map<string, OutreachMessageVariant[]>> => {
  const uniqueIds = [...new Set(accountCampaignIds.filter((id) => id.trim().length > 0))]
  if (uniqueIds.length === 0) {
    return new Map()
  }

  assertOutreachReadAvailable('list_message_variants_by_account_campaign_batch', {
    executionCount: uniqueIds.length,
  })

  const groupRowsByExecution = (rows: OutreachMessageVariant[]) => {
    const map = new Map<string, OutreachMessageVariant[]>()
    for (const row of rows) {
      const current = map.get(row.account_campaign_id) ?? []
      current.push(row)
      map.set(row.account_campaign_id, current)
    }

    for (const [key, items] of map.entries()) {
      map.set(key, items.sort((left, right) => left.variant_index - right.variant_index))
    }
    return map
  }

  if (!supabase) {
    const rows = localMessageVariantStore.filter((variant) => uniqueIds.includes(variant.account_campaign_id))
    return groupRowsByExecution(rows)
  }

  const { data, error } = await supabase
    .from(outreachMessageVariantsTable)
    .select('*')
    .in('account_campaign_id', uniqueIds)
    .order('variant_index', { ascending: true })

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('list_message_variants_by_account_campaign_batch', {
        executionCount: uniqueIds.length,
      })
      const rows = localMessageVariantStore.filter((variant) => uniqueIds.includes(variant.account_campaign_id))
      return groupRowsByExecution(rows)
    }
    throw error
  }

  return groupRowsByExecution((data ?? []) as OutreachMessageVariant[])
}

const resolveAccountsForCampaign = async (workspaceId: string, accountIds: string[]): Promise<Map<string, OutreachAccount>> => {
  const uniqueIds = [...new Set(accountIds)]
  if (uniqueIds.length === 0) {
    return new Map()
  }

  if (!supabase) {
    const accounts = await listOutreachAccounts(workspaceId)
    const map = new Map(accounts.map((account) => [account.id, account]))
    return new Map(uniqueIds.map((id) => [id, map.get(id)]).filter((entry): entry is [string, OutreachAccount] => Boolean(entry[1])))
  }

  const { data, error } = await supabase
    .from(outreachAccountsTable)
    .select('*')
    .eq('workspace_id', workspaceId)
    .in('id', uniqueIds)

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('resolve_accounts_for_campaign', {
        workspaceId,
        accountCount: uniqueIds.length,
      })
      const accounts = await listOutreachAccounts(workspaceId)
      const map = new Map(accounts.map((account) => [account.id, account]))
      return new Map(uniqueIds.map((id) => [id, map.get(id)]).filter((entry): entry is [string, OutreachAccount] => Boolean(entry[1])))
    }
    throw error
  }

  const map = new Map<string, OutreachAccount>()
  for (const account of (data ?? []) as OutreachAccount[]) {
    map.set(account.id, account)
  }
  return map
}

type ListCampaignExecutionsOptions = {
  preloadedAccounts?: OutreachAccount[]
  preloadedAccountCampaigns?: OutreachAccountCampaign[]
  preloadedCampaigns?: OutreachCampaign[]
}

export const listCampaignExecutions = async (
  workspaceId: string,
  options?: ListCampaignExecutionsOptions,
): Promise<CampaignExecutionSummary[]> => {
  trackOutreachActionStarted({
    action: 'list_campaign_executions',
    workspace_id: workspaceId,
  })

  try {
    const reusedAccounts = Array.isArray(options?.preloadedAccounts)
    const reusedAccountCampaigns = Array.isArray(options?.preloadedAccountCampaigns)
    const reusedCampaigns = Array.isArray(options?.preloadedCampaigns)

    const [accountCampaigns, accounts] = await Promise.all([
      reusedAccountCampaigns
        ? Promise.resolve(options?.preloadedAccountCampaigns ?? [])
        : listOutreachAccountCampaigns(workspaceId),
      reusedAccounts
        ? Promise.resolve(options?.preloadedAccounts ?? [])
        : listOutreachAccounts(workspaceId),
    ])
    const accountLookup = new Map(accounts.map((account) => [account.id, account]))
    const executionIds = accountCampaigns.map((execution) => execution.id)
    const variantsByExecution = await listMessageVariantsByAccountCampaignBatch(executionIds)

    const result: CampaignExecutionSummary[] = []
    for (const execution of accountCampaigns) {
      const variants = variantsByExecution.get(execution.id) ?? []
      result.push({
        workspaceId: execution.workspace_id,
        campaignId: execution.campaign_id,
        accountCampaignId: execution.id,
        accountId: execution.account_id,
        accountDisplayName: accountLookup.get(execution.account_id)?.display_name ?? null,
        status: execution.status,
        independentSeed: execution.independent_seed,
        createdAt: execution.created_at,
        totalVariants: variants.length,
        variants: variants.map(mapVariantPreview),
        note: 'Esta execução possui ritmo, histórico, fila e variações próprias.',
      })
    }

    const rows = result.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const variantsCount = rows.reduce((total, execution) => total + execution.totalVariants, 0)
    trackOutreachActionSucceeded({
      action: 'list_campaign_executions',
      workspace_id: workspaceId,
      safe_context: {
        count: rows.length,
        execution_count: rows.length,
        variants_count: variantsCount,
        batch_mode: true,
        reused_accounts: reusedAccounts,
        reused_account_campaigns: reusedAccountCampaigns,
        reused_campaigns: reusedCampaigns,
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_campaign_executions',
      error,
      workspace_id: workspaceId,
    })
    throw error
  }
}

export const normalizePhoneNumber = (phoneNumber: string): string => {
  const cleaned = phoneNumber.replace(/[^\d]/g, '')
  if (!cleaned) {
    throw new Error('Telefone obrigatório.')
  }
  if (!/^\d+$/.test(cleaned)) {
    throw new Error('Telefone inválido: somente números são aceitos após normalização.')
  }
  if (cleaned.length < 10 || cleaned.length > 15) {
    throw new Error('Telefone inválido: tamanho mínimo de 10 e máximo de 15 dígitos.')
  }
  return cleaned
}

const ensureExecutionScope = async (workspaceId: string, accountCampaignId: string): Promise<OutreachAccountCampaign | null> => {
  assertOutreachPersistenceAvailable('ensure_execution_scope', {
    workspaceId,
    accountCampaignId,
  })

  if (!supabase) {
    const localExecution = localAccountCampaignStore.find(
      (execution) => execution.workspace_id === workspaceId && execution.id === accountCampaignId,
    )
    return localExecution ?? null
  }

  const { data, error } = await supabase
    .from(outreachAccountCampaignsTable)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', accountCampaignId)
    .maybeSingle<OutreachAccountCampaign>()

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('ensure_execution_scope', {
        workspaceId,
        accountCampaignId,
      })
      const localExecution = localAccountCampaignStore.find(
        (execution) => execution.workspace_id === workspaceId && execution.id === accountCampaignId,
      )
      return localExecution ?? null
    }
    throw error
  }

  return data ?? null
}

const findActiveDuplicateRecipient = async (
  workspaceId: string,
  accountCampaignId: string,
  normalizedPhoneNumber: string,
): Promise<OutreachRecipient | null> => {
  assertOutreachPersistenceAvailable('find_active_duplicate_recipient', {
    workspaceId,
    accountCampaignId,
  })

  if (!supabase) {
    return localRecipientStore.find(
      (recipient) =>
        recipient.workspace_id === workspaceId &&
        recipient.account_campaign_id === accountCampaignId &&
        recipient.phone_number === normalizedPhoneNumber &&
        activeRecipientStatuses.includes(recipient.status),
    ) ?? null
  }

  const { data, error } = await supabase
    .from(outreachRecipientsTable)
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('account_campaign_id', accountCampaignId)
    .eq('phone_number', normalizedPhoneNumber)
    .in('status', activeRecipientStatuses)
    .limit(1)
    .maybeSingle<OutreachRecipient>()

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('find_active_duplicate_recipient', {
        workspaceId,
        accountCampaignId,
      })
      return localRecipientStore.find(
        (recipient) =>
          recipient.workspace_id === workspaceId &&
          recipient.account_campaign_id === accountCampaignId &&
          recipient.phone_number === normalizedPhoneNumber &&
          activeRecipientStatuses.includes(recipient.status),
      ) ?? null
    }
    throw error
  }

  return data ?? null
}

export const addRecipientToAccountCampaign = async (payload: OutreachRecipientInput): Promise<OutreachRecipient> => {
  const workspaceId = payload.workspaceId.trim()
  const accountCampaignId = payload.accountCampaignId.trim()
  const maskedPhone = maskPhoneNumber(payload.phoneNumber)

  trackOutreachActionStarted({
    action: 'add_recipient',
    workspace_id: workspaceId || undefined,
    account_campaign_id: accountCampaignId || undefined,
    safe_context: {
      phone_masked: maskedPhone,
    },
  })

  const normalizedPhoneNumber = normalizePhoneNumber(payload.phoneNumber)

  if (!workspaceId) {
    throw new Error('workspace_id é obrigatório para cadastrar destinatário.')
  }
  if (!accountCampaignId) {
    throw new Error('account_campaign_id é obrigatório para cadastrar destinatário.')
  }

  assertOutreachPersistenceAvailable('add_recipient_to_account_campaign', {
    workspaceId,
    accountCampaignId,
  })

  const execution = await ensureExecutionScope(workspaceId, accountCampaignId)
  if (!execution) {
    throw new Error('Execução conta+campanha não encontrada para este workspace.')
  }

  const duplicate = await findActiveDuplicateRecipient(workspaceId, accountCampaignId, normalizedPhoneNumber)
  if (duplicate) {
    const domainError = createOutreachDomainError('DUPLICATE_ACTIVE_RECIPIENT', 'Este telefone já está ativo nesta execução.')
    trackOutreachActionFailed({
      action: 'add_recipient',
      error: domainError,
      workspace_id: workspaceId,
      account_campaign_id: accountCampaignId,
      recipient_id: duplicate.id,
      safe_context: {
        phone_masked: maskPhoneNumber(normalizedPhoneNumber),
      },
    })
    throw domainError
  }

  const row = {
    workspace_id: workspaceId,
    account_campaign_id: accountCampaignId,
    lead_id: payload.leadId ?? null,
    contact_name: payload.contactName?.trim() || null,
    phone_number: normalizedPhoneNumber,
    status: payload.status ?? 'queued',
  }

  if (!supabase) {
    const localRecipient: OutreachRecipient = {
      id: crypto.randomUUID(),
      workspace_id: row.workspace_id,
      account_campaign_id: row.account_campaign_id,
      lead_id: row.lead_id,
      contact_name: row.contact_name,
      phone_number: row.phone_number,
      status: row.status,
      last_message_at: null,
      replied_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    localRecipientStore.unshift(localRecipient)
    logOutreachStructure('add_recipient_local', {
      workspaceId,
      accountCampaignId,
      recipientId: localRecipient.id,
    })
    trackOutreachActionSucceeded({
      action: 'add_recipient',
      workspace_id: workspaceId,
      account_campaign_id: accountCampaignId,
      recipient_id: localRecipient.id,
      safe_context: {
        phone_masked: maskPhoneNumber(normalizedPhoneNumber),
        persistence_mode: 'local_fallback',
      },
    })
    return localRecipient
  }

  const { data, error } = await supabase.from(outreachRecipientsTable).insert(row).select('*').single()
  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('add_recipient_to_account_campaign', {
        workspaceId,
        accountCampaignId,
      })
      const localRecipient: OutreachRecipient = {
        id: crypto.randomUUID(),
        workspace_id: row.workspace_id,
        account_campaign_id: row.account_campaign_id,
        lead_id: row.lead_id,
        contact_name: row.contact_name,
        phone_number: row.phone_number,
        status: row.status,
        last_message_at: null,
        replied_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      }
      localRecipientStore.unshift(localRecipient)
      trackOutreachActionSucceeded({
        action: 'add_recipient',
        workspace_id: workspaceId,
        account_campaign_id: accountCampaignId,
        recipient_id: localRecipient.id,
        safe_context: {
          phone_masked: maskPhoneNumber(normalizedPhoneNumber),
          persistence_mode: 'table_missing_local_fallback',
        },
      })
      return localRecipient
    }
    const normalizedError = normalizeOutreachError(error, 'DUPLICATE_ACTIVE_RECIPIENT')
    trackOutreachActionFailed({
      action: 'add_recipient',
      error: normalizedError,
      workspace_id: workspaceId,
      account_campaign_id: accountCampaignId,
      safe_context: {
        phone_masked: maskPhoneNumber(normalizedPhoneNumber),
      },
    })
    throw normalizedError
  }

  logOutreachStructure('add_recipient', {
    workspaceId,
    accountCampaignId,
    recipientId: data.id,
  })
  trackOutreachActionSucceeded({
    action: 'add_recipient',
    workspace_id: workspaceId,
    account_campaign_id: accountCampaignId,
    recipient_id: data.id,
    safe_context: {
      phone_masked: maskPhoneNumber(normalizedPhoneNumber),
      persistence_mode: 'supabase',
    },
  })
  return data as OutreachRecipient
}

export const parseRecipientsFromText = (inputText: string): RecipientImportPreview => {
  const lines = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const rows: RecipientImportRow[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const parsed = parseRecipientLine(raw)
    let normalizedPhoneNumber: string | null = null
    let reason: string | null = null

    try {
      normalizedPhoneNumber = normalizePhoneNumber(parsed.phoneCandidate)
    } catch (error) {
      reason = error instanceof Error ? error.message : 'Telefone inválido.'
    }

    rows.push(
      mapRecipientImportRow(
        index + 1,
        raw,
        parsed.contactName,
        parsed.phoneCandidate,
        normalizedPhoneNumber,
        reason,
      ),
    )
  }

  const seen = new Set<string>()
  let duplicatesInBatch = 0
  const normalizedRows = rows.map((row) => ({ ...row }))
  for (let index = 0; index < normalizedRows.length; index += 1) {
    const row = normalizedRows[index]
    if (!row.isValid || !row.normalizedPhoneNumber) {
      continue
    }

    if (seen.has(row.normalizedPhoneNumber)) {
      normalizedRows[index] = {
        ...row,
        isValid: false,
        reason: 'Duplicado dentro do mesmo lote.',
      }
      duplicatesInBatch += 1
      continue
    }
    seen.add(row.normalizedPhoneNumber)
  }

  const valid = normalizedRows.filter((row) => row.isValid).length
  const invalid = normalizedRows.length - valid

  return {
    rows: normalizedRows,
    totalReceived: normalizedRows.length,
    valid,
    invalid,
    duplicatesInBatch,
  }
}

export const bulkAddRecipientsToAccountCampaign = async (payload: BulkRecipientInput): Promise<BulkRecipientResult> => {
  const workspaceId = payload.workspaceId.trim()
  const accountCampaignId = payload.accountCampaignId.trim()

  trackOutreachActionStarted({
    action: 'bulk_add_recipients',
    workspace_id: workspaceId || undefined,
    account_campaign_id: accountCampaignId || undefined,
  })

  try {
    if (!workspaceId || !accountCampaignId) {
      throw new Error('workspace_id e account_campaign_id são obrigatórios para importação.')
    }

    const execution = await ensureExecutionScope(workspaceId, accountCampaignId)
    if (!execution) {
      throw new Error('Execução conta+campanha não encontrada para esta importação.')
    }

    const preview = parseRecipientsFromText(payload.inputText)
    const rows = preview.rows
    let duplicatesInExecution = 0
    let imported = 0
    let ignored = 0
    const recipients: OutreachRecipient[] = []

    for (const row of rows) {
      if (!row.isValid || !row.normalizedPhoneNumber) {
        ignored += 1
        continue
      }

      try {
        const created = await addRecipientToAccountCampaign({
          workspaceId,
          accountCampaignId,
          contactName: row.contactName,
          phoneNumber: row.normalizedPhoneNumber,
        })
        recipients.push(created)
        imported += 1
      } catch (error) {
        const normalizedError = normalizeOutreachError(error)
        if (normalizedError.code === 'DUPLICATE_ACTIVE_RECIPIENT') {
          duplicatesInExecution += 1
        }
        trackOutreachActionFailed({
          action: 'add_recipient',
          error: normalizedError,
          workspace_id: workspaceId,
          account_campaign_id: accountCampaignId,
          safe_context: {
            import_line: row.lineNumber,
            phone_masked: maskPhoneNumber(row.normalizedPhoneNumber),
          },
        })
        ignored += 1
      }
    }

    logOutreachStructure('bulk_add_recipients', {
      workspaceId,
      accountCampaignId,
      totalReceived: preview.totalReceived,
      valid: preview.valid,
      invalid: preview.invalid,
      duplicatesInBatch: preview.duplicatesInBatch,
      duplicatesInExecution,
      imported,
      ignored,
    })

    trackOutreachActionSucceeded({
      action: 'bulk_add_recipients',
      workspace_id: workspaceId,
      account_campaign_id: accountCampaignId,
      safe_context: {
        total_received: preview.totalReceived,
        valid: preview.valid,
        invalid: preview.invalid,
        duplicates_in_batch: preview.duplicatesInBatch,
        duplicates_in_execution: duplicatesInExecution,
        imported,
        ignored,
      },
    })

    return {
      accountCampaignId,
      totalReceived: preview.totalReceived,
      valid: preview.valid,
      invalid: preview.invalid,
      duplicatesInBatch: preview.duplicatesInBatch,
      duplicatesInExecution,
      imported,
      ignored,
      rows,
      recipients,
    }
  } catch (error) {
    trackOutreachActionFailed({
      action: 'bulk_add_recipients',
      error,
      workspace_id: workspaceId || undefined,
      account_campaign_id: accountCampaignId || undefined,
    })
    throw error
  }
}

export const listRecipientsByAccountCampaign = async (accountCampaignId: string): Promise<OutreachRecipient[]> => {
  trackOutreachActionStarted({
    action: 'list_recipients',
    account_campaign_id: accountCampaignId,
  })

  try {
    assertOutreachReadAvailable('list_recipients_by_account_campaign', { accountCampaignId })

    if (!supabase) {
      const localRows = localRecipientStore
        .filter((recipient) => recipient.account_campaign_id === accountCampaignId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
      trackOutreachActionSucceeded({
        action: 'list_recipients',
        account_campaign_id: accountCampaignId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachRecipientsTable)
      .select('*')
      .eq('account_campaign_id', accountCampaignId)
      .order('created_at', { ascending: false })

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_recipients_by_account_campaign', { accountCampaignId })
        const localRows = localRecipientStore
          .filter((recipient) => recipient.account_campaign_id === accountCampaignId)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
        trackOutreachActionSucceeded({
          action: 'list_recipients',
          account_campaign_id: accountCampaignId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_local_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachRecipient[]
    trackOutreachActionSucceeded({
      action: 'list_recipients',
      account_campaign_id: accountCampaignId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_recipients',
      error,
      account_campaign_id: accountCampaignId,
    })
    throw error
  }
}

export const listRecipientsByAccountCampaignPaginated = async (
  params: ListRecipientsByAccountCampaignPaginatedParams,
): Promise<ListRecipientsByAccountCampaignPaginatedResult> => {
  const accountCampaignId = params.accountCampaignId.trim()
  const requestedPage = Number.isFinite(params.page) ? Math.max(1, Math.floor(params.page)) : 1
  const requestedPageSize = Number.isFinite(params.pageSize) ? Math.max(1, Math.floor(params.pageSize)) : 25
  const pageSize = Math.min(100, requestedPageSize)
  const normalizedStatusParam = String(params.status ?? '').trim().toLocaleLowerCase('pt-BR')
  const status = normalizedStatusParam === 'all' ? undefined : params.status
  const search = params.search?.trim() ?? ''
  const searchLower = search.toLocaleLowerCase('pt-BR')
  const hasStatusFilter = Boolean(status)
  const hasSearchFilter = search.length > 0
  const isFiltered = hasStatusFilter || hasSearchFilter

  trackOutreachActionStarted({
    action: 'list_recipients',
    account_campaign_id: accountCampaignId,
    safe_context: {
      paginated: true,
      filtered: isFiltered,
      status: status ?? 'all',
      has_search: hasSearchFilter,
      search_length: search.length,
      page: requestedPage,
      page_size: pageSize,
    },
  })

  const buildResult = (rows: OutreachRecipient[], total: number): ListRecipientsByAccountCampaignPaginatedResult => {
    const safeTotal = Math.max(0, total)
    const totalPages = safeTotal === 0 ? 1 : Math.max(1, Math.ceil(safeTotal / pageSize))
    const page = Math.min(requestedPage, totalPages)
    const start = (page - 1) * pageSize
    const items = rows.slice(start, start + pageSize)
    return {
      items,
      total: safeTotal,
      page,
      pageSize,
      totalPages,
    }
  }

  try {
    assertOutreachReadAvailable('list_recipients_by_account_campaign_paginated', {
      accountCampaignId,
      page: requestedPage,
      pageSize,
    })

    if (!supabase) {
      const filteredRows = localRecipientStore
        .filter((recipient) => recipient.account_campaign_id === accountCampaignId)
        .filter((recipient) => (status ? recipient.status === status : true))
        .filter((recipient) => {
          if (!searchLower) {
            return true
          }
          const contactName = recipient.contact_name?.toLocaleLowerCase('pt-BR') ?? ''
          const phone = recipient.phone_number.toLocaleLowerCase('pt-BR')
          return contactName.includes(searchLower) || phone.includes(searchLower)
        })
        .sort((left, right) => right.created_at.localeCompare(left.created_at))

      const result = buildResult(filteredRows, filteredRows.length)
      trackOutreachActionSucceeded({
        action: 'list_recipients',
        account_campaign_id: accountCampaignId,
        safe_context: {
          paginated: true,
          filtered: isFiltered,
          status: status ?? 'all',
          has_search: hasSearchFilter,
          search_length: search.length,
          page: result.page,
          page_size: result.pageSize,
          total: result.total,
          recipients_count: result.items.length,
          source: 'local_fallback',
        },
      })
      return result
    }

    let query = supabase
      .from(outreachRecipientsTable)
      .select('*', { count: 'exact' })
      .eq('account_campaign_id', accountCampaignId)

    if (status) {
      query = query.eq('status', status)
    }

    if (search) {
      const sanitizedSearch = search.replace(/[,%_]/g, ' ').trim()
      if (sanitizedSearch) {
        query = query.or(`contact_name.ilike.%${sanitizedSearch}%,phone_number.ilike.%${sanitizedSearch}%`)
      }
    }

    const from = (requestedPage - 1) * pageSize
    const to = from + pageSize - 1
    const { data, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to)

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_recipients_by_account_campaign_paginated', {
          accountCampaignId,
          page: requestedPage,
          pageSize,
        })
        const filteredRows = localRecipientStore
          .filter((recipient) => recipient.account_campaign_id === accountCampaignId)
          .filter((recipient) => (status ? recipient.status === status : true))
          .filter((recipient) => {
            if (!searchLower) {
              return true
            }
            const contactName = recipient.contact_name?.toLocaleLowerCase('pt-BR') ?? ''
            const phone = recipient.phone_number.toLocaleLowerCase('pt-BR')
            return contactName.includes(searchLower) || phone.includes(searchLower)
          })
          .sort((left, right) => right.created_at.localeCompare(left.created_at))

        const result = buildResult(filteredRows, filteredRows.length)
        trackOutreachActionSucceeded({
          action: 'list_recipients',
          account_campaign_id: accountCampaignId,
          safe_context: {
            paginated: true,
            filtered: isFiltered,
            status: status ?? 'all',
            has_search: hasSearchFilter,
            search_length: search.length,
            page: result.page,
            page_size: result.pageSize,
            total: result.total,
            recipients_count: result.items.length,
            source: 'table_missing_local_fallback',
          },
        })
        return result
      }
      throw error
    }

    const items = (data ?? []) as OutreachRecipient[]
    const total = Math.max(0, count ?? 0)
    const totalPages = total === 0 ? 1 : Math.max(1, Math.ceil(total / pageSize))
    const page = Math.min(requestedPage, totalPages)
    const result: ListRecipientsByAccountCampaignPaginatedResult = {
      items,
      total,
      page,
      pageSize,
      totalPages,
    }
    trackOutreachActionSucceeded({
      action: 'list_recipients',
      account_campaign_id: accountCampaignId,
      safe_context: {
        paginated: true,
        filtered: isFiltered,
        status: status ?? 'all',
        has_search: hasSearchFilter,
        search_length: search.length,
        page: result.page,
        page_size: result.pageSize,
        total: result.total,
        recipients_count: result.items.length,
        source: 'supabase',
      },
    })
    return result
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_recipients',
      error,
      account_campaign_id: accountCampaignId,
      safe_context: {
        paginated: true,
        filtered: isFiltered,
        status: status ?? 'all',
        has_search: hasSearchFilter,
        search_length: search.length,
        page: requestedPage,
        page_size: pageSize,
      },
    })
    throw error
  }
}

export const listRecipientsByWorkspace = async (workspaceId: string): Promise<OutreachRecipient[]> => {
  trackOutreachActionStarted({
    action: 'list_recipients',
    workspace_id: workspaceId,
  })

  try {
    assertOutreachReadAvailable('list_recipients_by_workspace', { workspaceId })

    if (!supabase) {
      const localRows = localRecipientStore
        .filter((recipient) => recipient.workspace_id === workspaceId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
      trackOutreachActionSucceeded({
        action: 'list_recipients',
        workspace_id: workspaceId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachRecipientsTable)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_recipients_by_workspace', { workspaceId })
        const localRows = localRecipientStore
          .filter((recipient) => recipient.workspace_id === workspaceId)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
        trackOutreachActionSucceeded({
          action: 'list_recipients',
          workspace_id: workspaceId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_local_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachRecipient[]
    trackOutreachActionSucceeded({
      action: 'list_recipients',
      workspace_id: workspaceId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_recipients',
      error,
      workspace_id: workspaceId,
    })
    throw error
  }
}

export const removeRecipientFromAccountCampaign = async (
  recipientId: string,
  workspaceId?: string,
): Promise<OutreachRecipient> => {
  if (!recipientId.trim()) {
    throw new Error('recipient_id é obrigatório para remover destinatário.')
  }

  assertOutreachPersistenceAvailable('remove_recipient_from_account_campaign', { recipientId, workspaceId: workspaceId ?? null })

  try {
    const scopedWorkspaceId = await resolveRecipientWorkspaceScope(recipientId, workspaceId)

    if (!supabase) {
      const current = localRecipientStore.find(
        (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
      )
      if (!current) {
        throw new Error('Destinatário não encontrado.')
      }
      const updated: OutreachRecipient = {
        ...current,
        status: 'removed',
        updated_at: nowIso(),
      }
      const index = localRecipientStore.findIndex(
        (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
      )
      if (index >= 0) {
        localRecipientStore[index] = updated
      }
      return updated
    }

    const { data, error } = await supabase
      .from(outreachRecipientsTable)
      .update({ status: 'removed' })
      .eq('id', recipientId)
      .eq('workspace_id', scopedWorkspaceId)
      .select('*')
      .single()

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('remove_recipient_from_account_campaign', { recipientId, workspaceId: scopedWorkspaceId })
        const current = localRecipientStore.find(
          (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
        )
        if (!current) {
          throw new Error('Destinatário não encontrado.')
        }
        const updated: OutreachRecipient = {
          ...current,
          status: 'removed',
          updated_at: nowIso(),
        }
        const index = localRecipientStore.findIndex(
          (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
        )
        if (index >= 0) {
          localRecipientStore[index] = updated
        }
        return updated
      }
      throw error
    }

    return data as OutreachRecipient
  } catch (error) {
    trackOutreachActionFailed({
      action: 'remove_recipient',
      error,
      workspace_id: workspaceId,
      recipient_id: recipientId,
      safe_context: {
        has_workspace: Boolean(workspaceId?.trim()),
      },
    })
    throw error
  }
}

export const updateRecipientStatus = async (
  recipientId: string,
  status: OutreachRecipient['status'],
  workspaceId?: string,
): Promise<OutreachRecipient> => {
  if (!recipientId.trim()) {
    throw new Error('recipient_id é obrigatório para atualizar status.')
  }

  assertOutreachPersistenceAvailable('update_recipient_status', { recipientId, workspaceId: workspaceId ?? null })

  try {
    const scopedWorkspaceId = await resolveRecipientWorkspaceScope(recipientId, workspaceId)

    if (!supabase) {
      const current = localRecipientStore.find(
        (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
      )
      if (!current) {
        throw new Error('Destinatário não encontrado.')
      }
      const updated: OutreachRecipient = {
        ...current,
        status,
        updated_at: nowIso(),
      }
      const index = localRecipientStore.findIndex(
        (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
      )
      if (index >= 0) {
        localRecipientStore[index] = updated
      }
      return updated
    }

    const { data, error } = await supabase
      .from(outreachRecipientsTable)
      .update({ status })
      .eq('id', recipientId)
      .eq('workspace_id', scopedWorkspaceId)
      .select('*')
      .single()

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('update_recipient_status', { recipientId, workspaceId: scopedWorkspaceId })
        const current = localRecipientStore.find(
          (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
        )
        if (!current) {
          throw new Error('Destinatário não encontrado.')
        }
        const updated: OutreachRecipient = {
          ...current,
          status,
          updated_at: nowIso(),
        }
        const index = localRecipientStore.findIndex(
          (recipient) => recipient.id === recipientId && recipient.workspace_id === scopedWorkspaceId,
        )
        if (index >= 0) {
          localRecipientStore[index] = updated
        }
        return updated
      }
      throw error
    }

    return data as OutreachRecipient
  } catch (error) {
    trackOutreachActionFailed({
      action: 'update_recipient_status',
      error,
      workspace_id: workspaceId,
      recipient_id: recipientId,
      safe_context: {
        has_workspace: Boolean(workspaceId?.trim()),
        status,
      },
    })
    throw error
  }
}

export const getRecipientSummaryByExecution = async (accountCampaignId: string): Promise<RecipientSummaryByExecution> => {
  trackOutreachActionStarted({
    action: 'list_recipients',
    account_campaign_id: accountCampaignId,
    safe_context: {
      source: 'recipient_summary_by_execution',
    },
  })

  try {
    const recipients = await listRecipientsByAccountCampaign(accountCampaignId)
    const workspaceId = recipients[0]?.workspace_id
      ?? (shouldAllowOutreachLocalFallback()
        ? localAccountCampaignStore.find((execution) => execution.id === accountCampaignId)?.workspace_id
        : undefined)
      ?? 'unknown-workspace'
    const summary = mapRecipientSummary(workspaceId, accountCampaignId, recipients)
    trackOutreachActionSucceeded({
      action: 'list_recipients',
      workspace_id: summary.workspaceId,
      account_campaign_id: accountCampaignId,
      safe_context: {
        source: 'recipient_summary_by_execution',
        total: summary.total,
      },
    })
    return summary
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_recipients',
      error,
      account_campaign_id: accountCampaignId,
      safe_context: {
        source: 'recipient_summary_by_execution',
      },
    })
    throw error
  }
}

export const getRecipientSummaryByExecutions = async (
  accountCampaignIds: string[],
): Promise<Record<string, RecipientSummaryByExecution>> => {
  const uniqueIds = [...new Set(accountCampaignIds.map((id) => id.trim()).filter((id) => id.length > 0))]
  const emptySummaryMap: Record<string, RecipientSummaryByExecution> = {}

  trackOutreachActionStarted({
    action: 'list_recipients',
    safe_context: {
      source: 'recipient_summary_batch',
      execution_count: uniqueIds.length,
      batch_mode: true,
    },
  })

  try {
    if (uniqueIds.length === 0) {
      trackOutreachActionSucceeded({
        action: 'list_recipients',
        safe_context: {
          source: 'recipient_summary_batch',
          execution_count: 0,
          recipients_count: 0,
          batch_mode: true,
        },
      })
      return emptySummaryMap
    }

    assertOutreachReadAvailable('get_recipient_summary_by_executions', {
      executionCount: uniqueIds.length,
    })

    let recipients: OutreachRecipient[] = []
    if (!supabase) {
      recipients = localRecipientStore.filter((recipient) => uniqueIds.includes(recipient.account_campaign_id))
    } else {
      const { data, error } = await supabase
        .from(outreachRecipientsTable)
        .select('*')
        .in('account_campaign_id', uniqueIds)
        .order('created_at', { ascending: false })

      if (error) {
        if (isTableMissingError(error)) {
          handleOutreachTableMissing('get_recipient_summary_by_executions', {
            executionCount: uniqueIds.length,
          })
          recipients = localRecipientStore.filter((recipient) => uniqueIds.includes(recipient.account_campaign_id))
        } else {
          throw error
        }
      } else {
        recipients = (data ?? []) as OutreachRecipient[]
      }
    }

    const recipientsByExecution: Record<string, OutreachRecipient[]> = {}
    for (const recipient of recipients) {
      if (!recipientsByExecution[recipient.account_campaign_id]) {
        recipientsByExecution[recipient.account_campaign_id] = []
      }
      recipientsByExecution[recipient.account_campaign_id].push(recipient)
    }

    const summaryMap: Record<string, RecipientSummaryByExecution> = {}
    for (const accountCampaignId of uniqueIds) {
      const executionRecipients = recipientsByExecution[accountCampaignId] ?? []
      const workspaceId = executionRecipients[0]?.workspace_id
        ?? (shouldAllowOutreachLocalFallback()
          ? localAccountCampaignStore.find((execution) => execution.id === accountCampaignId)?.workspace_id
          : undefined)
        ?? 'unknown-workspace'
      summaryMap[accountCampaignId] = mapRecipientSummary(workspaceId, accountCampaignId, executionRecipients)
    }

    trackOutreachActionSucceeded({
      action: 'list_recipients',
      safe_context: {
        source: 'recipient_summary_batch',
        execution_count: uniqueIds.length,
        recipients_count: recipients.length,
        batch_mode: true,
      },
    })
    return summaryMap
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_recipients',
      error,
      safe_context: {
        source: 'recipient_summary_batch',
        execution_count: uniqueIds.length,
        batch_mode: true,
      },
    })
    throw error
  }
}

export const createCampaignWithIndependentExecutions = async (
  payload: CreateCampaignWithExecutionsInput,
): Promise<CreateCampaignWithExecutionsResult> => {
  const workspaceId = payload.workspaceId.trim()
  const name = payload.name.trim()
  const baseMessage = payload.baseMessage.trim()
  const selectedAccountIds = [...new Set(payload.selectedAccountIds.map((item) => item.trim()).filter((item) => item.length > 0))]

  assertOutreachPersistenceAvailable('create_campaign_with_independent_executions', {
    workspaceId: payload.workspaceId,
    selectedAccountCount: selectedAccountIds.length,
  })

  trackOutreachActionStarted({
    action: 'create_campaign',
    workspace_id: workspaceId || undefined,
    safe_context: {
      selected_accounts: selectedAccountIds.length,
      tone: payload.tone.trim() || 'consultivo',
    },
  })

  if (!workspaceId) {
    throw new Error('workspace_id é obrigatório para criar campanha.')
  }
  if (!name) {
    throw new Error('Nome da campanha é obrigatório.')
  }
  if (!baseMessage) {
    throw new Error('Mensagem principal é obrigatória.')
  }
  if (selectedAccountIds.length === 0) {
    throw new Error('Selecione pelo menos uma conta para criar execuções independentes.')
  }

  const accountMap = await resolveAccountsForCampaign(workspaceId, selectedAccountIds)
  if (accountMap.size !== selectedAccountIds.length) {
    throw new Error('Uma ou mais contas selecionadas não pertencem ao workspace informado.')
  }

  const campaign = await createOutreachCampaign({
    workspaceId,
    name,
    objective: payload.objective?.trim() || null,
    baseMessage,
  })

  const executions: CampaignExecutionSummary[] = []
  let totalVariants = 0
  const sharedVariants = await generateMessageVariants(baseMessage, payload.tone)

  try {
    for (const accountId of selectedAccountIds) {
      const account = accountMap.get(accountId)
      if (!account) {
        throw new Error(`Conta ${accountId} não encontrada no workspace.`)
      }

      const warmupProfile = {
        tone: payload.tone.trim() || 'consultivo',
        start_time: payload.startTime ?? null,
        end_time: payload.endTime ?? null,
        active_days: payload.activeDays ?? ['mon', 'tue', 'wed', 'thu', 'fri'],
      }

      const execution = await createIndependentAccountCampaign({
        workspaceId,
        accountId,
        campaignId: campaign.id,
        warmupProfile,
      })

      const persistedVariants = await persistMessageVariants(execution.id, {
        workspaceId,
        baseMessage,
        variants: sharedVariants,
      })

      totalVariants += persistedVariants.length
      executions.push({
        workspaceId,
        campaignId: campaign.id,
        accountCampaignId: execution.id,
        accountId,
        accountDisplayName: account.display_name,
        status: execution.status,
        independentSeed: execution.independent_seed,
        createdAt: execution.created_at,
        totalVariants: persistedVariants.length,
        variants: persistedVariants.map(mapVariantPreview),
        note: 'Esta execução possui ritmo, histórico, fila e variações próprias.',
      })
    }
  } catch (error) {
    const normalizedError = normalizeOutreachError(error)
    trackOutreachActionFailed({
      action: 'create_campaign',
      error: normalizedError,
      workspace_id: workspaceId,
      safe_context: {
        selected_accounts: selectedAccountIds.length,
      },
    })
    if (normalizedError.code !== 'UNKNOWN_OUTREACH_ERROR' || isOutreachDomainError(error)) {
      throw normalizedError
    }

    throw new Error(`Campanha criada, mas houve falha ao persistir execuções independentes: ${normalizedError.message}`)
  }

  logOutreachStructure('create_campaign_with_independent_executions', {
    workspaceId,
    campaignId: campaign.id,
    executionCount: executions.length,
    totalVariants,
    sampleBaseMessage: truncateText(baseMessage, 64),
  })

  trackOutreachActionSucceeded({
    action: 'create_campaign',
    workspace_id: workspaceId,
    campaign_id: campaign.id,
    safe_context: {
      execution_count: executions.length,
      total_variants: totalVariants,
    },
  })

  return {
    campaign,
    executions,
    totalExecutions: executions.length,
    totalVariants,
  }
}

export const calculateWarmupWindow = async (accountId: string): Promise<WarmupWindowSuggestion> => {
  trackOutreachActionStarted({
    action: 'calculate_warmup_window',
    account_id: accountId,
  })

  try {
    assertOutreachReadAvailable('calculate_warmup_window', { accountId })

    if (!supabase) {
      const suggestion = calculateWindowFromSeed(accountId)
      trackOutreachActionSucceeded({
        action: 'calculate_warmup_window',
        account_id: accountId,
        safe_context: {
          source: 'local_fallback',
        },
      })
      return suggestion
    }

    const { data, error } = await supabase
      .from(outreachAccountsTable)
      .select('warmup_level, hourly_limit_min, hourly_limit_max, start_time, end_time')
      .eq('id', accountId)
      .maybeSingle<Pick<OutreachAccount, 'warmup_level' | 'hourly_limit_min' | 'hourly_limit_max' | 'start_time' | 'end_time'>>()

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('calculate_warmup_window', { accountId })
        const suggestion = calculateWindowFromSeed(accountId)
        trackOutreachActionSucceeded({
          action: 'calculate_warmup_window',
          account_id: accountId,
          safe_context: {
            source: 'table_missing_local_fallback',
          },
        })
        return suggestion
      }
      throw error
    }

    const suggestion = calculateWindowFromSeed(accountId, data ?? undefined)
    trackOutreachActionSucceeded({
      action: 'calculate_warmup_window',
      account_id: accountId,
      safe_context: {
        source: 'supabase',
      },
    })
    return suggestion
  } catch (error) {
    const normalizedError = normalizeOutreachError(error)
    trackOutreachActionFailed({
      action: 'calculate_warmup_window',
      error: normalizedError,
      account_id: accountId,
    })
    throw normalizedError
  }
}

export const listOutreachConversations = async (workspaceId: string): Promise<OutreachConversation[]> => {
  trackOutreachActionStarted({
    action: 'list_conversations',
    workspace_id: workspaceId,
  })

  try {
    assertOutreachReadAvailable('list_outreach_conversations', { workspaceId })

    if (!supabase) {
      const localRows: OutreachConversation[] = []
      trackOutreachActionSucceeded({
        action: 'list_conversations',
        workspace_id: workspaceId,
        safe_context: {
          count: localRows.length,
          source: 'local_fallback',
        },
      })
      return localRows
    }

    const { data, error } = await supabase
      .from(outreachConversationsTable)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })

    if (error) {
      if (isTableMissingError(error)) {
        handleOutreachTableMissing('list_outreach_conversations', { workspaceId })
        logOutreachStructure('list_outreach_conversations_table_missing', { workspaceId })
        const localRows: OutreachConversation[] = []
        trackOutreachActionSucceeded({
          action: 'list_conversations',
          workspace_id: workspaceId,
          safe_context: {
            count: localRows.length,
            source: 'table_missing_fallback',
          },
        })
        return localRows
      }
      throw error
    }

    const rows = (data ?? []) as OutreachConversation[]
    trackOutreachActionSucceeded({
      action: 'list_conversations',
      workspace_id: workspaceId,
      safe_context: {
        count: rows.length,
        source: 'supabase',
      },
    })
    return rows
  } catch (error) {
    trackOutreachActionFailed({
      action: 'list_conversations',
      error,
      workspace_id: workspaceId,
    })
    throw error
  }
}

export const listOutreachAccountCampaigns = async (workspaceId: string): Promise<OutreachAccountCampaign[]> => {
  assertOutreachReadAvailable('list_outreach_account_campaigns', { workspaceId })

  if (!supabase) {
    return localAccountCampaignStore
      .filter((campaign) => campaign.workspace_id === workspaceId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
  }

  const { data, error } = await supabase
    .from(outreachAccountCampaignsTable)
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  if (error) {
    if (isTableMissingError(error)) {
      handleOutreachTableMissing('list_outreach_account_campaigns', { workspaceId })
      logOutreachStructure('list_outreach_account_campaigns_table_missing', { workspaceId })
      return []
    }
    throw error
  }

  return (data ?? []) as OutreachAccountCampaign[]
}

export const generateQueueForAccountCampaign = async (accountCampaignId: string): Promise<QueueBuildResult> => {
  const trimmed = accountCampaignId.trim()
  if (!trimmed) {
    throw new Error('account_campaign_id é obrigatório para gerar fila estrutural.')
  }

  assertOutreachPersistenceAvailable('generate_queue_for_account_campaign', { accountCampaignId: trimmed })

  trackOutreachActionStarted({
    action: 'generate_queue',
    account_campaign_id: trimmed,
  })

  try {
    const result = await buildAccountCampaignQueue(trimmed)
    logOutreachStructure('generate_queue_for_account_campaign', {
      accountCampaignId: trimmed,
      accountId: result.accountId,
      workspaceId: result.workspaceId,
      totalRecipients: result.totalRecipients,
      eligibleRecipients: result.eligibleRecipients,
      alreadyQueued: result.alreadyQueued,
      scheduled: result.scheduled,
      skipped: result.skipped,
      failed: result.failed,
    })
    trackOutreachActionSucceeded({
      action: 'generate_queue',
      workspace_id: result.workspaceId || undefined,
      account_id: result.accountId || undefined,
      account_campaign_id: trimmed,
      safe_context: {
        total_recipients: result.totalRecipients,
        eligible_recipients: result.eligibleRecipients,
        already_queued: result.alreadyQueued,
        scheduled: result.scheduled,
        skipped: result.skipped,
        failed: result.failed,
      },
    })
    return result
  } catch (error) {
    const normalizedError = normalizeOutreachError(error)
    trackOutreachActionFailed({
      action: 'generate_queue',
      error: normalizedError,
      account_campaign_id: trimmed,
    })
    throw normalizedError
  }
}

export * from './outreach-queue.service'
export * from './outreach-warmup-engine'
