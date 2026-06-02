import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addRecipientToAccountCampaign,
  bulkAddRecipientsToAccountCampaign,
  calculateWarmupWindow,
  calculateAccountWarmupProfile,
  createCampaignWithIndependentExecutions,
  createOutreachAccount,
  generateQueueForAccountCampaign,
  getRecipientSummaryByExecutions,
  listCampaignExecutions,
  listQueueByAccounts,
  listOutreachAccountCampaigns,
  listOutreachAccounts,
  listOutreachCampaigns,
  listOutreachConversations,
  listRecipientsByAccountCampaignPaginated,
  scheduleNextMessagesForAccount,
  updateOutreachAccount,
} from '../services/outreach.service'
import { normalizeOutreachError } from '../services/outreach-errors'
import {
  type BulkRecipientResult,
  type CampaignExecutionSummary,
  type CampaignFormState,
  type OutreachAccount,
  type OutreachAccountCampaign,
  type OutreachCampaign,
  type OutreachConversation,
  type OutreachMessageQueue,
  type OutreachRecipient,
  type QueueBuildResult,
  type QueueGenerationState,
  type QueuePreviewItem,
  type RecipientFormState,
  type RecipientSummaryByExecution,
  type WarmupProfile,
  type WarmupWindowSuggestion,
} from '../types'
import {
  trackOutreachActionFailed,
  trackOutreachActionStarted,
  trackOutreachActionSucceeded,
} from '../services/outreach-telemetry'
import './ia-outreach.css'

const maxAccountsPerWorkspace = 5

const weekDays = [
  { id: 'mon', label: 'Seg' },
  { id: 'tue', label: 'Ter' },
  { id: 'wed', label: 'Qua' },
  { id: 'thu', label: 'Qui' },
  { id: 'fri', label: 'Sex' },
  { id: 'sat', label: 'Sab' },
  { id: 'sun', label: 'Dom' },
] as const

const accountStatusLabel: Record<OutreachAccount['status'], string> = {
  draft: 'Rascunho',
  disconnected: 'Desconectada',
  connected: 'Conectada',
  warming: 'Aquecendo',
  paused: 'Pausada',
  risk: 'Risco',
  blocked: 'Bloqueada',
}

const initialCampaignForm: CampaignFormState = {
  name: '',
  objective: '',
  baseMessage: '',
  tone: 'consultivo',
  startTime: '09:00',
  endTime: '18:00',
  activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  selectedAccountIds: [],
}

const initialRecipientFormState: RecipientFormState = {
  contactName: '',
  phoneNumber: '',
}

const loadDataErrorMessage = 'Não foi possível carregar os dados reais do módulo. Verifique a conexão com o backend.'
const warmupSuggestionUnavailableMessage = 'Sugestão de aquecimento indisponível no momento.'
const recipientLoadErrorMessage = 'Não foi possível carregar os destinatários desta execução no momento.'
const recipientsPageSize = 25

type RecipientStatusFilter = 'all' | OutreachRecipient['status']

type RecipientPaginationMeta = {
  total: number
  page: number
  pageSize: number
  totalPages: number
  statusFilter: RecipientStatusFilter
  searchTerm: string
}

type IaOutreachPageProps = {
  workspaceId: string
  workspaceName?: string
  isLegacySdrRoute?: boolean
}

export const IaOutreachPage = ({ workspaceId, workspaceName, isLegacySdrRoute = false }: IaOutreachPageProps) => {
  const [accounts, setAccounts] = useState<OutreachAccount[]>([])
  const [campaigns, setCampaigns] = useState<OutreachCampaign[]>([])
  const [accountCampaigns, setAccountCampaigns] = useState<OutreachAccountCampaign[]>([])
  const [campaignExecutions, setCampaignExecutions] = useState<CampaignExecutionSummary[]>([])
  const [expandedCampaignIds, setExpandedCampaignIds] = useState<string[]>([])
  const [recipientsByExecution, setRecipientsByExecution] = useState<Record<string, OutreachRecipient[]>>({})
  const [loadingRecipientsByExecution, setLoadingRecipientsByExecution] = useState<Record<string, boolean>>({})
  const [recipientLoadErrorByExecution, setRecipientLoadErrorByExecution] = useState<Record<string, string | null>>({})
  const [recipientPageByExecution, setRecipientPageByExecution] = useState<Record<string, number>>({})
  const [recipientPaginationByExecution, setRecipientPaginationByExecution] = useState<Record<string, RecipientPaginationMeta>>({})
  const [recipientStatusFilterByExecution, setRecipientStatusFilterByExecution] = useState<Record<string, RecipientStatusFilter>>({})
  const [recipientSearchByExecution, setRecipientSearchByExecution] = useState<Record<string, string>>({})
  const [recipientSearchAppliedByExecution, setRecipientSearchAppliedByExecution] = useState<Record<string, string>>({})
  const [recipientSummariesByExecution, setRecipientSummariesByExecution] = useState<Record<string, RecipientSummaryByExecution>>({})
  const [recipientFormsByExecution, setRecipientFormsByExecution] = useState<Record<string, RecipientFormState>>({})
  const [recipientImportTextByExecution, setRecipientImportTextByExecution] = useState<Record<string, string>>({})
  const [recipientImportResultByExecution, setRecipientImportResultByExecution] = useState<Record<string, BulkRecipientResult | null>>({})
  const [queueGenerationByExecution, setQueueGenerationByExecution] = useState<Record<string, QueueBuildResult | null>>({})
  const [queueGenerationStateByExecution, setQueueGenerationStateByExecution] = useState<Record<string, QueueGenerationState>>({})
  const [expandedExecutionQueues, setExpandedExecutionQueues] = useState<string[]>([])
  const [openManualRecipientExecutionId, setOpenManualRecipientExecutionId] = useState<string | null>(null)
  const [openImportRecipientExecutionId, setOpenImportRecipientExecutionId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<OutreachConversation[]>([])
  const [queueByAccount, setQueueByAccount] = useState<Record<string, OutreachMessageQueue[]>>({})
  const [warmupProfiles, setWarmupProfiles] = useState<Record<string, WarmupProfile>>({})
  const [feedback, setFeedback] = useState<string | null>(null)
  const [form, setForm] = useState<CampaignFormState>(initialCampaignForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savingRecipients, setSavingRecipients] = useState(false)
  const [preparingQueue, setPreparingQueue] = useState(false)
  const [structuralLogs, setStructuralLogs] = useState<string[]>([])
  const [variantPreview, setVariantPreview] = useState<string[]>([])
  const [warmupSuggestions, setWarmupSuggestions] = useState<Record<string, WarmupWindowSuggestion>>({})
  const [warmupSuggestionFeedback, setWarmupSuggestionFeedback] = useState<string | null>(null)
  const [linkedCampaignsByAccount, setLinkedCampaignsByAccount] = useState<Record<string, OutreachCampaign[]>>({})
  const [configAccountId, setConfigAccountId] = useState<string | null>(null)

  const addStructuralLog = (message: string) =>
    setStructuralLogs((current) => [`${new Date().toISOString()} ${message}`, ...current].slice(0, 20))

  const loadRecipientsForExecution = useCallback(
    async (
      accountCampaignId: string,
      options: {
        force?: boolean
        page?: number
        status?: RecipientStatusFilter
        search?: string
      } = {},
    ): Promise<void> => {
      const requestedPage = Math.max(1, options.page ?? recipientPageByExecution[accountCampaignId] ?? 1)
      const selectedStatusFilter = options.status ?? recipientStatusFilterByExecution[accountCampaignId] ?? 'all'
      const statusForQuery = selectedStatusFilter === 'all' ? undefined : selectedStatusFilter
      const appliedSearch = (options.search ?? recipientSearchAppliedByExecution[accountCampaignId] ?? '').trim()
      const hasSearchFilter = appliedSearch.length > 0
      const hasActiveFilters = Boolean(statusForQuery) || hasSearchFilter
      const cachedRecipients = recipientsByExecution[accountCampaignId] ?? []
      const currentPagination = recipientPaginationByExecution[accountCampaignId]
      const hasCache = Object.prototype.hasOwnProperty.call(recipientsByExecution, accountCampaignId)
        && (currentPagination?.page ?? 1) === requestedPage
        && (currentPagination?.statusFilter ?? 'all') === selectedStatusFilter
        && (currentPagination?.searchTerm ?? '') === appliedSearch

      trackOutreachActionStarted({
        action: 'list_recipients',
        workspace_id: workspaceId,
        account_campaign_id: accountCampaignId,
        safe_context: {
          paginated: true,
          filtered: hasActiveFilters,
          status: selectedStatusFilter,
          has_search: hasSearchFilter,
          search_length: appliedSearch.length,
          page: requestedPage,
          page_size: recipientsPageSize,
          lazy_load: true,
          cache_hit: hasCache,
        },
      })

      if (hasCache && !options.force) {
        trackOutreachActionSucceeded({
          action: 'list_recipients',
          workspace_id: workspaceId,
          account_campaign_id: accountCampaignId,
          safe_context: {
            paginated: true,
            filtered: hasActiveFilters,
            status: selectedStatusFilter,
            has_search: hasSearchFilter,
            search_length: appliedSearch.length,
            page: requestedPage,
            page_size: recipientsPageSize,
            lazy_load: true,
            cache_hit: true,
            total: currentPagination?.total ?? cachedRecipients.length,
            recipients_count: cachedRecipients.length,
          },
        })
        return
      }

      setLoadingRecipientsByExecution((current) => ({
        ...current,
        [accountCampaignId]: true,
      }))
      setRecipientLoadErrorByExecution((current) => ({
        ...current,
        [accountCampaignId]: null,
      }))

      try {
        const [paginatedRecipients, summaryMap] = await Promise.all([
          listRecipientsByAccountCampaignPaginated({
            accountCampaignId,
            page: requestedPage,
            pageSize: recipientsPageSize,
            status: statusForQuery,
            search: hasSearchFilter ? appliedSearch : undefined,
          }),
          getRecipientSummaryByExecutions([accountCampaignId]),
        ])
        setRecipientsByExecution((current) => ({
          ...current,
          [accountCampaignId]: paginatedRecipients.items,
        }))
        setRecipientPaginationByExecution((current) => ({
          ...current,
          [accountCampaignId]: {
            total: paginatedRecipients.total,
            page: paginatedRecipients.page,
            pageSize: paginatedRecipients.pageSize,
            totalPages: paginatedRecipients.totalPages,
            statusFilter: selectedStatusFilter,
            searchTerm: appliedSearch,
          },
        }))
        setRecipientPageByExecution((current) => ({
          ...current,
          [accountCampaignId]: paginatedRecipients.page,
        }))
        setRecipientSummariesByExecution((current) => ({
          ...current,
          ...summaryMap,
        }))
        trackOutreachActionSucceeded({
          action: 'list_recipients',
          workspace_id: workspaceId,
          account_campaign_id: accountCampaignId,
          safe_context: {
            paginated: true,
            filtered: hasActiveFilters,
            status: selectedStatusFilter,
            has_search: hasSearchFilter,
            search_length: appliedSearch.length,
            page: paginatedRecipients.page,
            page_size: paginatedRecipients.pageSize,
            lazy_load: true,
            cache_hit: false,
            total: paginatedRecipients.total,
            total_pages: paginatedRecipients.totalPages,
            recipients_count: paginatedRecipients.items.length,
          },
        })
      } catch (error) {
        const normalizedError = normalizeOutreachError(error)
        setRecipientLoadErrorByExecution((current) => ({
          ...current,
          [accountCampaignId]: recipientLoadErrorMessage,
        }))
        trackOutreachActionFailed({
          action: 'list_recipients',
          error: normalizedError,
          workspace_id: workspaceId,
          account_campaign_id: accountCampaignId,
          safe_context: {
            paginated: true,
            filtered: hasActiveFilters,
            status: selectedStatusFilter,
            has_search: hasSearchFilter,
            search_length: appliedSearch.length,
            page: requestedPage,
            page_size: recipientsPageSize,
            lazy_load: true,
            cache_hit: false,
          },
        })
        throw normalizedError
      } finally {
        setLoadingRecipientsByExecution((current) => ({
          ...current,
          [accountCampaignId]: false,
        }))
      }
    },
    [
      recipientPageByExecution,
      recipientPaginationByExecution,
      recipientSearchAppliedByExecution,
      recipientStatusFilterByExecution,
      recipientsByExecution,
      workspaceId,
    ],
  )

  const loadData = useCallback(async () => {
    trackOutreachActionStarted({
      action: 'load_ia_outreach_page_data',
      workspace_id: workspaceId,
    })
    setLoading(true)
    setFeedback(null)
    try {
      const [nextAccounts, nextCampaigns, nextConversations, accountCampaigns] = await Promise.all([
        listOutreachAccounts(workspaceId),
        listOutreachCampaigns(workspaceId),
        listOutreachConversations(workspaceId),
        listOutreachAccountCampaigns(workspaceId),
      ])
      const executionSummaries = await listCampaignExecutions(workspaceId, {
        preloadedAccounts: nextAccounts,
        preloadedAccountCampaigns: accountCampaigns,
        preloadedCampaigns: nextCampaigns,
      })

      setAccounts(nextAccounts)
      setCampaigns(nextCampaigns)
      setAccountCampaigns(accountCampaigns)
      setCampaignExecutions(executionSummaries)
      setConversations(nextConversations)
      const executionIdSet = new Set(executionSummaries.map((execution) => execution.accountCampaignId))
      setRecipientsByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setLoadingRecipientsByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setRecipientLoadErrorByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setRecipientPageByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setRecipientPaginationByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setRecipientStatusFilterByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setRecipientSearchByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )
      setRecipientSearchAppliedByExecution((current) =>
        Object.fromEntries(Object.entries(current).filter(([accountCampaignId]) => executionIdSet.has(accountCampaignId))),
      )

      const summaryMap = await getRecipientSummaryByExecutions(
        executionSummaries.map((execution) => execution.accountCampaignId),
      )
      setRecipientSummariesByExecution(summaryMap)
      const campaignLookup = new Map(nextCampaigns.map((campaign) => [campaign.id, campaign]))
      const links: Record<string, OutreachCampaign[]> = {}
      for (const item of accountCampaigns) {
        const campaign = campaignLookup.get(item.campaign_id)
        if (!campaign) {
          continue
        }
        if (!links[item.account_id]) {
          links[item.account_id] = []
        }
        links[item.account_id].push(campaign)
      }
      setLinkedCampaignsByAccount(links)

      const queueMap = await listQueueByAccounts(nextAccounts.map((account) => account.id))
      setQueueByAccount(queueMap)

      const profileMap: Record<string, WarmupProfile> = {}
      for (const account of nextAccounts) {
        profileMap[account.id] = calculateAccountWarmupProfile(account)
      }
      setWarmupProfiles(profileMap)
      trackOutreachActionSucceeded({
        action: 'load_ia_outreach_page_data',
        workspace_id: workspaceId,
        safe_context: {
          accounts_count: nextAccounts.length,
          campaigns_count: nextCampaigns.length,
          account_campaigns_count: accountCampaigns.length,
          executions_count: executionSummaries.length,
          recipient_summaries_count: Object.keys(summaryMap).length,
          conversations_count: nextConversations.length,
        },
      })
    } catch (error) {
      const normalizedError = normalizeOutreachError(error)
      trackOutreachActionFailed({
        action: 'load_ia_outreach_page_data',
        error: normalizedError,
        workspace_id: workspaceId,
      })
      setFeedback(loadDataErrorMessage)
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const visibleExecutionIds = useMemo(() => {
    const openCampaignIds = new Set(expandedCampaignIds)
    const ids = campaignExecutions
      .filter((execution) => openCampaignIds.has(execution.campaignId))
      .map((execution) => execution.accountCampaignId)
    return [...new Set(ids)]
  }, [campaignExecutions, expandedCampaignIds])

  useEffect(() => {
    if (visibleExecutionIds.length === 0) {
      return
    }

    for (const accountCampaignId of visibleExecutionIds) {
      const targetPage = Math.max(1, recipientPageByExecution[accountCampaignId] ?? 1)
      const loadedPagination = recipientPaginationByExecution[accountCampaignId]
      const activeStatusFilter = recipientStatusFilterByExecution[accountCampaignId] ?? 'all'
      const activeSearchFilter = (recipientSearchAppliedByExecution[accountCampaignId] ?? '').trim()
      const hasPageCache = Object.prototype.hasOwnProperty.call(recipientsByExecution, accountCampaignId)
        && loadedPagination?.page === targetPage
        && (loadedPagination?.statusFilter ?? 'all') === activeStatusFilter
        && (loadedPagination?.searchTerm ?? '') === activeSearchFilter
      if (hasPageCache) {
        continue
      }
      if (loadingRecipientsByExecution[accountCampaignId]) {
        continue
      }
      void loadRecipientsForExecution(accountCampaignId, {
        page: targetPage,
        status: activeStatusFilter,
        search: activeSearchFilter,
      }).catch(() => undefined)
    }
  }, [
    loadRecipientsForExecution,
    loadingRecipientsByExecution,
    recipientPageByExecution,
    recipientPaginationByExecution,
    recipientSearchAppliedByExecution,
    recipientStatusFilterByExecution,
    recipientsByExecution,
    visibleExecutionIds,
  ])

  useEffect(() => {
    let mounted = true
    if (accounts.length === 0) {
      setWarmupSuggestions({})
      setQueueByAccount({})
      setWarmupProfiles({})
      setWarmupSuggestionFeedback(null)
      return
    }

    trackOutreachActionStarted({
      action: 'load_warmup_suggestions',
      workspace_id: workspaceId,
      safe_context: {
        accounts_count: accounts.length,
      },
    })

    const loadWarmupSuggestions = async () => {
      try {
        const suggestions = await Promise.all(accounts.map((account) => calculateWarmupWindow(account.id)))
        if (!mounted) {
          return
        }

        const nextMap: Record<string, WarmupWindowSuggestion> = {}
        for (const suggestion of suggestions) {
          nextMap[suggestion.accountId] = suggestion
        }
        setWarmupSuggestions(nextMap)
        setWarmupSuggestionFeedback(null)
        trackOutreachActionSucceeded({
          action: 'load_warmup_suggestions',
          workspace_id: workspaceId,
          safe_context: {
            accounts_count: accounts.length,
            suggestions_count: suggestions.length,
          },
        })
      } catch (error) {
        const normalizedError = normalizeOutreachError(error)
        trackOutreachActionFailed({
          action: 'load_warmup_suggestions',
          error: normalizedError,
          workspace_id: workspaceId,
          safe_context: {
            accounts_count: accounts.length,
          },
        })
        if (!mounted) {
          return
        }
        setWarmupSuggestions({})
        setWarmupSuggestionFeedback(warmupSuggestionUnavailableMessage)
      }
    }

    void loadWarmupSuggestions()

    return () => {
      mounted = false
    }
  }, [accounts, workspaceId])

  const accountSlots = useMemo(
    () => Array.from({ length: maxAccountsPerWorkspace }, (_, index) => accounts[index] ?? null),
    [accounts],
  )

  const conversationCounts = useMemo(() => ({
    open: conversations.filter((item) => item.status === 'open').length,
    waitingAgent: conversations.filter((item) => item.status === 'waiting_agent').length,
    humanNeeded: conversations.filter((item) => item.status === 'human_needed').length,
    closed: conversations.filter((item) => item.status === 'closed').length,
  }), [conversations])

  const activeCampaigns = useMemo(() => campaigns.filter((campaign) => campaign.status === 'active').length, [campaigns])
  const warmingAccounts = useMemo(() => accounts.filter((account) => account.status === 'warming').length, [accounts])
  const connectedAccounts = useMemo(() => accounts.filter((account) => account.status === 'connected' || account.status === 'warming').length, [accounts])
  const configAccount = useMemo(() => accounts.find((account) => account.id === configAccountId) ?? null, [accounts, configAccountId])
  const queueItems = useMemo(() => Object.values(queueByAccount).flat(), [queueByAccount])
  const queueIndex = useMemo(() => {
    type QueueSnapshot = { total: number; pending: number; scheduled: number; nextScheduled: Date | null }
    const queueItemsByAccountId: Record<string, OutreachMessageQueue[]> = {}
    const queueItemsByAccountCampaignId: Record<string, OutreachMessageQueue[]> = {}
    const queueCountsByAccountId: Record<string, QueueSnapshot> = {}
    const queueCountsByAccountCampaignId: Record<string, QueueSnapshot> = {}
    const queueCounts = { pending: 0, scheduled: 0 }

    const parseQueueDate = (value: string | null) => {
      if (!value) {
        return null
      }
      const parsed = new Date(value)
      return Number.isNaN(parsed.getTime()) ? null : parsed
    }

    const getOrCreateSnapshot = (collection: Record<string, QueueSnapshot>, key: string) => {
      if (!collection[key]) {
        collection[key] = {
          total: 0,
          pending: 0,
          scheduled: 0,
          nextScheduled: null,
        }
      }
      return collection[key]
    }

    const updateNextScheduled = (snapshot: QueueSnapshot, candidate: Date | null) => {
      if (!candidate) {
        return
      }
      if (!snapshot.nextScheduled || candidate.getTime() < snapshot.nextScheduled.getTime()) {
        snapshot.nextScheduled = candidate
      }
    }

    for (const item of queueItems) {
      if (!queueItemsByAccountId[item.account_id]) {
        queueItemsByAccountId[item.account_id] = []
      }
      queueItemsByAccountId[item.account_id].push(item)

      if (!queueItemsByAccountCampaignId[item.account_campaign_id]) {
        queueItemsByAccountCampaignId[item.account_campaign_id] = []
      }
      queueItemsByAccountCampaignId[item.account_campaign_id].push(item)

      const accountSnapshot = getOrCreateSnapshot(queueCountsByAccountId, item.account_id)
      const accountCampaignSnapshot = getOrCreateSnapshot(queueCountsByAccountCampaignId, item.account_campaign_id)
      const parsedDate = parseQueueDate(item.scheduled_for)

      accountSnapshot.total += 1
      accountCampaignSnapshot.total += 1

      if (item.status === 'pending') {
        queueCounts.pending += 1
        accountSnapshot.pending += 1
        accountCampaignSnapshot.pending += 1
      }

      if (item.status === 'scheduled') {
        queueCounts.scheduled += 1
        accountSnapshot.scheduled += 1
        accountCampaignSnapshot.scheduled += 1
        // Snapshot por conta mantém a mesma regra anterior: próxima data apenas dos itens agendados.
        updateNextScheduled(accountSnapshot, parsedDate)
      }

      // Snapshot por execução mantém a regra anterior: próxima data considerando qualquer item com scheduled_for válido.
      updateNextScheduled(accountCampaignSnapshot, parsedDate)
    }

    for (const accountId of Object.keys(queueItemsByAccountId)) {
      queueItemsByAccountId[accountId].sort((left, right) => (left.scheduled_for ?? '').localeCompare(right.scheduled_for ?? ''))
    }
    for (const accountCampaignId of Object.keys(queueItemsByAccountCampaignId)) {
      queueItemsByAccountCampaignId[accountCampaignId].sort((left, right) => (left.scheduled_for ?? '').localeCompare(right.scheduled_for ?? ''))
    }

    return {
      queueCounts,
      queueItemsByAccountId,
      queueItemsByAccountCampaignId,
      queueCountsByAccountId,
      queueCountsByAccountCampaignId,
    }
  }, [queueItems])
  const { queueCounts, queueItemsByAccountCampaignId, queueCountsByAccountId, queueCountsByAccountCampaignId } = queueIndex
  const accountLookup = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts])
  const campaignLookup = useMemo(() => new Map(campaigns.map((campaign) => [campaign.id, campaign])), [campaigns])
  const executionByCampaign = useMemo(() => {
    const map = new Map<string, CampaignExecutionSummary[]>()
    for (const execution of campaignExecutions) {
      const current = map.get(execution.campaignId) ?? []
      current.push(execution)
      map.set(execution.campaignId, current)
    }
    return map
  }, [campaignExecutions])

  const queueCampaignRows = useMemo(() => {
    return accountCampaigns.map((accountCampaign) => {
      const account = accountLookup.get(accountCampaign.account_id) ?? null
      const campaign = campaignLookup.get(accountCampaign.campaign_id) ?? null
      const items = queueItemsByAccountCampaignId[accountCampaign.id] ?? []
      const counts = queueCountsByAccountCampaignId[accountCampaign.id]
      const pending = counts?.pending ?? 0
      const scheduled = counts?.scheduled ?? 0
      const nextScheduled = counts?.nextScheduled ?? null

      return {
        accountCampaign,
        account,
        campaign,
        pending,
        scheduled,
        total: items.length,
        nextScheduled,
      }
    })
  }, [accountCampaigns, accountLookup, campaignLookup, queueItemsByAccountCampaignId, queueCountsByAccountCampaignId])
  const nextQueueWindow = useMemo(() => {
    return queueCampaignRows
      .map((row) => row.nextScheduled)
      .filter((value): value is Date => value !== undefined && value !== null)
      .sort((left, right) => left.getTime() - right.getTime())[0] ?? null
  }, [queueCampaignRows])
  const accountQueueSnapshots = useMemo(() => {
    const snapshot: Record<string, { total: number; pending: number; scheduled: number; nextScheduled: Date | null }> = {}
    for (const account of accounts) {
      const counts = queueCountsByAccountId[account.id]
      snapshot[account.id] = {
        total: counts?.total ?? 0,
        pending: counts?.pending ?? 0,
        scheduled: counts?.scheduled ?? 0,
        nextScheduled: counts?.nextScheduled ?? null,
      }
    }
    return snapshot
  }, [accounts, queueCountsByAccountId])

  const resolveNextAccountStatus = (
    account: OutreachAccount,
    nextActive: boolean,
  ): OutreachAccount['status'] => {
    const preservedStatuses: OutreachAccount['status'][] = ['risk', 'blocked', 'disconnected']
    if (preservedStatuses.includes(account.status)) {
      return account.status
    }

    if (!nextActive) {
      return 'paused'
    }

    if (account.status === 'connected' || account.status === 'warming') {
      return account.status
    }

    return 'warming'
  }

  const toggleActive = async (account: OutreachAccount) => {
    const nextActive = !account.is_active
    const nextStatus = resolveNextAccountStatus(account, nextActive)

    trackOutreachActionStarted({
      action: 'toggle_account_status',
      workspace_id: workspaceId,
      account_id: account.id,
      safe_context: {
        previous_active: account.is_active,
        next_active: nextActive,
        previous_status: account.status,
        next_status: nextStatus,
      },
    })

    setAccounts((current) => current.map((item) => (item.id === account.id ? { ...item, is_active: nextActive, status: nextStatus } : item)))
    addStructuralLog(`Conta ${account.display_name} atualizada para is_active=${nextActive} e status=${nextStatus}.`)

    try {
      await updateOutreachAccount(account.id, { is_active: nextActive, status: nextStatus }, workspaceId)
      trackOutreachActionSucceeded({
        action: 'toggle_account_status',
        workspace_id: workspaceId,
        account_id: account.id,
        safe_context: {
          persisted: true,
          next_active: nextActive,
          next_status: nextStatus,
        },
      })
    } catch (error) {
      setAccounts((current) =>
        current.map((item) => (item.id === account.id ? { ...item, is_active: account.is_active, status: account.status } : item)),
      )
      trackOutreachActionFailed({
        action: 'toggle_account_status',
        error,
        workspace_id: workspaceId,
        account_id: account.id,
        safe_context: {
          persisted: false,
          next_active: nextActive,
          next_status: nextStatus,
        },
      })
      setFeedback(normalizeOutreachError(error).message)
    }
  }

  const createAccountSlot = async () => {
    if (saving) {
      return
    }

    if (accounts.length >= maxAccountsPerWorkspace) {
      setFeedback('Limite estrutural de 5 contas por workspace já preenchido nesta base.')
      return
    }

    setSaving(true)
    try {
      const created = await createOutreachAccount({
        workspaceId,
        displayName: `Conta ${accounts.length + 1}`,
        startTime: '09:00',
        endTime: '18:00',
        activeDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      })
      setAccounts((current) => [...current, created].slice(0, maxAccountsPerWorkspace))
      addStructuralLog(`Conta estrutural criada: ${created.display_name}.`)
      setFeedback('Conta estrutural criada. Nenhum envio real foi ativado.')
    } catch (error) {
      setFeedback(normalizeOutreachError(error).message)
    } finally {
      setSaving(false)
    }
  }

  const submitCampaign = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) {
      return
    }

    if (!form.name.trim() || !form.baseMessage.trim()) {
      setFeedback('Nome da campanha e mensagem principal são obrigatórios.')
      return
    }
    if (form.selectedAccountIds.length === 0) {
      setFeedback('Selecione pelo menos uma conta para criar execuções independentes.')
      return
    }

    setSaving(true)
    setFeedback(null)
    try {
      const result = await createCampaignWithIndependentExecutions({
        workspaceId,
        name: form.name.trim(),
        objective: form.objective.trim() || null,
        baseMessage: form.baseMessage.trim(),
        tone: form.tone,
        startTime: form.startTime,
        endTime: form.endTime,
        activeDays: form.activeDays,
        selectedAccountIds: form.selectedAccountIds,
      })

      setCampaigns((current) => [result.campaign, ...current])
      const firstExecution = result.executions[0]
      setVariantPreview(firstExecution ? firstExecution.variants.map((variant) => variant.content) : [])
      setForm(initialCampaignForm)
      addStructuralLog(
        `Campanha ${result.campaign.name} criada com ${result.totalExecutions} execução(ões) independente(s) e ${result.totalVariants} variação(ões).`,
      )
      setFeedback('Campanha criada com execuções independentes por conta. Nenhum envio real foi executado.')
      await loadData()
    } catch (error) {
      setFeedback(normalizeOutreachError(error).message)
    } finally {
      setSaving(false)
    }
  }

  const updateActiveDay = (dayId: string) => {
    setForm((current) => {
      const activeDays = current.activeDays.includes(dayId)
        ? current.activeDays.filter((item) => item !== dayId)
        : [...current.activeDays, dayId]
      return { ...current, activeDays }
    })
  }

  const toggleCampaignAccount = (accountId: string) => {
    setForm((current) => {
      const selectedAccountIds = current.selectedAccountIds.includes(accountId)
        ? current.selectedAccountIds.filter((item) => item !== accountId)
        : [...current.selectedAccountIds, accountId]
      return { ...current, selectedAccountIds }
    })
  }

  const getRecipientFormState = (accountCampaignId: string) => recipientFormsByExecution[accountCampaignId] ?? initialRecipientFormState

  const setRecipientFormState = (
    accountCampaignId: string,
    updater: (current: RecipientFormState) => RecipientFormState,
  ) => {
    setRecipientFormsByExecution((current) => ({
      ...current,
      [accountCampaignId]: updater(current[accountCampaignId] ?? initialRecipientFormState),
    }))
  }

  const getRecipientStatusFilter = (accountCampaignId: string): RecipientStatusFilter =>
    recipientStatusFilterByExecution[accountCampaignId] ?? 'all'

  const getRecipientSearchInput = (accountCampaignId: string): string =>
    recipientSearchByExecution[accountCampaignId] ?? recipientSearchAppliedByExecution[accountCampaignId] ?? ''

  const getRecipientSearchApplied = (accountCampaignId: string): string =>
    (recipientSearchAppliedByExecution[accountCampaignId] ?? '').trim()

  const applyRecipientFilters = async (
    accountCampaignId: string,
    options: {
      status?: RecipientStatusFilter
      search?: string
    } = {},
  ) => {
    const nextStatus = options.status ?? getRecipientStatusFilter(accountCampaignId)
    const nextSearch = (options.search ?? getRecipientSearchInput(accountCampaignId)).trim()

    setRecipientStatusFilterByExecution((current) => ({
      ...current,
      [accountCampaignId]: nextStatus,
    }))
    setRecipientSearchByExecution((current) => ({
      ...current,
      [accountCampaignId]: nextSearch,
    }))
    setRecipientSearchAppliedByExecution((current) => ({
      ...current,
      [accountCampaignId]: nextSearch,
    }))
    setRecipientPageByExecution((current) => ({
      ...current,
      [accountCampaignId]: 1,
    }))

    await loadRecipientsForExecution(accountCampaignId, {
      force: true,
      page: 1,
      status: nextStatus,
      search: nextSearch,
    })
  }

  const goToRecipientPage = (accountCampaignId: string, nextPage: number) => {
    const safeNextPage = Math.max(1, nextPage)
    const activeStatus = getRecipientStatusFilter(accountCampaignId)
    const activeSearch = getRecipientSearchApplied(accountCampaignId)
    setRecipientPageByExecution((current) => ({
      ...current,
      [accountCampaignId]: safeNextPage,
    }))
    void loadRecipientsForExecution(accountCampaignId, {
      page: safeNextPage,
      status: activeStatus,
      search: activeSearch,
    }).catch(() => undefined)
  }

  const resetRecipientPage = (accountCampaignId: string) => {
    goToRecipientPage(accountCampaignId, 1)
  }

  const handleAddRecipient = async (accountCampaignId: string) => {
    if (savingRecipients) {
      return
    }

    const formState = getRecipientFormState(accountCampaignId)
    if (!formState.phoneNumber.trim()) {
      setFeedback('Telefone é obrigatório para adicionar destinatário.')
      return
    }

    setSavingRecipients(true)
    setFeedback(null)
    try {
      await addRecipientToAccountCampaign({
        workspaceId,
        accountCampaignId,
        contactName: formState.contactName.trim() || null,
        phoneNumber: formState.phoneNumber,
      })
      setRecipientFormsByExecution((current) => ({
        ...current,
        [accountCampaignId]: initialRecipientFormState,
      }))
      resetRecipientPage(accountCampaignId)
      addStructuralLog(`Destinatário adicionado na execução ${accountCampaignId}.`)
      setFeedback('Destinatário salvo na execução selecionada.')
      try {
        await loadRecipientsForExecution(accountCampaignId, { force: true, page: 1 })
      } catch {
        await loadData()
      }
    } catch (error) {
      setFeedback(normalizeOutreachError(error).message)
    } finally {
      setSavingRecipients(false)
    }
  }

  const handleBulkImportRecipients = async (accountCampaignId: string) => {
    if (savingRecipients) {
      return
    }

    const inputText = (recipientImportTextByExecution[accountCampaignId] ?? '').trim()
    if (!inputText) {
      setFeedback('Cole uma lista para importar destinatários desta execução.')
      return
    }

    setSavingRecipients(true)
    setFeedback(null)
    try {
      const result = await bulkAddRecipientsToAccountCampaign({
        workspaceId,
        accountCampaignId,
        inputText,
      })
      setRecipientImportResultByExecution((current) => ({
        ...current,
        [accountCampaignId]: result,
      }))
      resetRecipientPage(accountCampaignId)
      addStructuralLog(
        `Importação de destinatários na execução ${accountCampaignId}: ${result.imported} importado(s), ${result.ignored} ignorado(s).`,
      )
      setFeedback(
        `Importação concluída: ${result.imported} importado(s), ${result.duplicatesInExecution + result.duplicatesInBatch} duplicado(s), ${result.invalid} inválido(s).`,
      )
      try {
        await loadRecipientsForExecution(accountCampaignId, { force: true, page: 1 })
      } catch {
        await loadData()
      }
    } catch (error) {
      setFeedback(normalizeOutreachError(error).message)
    } finally {
      setSavingRecipients(false)
    }
  }

  const toggleExecutionQueuePreview = (accountCampaignId: string) => {
    setExpandedExecutionQueues((current) =>
      current.includes(accountCampaignId)
        ? current.filter((id) => id !== accountCampaignId)
        : [...current, accountCampaignId],
    )
  }

  const handleGenerateExecutionQueue = async (execution: CampaignExecutionSummary) => {
    if ((queueGenerationStateByExecution[execution.accountCampaignId] ?? 'idle') === 'running') {
      return
    }

    const confirmed = window.confirm('Esta ação apenas cria a fila estrutural. Nenhuma mensagem será enviada.')
    if (!confirmed) {
      return
    }

    setQueueGenerationStateByExecution((current) => ({
      ...current,
      [execution.accountCampaignId]: 'running',
    }))
    setFeedback(null)

    try {
      const result = await generateQueueForAccountCampaign(execution.accountCampaignId)
      setQueueGenerationByExecution((current) => ({
        ...current,
        [execution.accountCampaignId]: result,
      }))
      setQueueGenerationStateByExecution((current) => ({
        ...current,
        [execution.accountCampaignId]: 'success',
      }))
      addStructuralLog(
        `Fila gerada para execução ${execution.accountCampaignId}: ${result.scheduled} agendado(s), ${result.skipped} ignorado(s), ${result.failed} falha(s).`,
      )
      setFeedback(
        `Fila estrutural gerada: ${result.totalRecipients} encontrado(s), ${result.eligibleRecipients} elegível(is), ${result.alreadyQueued} já na fila, ${result.scheduled} agendado(s), ${result.skipped} ignorado(s), ${result.failed} falha(s), próximo horário ${result.nextScheduledFor ? formatDateTime(result.nextScheduledFor) : 'não previsto'}.`,
      )
      await loadData()
    } catch (error) {
      setQueueGenerationStateByExecution((current) => ({
        ...current,
        [execution.accountCampaignId]: 'error',
      }))
      setFeedback(normalizeOutreachError(error).message)
    }
  }

  const saveAccountConfig = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!configAccount) {
      return
    }

    const formData = new FormData(event.currentTarget)
    const timezone = String(formData.get('timezone') ?? '').trim() || null
    const startTime = String(formData.get('start_time') ?? '').trim() || null
    const endTime = String(formData.get('end_time') ?? '').trim() || null
    const dailyLimitRaw = String(formData.get('daily_limit') ?? '').trim()
    const dailyLimit = dailyLimitRaw ? Number.parseInt(dailyLimitRaw, 10) : null

    const nextAccount: OutreachAccount = {
      ...configAccount,
      timezone,
      start_time: startTime,
      end_time: endTime,
      daily_limit: Number.isNaN(dailyLimit ?? NaN) ? null : dailyLimit,
    }

    setAccounts((current) => current.map((account) => (account.id === configAccount.id ? nextAccount : account)))
    addStructuralLog(`Configuração local atualizada para ${configAccount.display_name}.`)

    try {
      await updateOutreachAccount(configAccount.id, {
        timezone,
        start_time: startTime,
        end_time: endTime,
        daily_limit: Number.isNaN(dailyLimit ?? NaN) ? null : dailyLimit,
      }, workspaceId)
    } catch {
      // Mantemos o estado local estrutural mesmo sem persistencia.
    }

    setConfigAccountId(null)
    setFeedback('Configuração estrutural salva sem execução de envio.')
  }

  const prepareAccountCampaignQueue = async (accountCampaignId: string) => {
    if (preparingQueue) {
      return
    }

    setPreparingQueue(true)
    setFeedback(null)
    try {
      const result = await generateQueueForAccountCampaign(accountCampaignId)
      addStructuralLog(`Fila estrutural preparada para conta+campanha ${accountCampaignId}: ${result.scheduled} item(ns).`)
      setFeedback(result.message)
      await loadData()
    } catch (error) {
      setFeedback(normalizeOutreachError(error).message)
    } finally {
      setPreparingQueue(false)
    }
  }

  const prepareQueueForAccount = async (accountId: string) => {
    if (preparingQueue) {
      return
    }

    setPreparingQueue(true)
    setFeedback(null)
    try {
      const results = await scheduleNextMessagesForAccount(accountId)
      const createdCount = results.reduce((total, item) => total + item.createdCount, 0)
      addStructuralLog(`Fila estrutural preparada para conta ${accountId}: ${createdCount} item(ns) criados.`)
      if (results.length === 0) {
        setFeedback('Nenhuma campanha elegível foi encontrada para esta conta nesta etapa estrutural.')
      } else {
        setFeedback('Fila estrutural preparada. Nenhuma mensagem real é enviada nesta etapa.')
      }
      await loadData()
    } catch (error) {
      setFeedback(normalizeOutreachError(error).message)
    } finally {
      setPreparingQueue(false)
    }
  }

  const formatSchedule = (value: Date | null) => {
    if (!value || Number.isNaN(value.getTime())) {
      return 'Não estimado'
    }

    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(value)
  }

  const describeQueueStatus = (row: { total: number; accountCampaign: OutreachAccountCampaign; account: OutreachAccount | null }) => {
    if (row.accountCampaign.status === 'paused' || row.accountCampaign.status === 'completed' || row.accountCampaign.status === 'stopped') {
      return `Fila bloqueada (${row.accountCampaign.status})`
    }
    if (row.account && (row.account.status === 'paused' || row.account.status === 'risk' || row.account.status === 'blocked')) {
      return `Conta bloqueada (${row.account.status})`
    }
    if (row.total === 0) {
      return 'Fila vazia'
    }
    return 'Fila estrutural preparada'
  }

  const formatDateTime = (value: string) => {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      return 'Data indisponível'
    }
    return new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(parsed)
  }

  const summarizeBaseMessage = (value: string) => (value.length > 140 ? `${value.slice(0, 140)}...` : value)

  const toggleCampaignExecutions = (campaignId: string) => {
    setExpandedCampaignIds((current) =>
      current.includes(campaignId) ? current.filter((id) => id !== campaignId) : [...current, campaignId],
    )
  }

  const getVariantLabel = (variantIndex: number) => (variantIndex === 0 ? 'Mensagem base' : `Variação ${variantIndex}`)
  const recipientStatusLabel: Record<OutreachRecipient['status'], string> = {
    queued: 'Na fila estrutural',
    scheduled: 'Agendado',
    contacted: 'Contatado',
    replied: 'Respondeu',
    paused: 'Pausado',
    removed: 'Removido',
    failed: 'Falhou',
  }
  const recipientStatusFilterOptions: Array<{ value: RecipientStatusFilter; label: string }> = [
    { value: 'all', label: 'Todos' },
    { value: 'queued', label: recipientStatusLabel.queued },
    { value: 'scheduled', label: recipientStatusLabel.scheduled },
    { value: 'contacted', label: recipientStatusLabel.contacted },
    { value: 'replied', label: recipientStatusLabel.replied },
    { value: 'paused', label: recipientStatusLabel.paused },
    { value: 'removed', label: recipientStatusLabel.removed },
    { value: 'failed', label: recipientStatusLabel.failed },
  ]
  const queueStatusLabel: Record<OutreachMessageQueue['status'], string> = {
    pending: 'Pendente',
    scheduled: 'Agendado',
    processing: 'Processando',
    sent: 'Enviado',
    failed: 'Falhou',
    cancelled: 'Cancelado',
    skipped: 'Ignorado',
  }

  const requestExecutionRecipients = (accountCampaignId: string) => {
    const targetPage = Math.max(1, recipientPageByExecution[accountCampaignId] ?? 1)
    const loadedPagination = recipientPaginationByExecution[accountCampaignId]
    const activeStatus = getRecipientStatusFilter(accountCampaignId)
    const activeSearch = getRecipientSearchApplied(accountCampaignId)
    const hasPageCache = Object.prototype.hasOwnProperty.call(recipientsByExecution, accountCampaignId)
      && loadedPagination?.page === targetPage
      && (loadedPagination?.statusFilter ?? 'all') === activeStatus
      && (loadedPagination?.searchTerm ?? '') === activeSearch
    if (hasPageCache) {
      return
    }
    if (loadingRecipientsByExecution[accountCampaignId]) {
      return
    }
    void loadRecipientsForExecution(accountCampaignId, {
      page: targetPage,
      status: activeStatus,
      search: activeSearch,
    }).catch(() => undefined)
  }

  const toggleManualRecipientPanel = (accountCampaignId: string) => {
    requestExecutionRecipients(accountCampaignId)
    setOpenManualRecipientExecutionId((current) => (current === accountCampaignId ? null : accountCampaignId))
    setOpenImportRecipientExecutionId((current) => (current === accountCampaignId ? null : current))
  }

  const toggleImportRecipientPanel = (accountCampaignId: string) => {
    requestExecutionRecipients(accountCampaignId)
    setOpenImportRecipientExecutionId((current) => (current === accountCampaignId ? null : accountCampaignId))
    setOpenManualRecipientExecutionId((current) => (current === accountCampaignId ? null : current))
  }

  const buildExecutionQueuePreview = (
    execution: CampaignExecutionSummary,
    executionRecipients: OutreachRecipient[],
  ): QueuePreviewItem[] => {
    const recipientById = new Map(executionRecipients.map((recipient) => [recipient.id, recipient]))
    const variantById = new Map(execution.variants.map((variant) => [variant.id, variant]))
    return (queueItemsByAccountCampaignId[execution.accountCampaignId] ?? [])
      .map((item) => {
        const recipient = recipientById.get(item.recipient_id)
        const variant = item.variant_id ? variantById.get(item.variant_id) : undefined
        return {
          queueId: item.id,
          workspaceId: item.workspace_id,
          accountId: item.account_id,
          accountCampaignId: item.account_campaign_id,
          recipientId: item.recipient_id,
          recipientName: recipient?.contact_name ?? null,
          phoneNumber: recipient?.phone_number ?? null,
          variantId: item.variant_id,
          variantLabel: variant ? getVariantLabel(variant.variantIndex) : null,
          scheduledFor: item.scheduled_for,
          status: item.status,
          attempts: item.attempts,
          lastError: item.last_error,
        }
      })
  }

  return (
    <main className="ia-outreach-page">
      <section className="ia-outreach-shell">
        <header className="ia-outreach-header">
          <div>
            <span>{workspaceName ?? 'Workspace'}</span>
            <h1>Prospecção Assistida por IA</h1>
            <p>Agentes independentes de WhatsApp com aquecimento inteligente, mensagens variáveis e atendimento receptivo 24h.</p>
          </div>
          {isLegacySdrRoute ? <strong>Compatibilidade ativa via rota /ia-sdr</strong> : null}
        </header>

        <section className="ia-outreach-kpis" aria-label="Resumo operacional estrutural">
          <article><h2>Contas conectadas</h2><strong>{connectedAccounts}</strong></article>
          <article><h2>Contas em aquecimento</h2><strong>{warmingAccounts}</strong></article>
          <article><h2>Campanhas ativas</h2><strong>{activeCampaigns}</strong></article>
          <article><h2>Mensagens na fila</h2><strong>{queueCounts.pending + queueCounts.scheduled}</strong></article>
          <article><h2>Conversas abertas</h2><strong>{conversationCounts.open}</strong></article>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Fila Inteligente</span>
              <h2>Preparação estrutural por conta e campanha</h2>
            </div>
          </div>
          <p className="ia-outreach-notice">Fila estrutural preparada. Nenhuma mensagem real é enviada nesta etapa.</p>
          <div className="ia-outreach-kpis ia-outreach-queue-kpis">
            <article><h3>Mensagens pendentes</h3><strong>{queueCounts.pending}</strong></article>
            <article><h3>Mensagens agendadas</h3><strong>{queueCounts.scheduled}</strong></article>
            <article><h3>Próxima janela estimada</h3><strong>{formatSchedule(nextQueueWindow)}</strong></article>
          </div>

          <div className="ia-outreach-queue-grid">
            {queueCampaignRows.length === 0 ? <p>Sem vínculos conta+campanha para preparar fila estrutural.</p> : null}
            {queueCampaignRows.map((row) => (
              <article key={row.accountCampaign.id} className="ia-outreach-queue-card">
                <h3>{row.campaign?.name ?? 'Campanha sem nome'}</h3>
                <p>Conta responsável: {row.account?.display_name ?? 'Conta não encontrada'}</p>
                <p>Campanha vinculada: {row.campaign?.name ?? row.accountCampaign.campaign_id}</p>
                <p>Status da fila: {describeQueueStatus(row)}</p>
                <p>Mensagens pendentes: {row.pending}</p>
                <p>Mensagens agendadas: {row.scheduled}</p>
                <p>Próxima janela estimada: {formatSchedule(row.nextScheduled ?? null)}</p>
                <button type="button" disabled={loading || preparingQueue} onClick={() => void prepareAccountCampaignQueue(row.accountCampaign.id)}>
                  Preparar fila estrutural
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Contas WhatsApp Independentes</span>
              <h2>Até 5 contas por workspace (QR Code nesta etapa)</h2>
            </div>
            <button type="button" disabled={saving || accounts.length >= maxAccountsPerWorkspace} onClick={() => void createAccountSlot()}>
              Criar conta base
            </button>
          </div>
          {warmupSuggestionFeedback ? <p className="ia-outreach-notice">{warmupSuggestionFeedback}</p> : null}
          <div className="ia-outreach-account-grid">
            {accountSlots.map((account, index) => (
              <article key={account?.id ?? `slot-${index}`} className="ia-outreach-account-card">
                {account ? (
                  <>
                    <span className={`ia-outreach-status ${account.status}`}>{accountStatusLabel[account.status]}</span>
                    <h3>{account.display_name}</h3>
                    <p>Saúde: {account.health_score}% · Aquecimento: nível {account.warmup_level}</p>
                    <p>Operação: {account.start_time ?? 'Sem início'} - {account.end_time ?? 'Sem fim'}</p>
                    <p>Campanhas vinculadas: {(linkedCampaignsByAccount[account.id] ?? []).map((item) => item.name).join(', ') || 'Nenhuma'}</p>
                    <p>
                      Janela sugerida: {warmupSuggestions[account.id]?.suggestedStartTime ?? '--:--'} - {warmupSuggestions[account.id]?.suggestedEndTime ?? '--:--'}
                    </p>
                    <p>
                      Ritmo estimado: {warmupProfiles[account.id]?.hourlyRange.min ?? '--'} a {warmupProfiles[account.id]?.hourlyRange.max ?? '--'} msg/h
                    </p>
                    <p>Próximo horário sugerido: {formatSchedule(accountQueueSnapshots[account.id]?.nextScheduled ?? null)}</p>
                    <p>
                      Status aquecimento: {warmupProfiles[account.id]?.pauseRecommended ? 'Pausar estrutural' : 'Operação estrutural liberada'}
                    </p>
                    <p>
                      Total na fila: {accountQueueSnapshots[account.id]?.total ?? 0} ({accountQueueSnapshots[account.id]?.pending ?? 0} pendente / {accountQueueSnapshots[account.id]?.scheduled ?? 0} agendada)
                    </p>
                    <div className="ia-outreach-account-actions">
                      <button type="button" onClick={() => setConfigAccountId(account.id)}>Configurar</button>
                      <button type="button" onClick={() => void toggleActive(account)}>{account.is_active ? 'Pausar visual' : 'Ativar visual'}</button>
                      <button type="button" disabled={preparingQueue || loading} onClick={() => void prepareQueueForAccount(account.id)}>
                        Preparar fila
                      </button>
                      <button type="button" onClick={() => addStructuralLog(`Histórico solicitado para ${account.display_name}.`)}>Ver histórico</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="ia-outreach-status empty">Slot disponível</span>
                    <h3>Conta {index + 1}</h3>
                    <p>Sem conta configurada neste slot.</p>
                    <button type="button" disabled={saving || accounts.length >= maxAccountsPerWorkspace} onClick={() => void createAccountSlot()}>
                      Criar conta neste slot
                    </button>
                  </>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Campanhas</span>
              <h2>Base estrutural de prospecção por conta independente</h2>
            </div>
          </div>

          <p className="ia-outreach-notice">
            Cada conta executará esta campanha de forma independente, com histórico, ritmo e variações próprias.
          </p>

          <form className="ia-outreach-form" onSubmit={submitCampaign}>
            <label>
              Nome da campanha
              <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} required />
            </label>
            <label>
              Objetivo
              <input value={form.objective} onChange={(event) => setForm((current) => ({ ...current, objective: event.target.value }))} />
            </label>
            <label className="full">
              Mensagem principal
              <textarea value={form.baseMessage} onChange={(event) => setForm((current) => ({ ...current, baseMessage: event.target.value }))} rows={4} required />
            </label>
            <label>
              Tom desejado
              <input value={form.tone} onChange={(event) => setForm((current) => ({ ...current, tone: event.target.value }))} />
            </label>
            <label>
              Horário inicial permitido
              <input type="time" value={form.startTime} onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))} />
            </label>
            <label>
              Horário final permitido
              <input type="time" value={form.endTime} onChange={(event) => setForm((current) => ({ ...current, endTime: event.target.value }))} />
            </label>
            <fieldset className="full">
              <legend>Dias ativos</legend>
              <div className="ia-outreach-day-grid">
                {weekDays.map((day) => (
                  <label key={day.id} className="ia-outreach-day">
                    <input type="checkbox" checked={form.activeDays.includes(day.id)} onChange={() => updateActiveDay(day.id)} />
                    <span>{day.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="full">
              <legend>Contas selecionadas</legend>
              <div className="ia-outreach-account-pick-list">
                {accounts.length === 0 ? <p>Nenhuma conta disponível ainda.</p> : null}
                {accounts.map((account) => (
                  <label key={account.id} className="ia-outreach-account-pick">
                    <input type="checkbox" checked={form.selectedAccountIds.includes(account.id)} onChange={() => toggleCampaignAccount(account.id)} />
                    <span>{account.display_name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="full" type="submit" disabled={saving || loading}>Criar campanha estrutural</button>
          </form>

          <div className="ia-outreach-campaign-list">
            {campaigns.map((campaign) => (
              <article key={campaign.id}>
                <span>{campaign.status}</span>
                <h3>{campaign.name}</h3>
                <p>Objetivo: {campaign.objective ?? 'Sem objetivo definido.'}</p>
                <p>Contas vinculadas: {executionByCampaign.get(campaign.id)?.length ?? 0}</p>
                <p>Mensagem base: {summarizeBaseMessage(campaign.base_message)}</p>
                <p>Criada em: {formatDateTime(campaign.created_at)}</p>
                <button type="button" onClick={() => toggleCampaignExecutions(campaign.id)}>
                  {expandedCampaignIds.includes(campaign.id) ? 'Ocultar execuções' : 'Ver execuções'}
                </button>

                {expandedCampaignIds.includes(campaign.id) ? (
                  <div className="ia-outreach-execution-list">
                    {(executionByCampaign.get(campaign.id) ?? []).length === 0 ? (
                      <p>Sem execuções independentes registradas para esta campanha.</p>
                    ) : null}
                    {(executionByCampaign.get(campaign.id) ?? []).map((execution) => {
                      const summary = recipientSummariesByExecution[execution.accountCampaignId]
                      const executionRecipients = recipientsByExecution[execution.accountCampaignId] ?? []
                      const executionRecipientsLoading = loadingRecipientsByExecution[execution.accountCampaignId] ?? false
                      const executionRecipientLoadError = recipientLoadErrorByExecution[execution.accountCampaignId] ?? null
                      const recipientStatusFilter = getRecipientStatusFilter(execution.accountCampaignId)
                      const recipientSearch = getRecipientSearchInput(execution.accountCampaignId)
                      const recipientSearchApplied = getRecipientSearchApplied(execution.accountCampaignId)
                      const recipientPagination = recipientPaginationByExecution[execution.accountCampaignId]
                      const totalExecutionRecipients = recipientPagination?.total ?? summary?.total ?? executionRecipients.length
                      const pageSize = recipientPagination?.pageSize ?? recipientsPageSize
                      const totalRecipientPages = recipientPagination?.totalPages ?? Math.max(1, Math.ceil(totalExecutionRecipients / pageSize))
                      const currentRecipientPage = Math.min(
                        Math.max(recipientPageByExecution[execution.accountCampaignId] ?? recipientPagination?.page ?? 1, 1),
                        totalRecipientPages,
                      )
                      const recipientStartPosition = totalExecutionRecipients === 0 ? 0 : ((currentRecipientPage - 1) * pageSize) + 1
                      const recipientEndPosition = totalExecutionRecipients === 0
                        ? 0
                        : Math.min(((currentRecipientPage - 1) * pageSize) + executionRecipients.length, totalExecutionRecipients)
                      const visibleExecutionRecipients = executionRecipients
                      const shouldShowRecipientPagination = !executionRecipientsLoading
                        && !executionRecipientLoadError
                        && totalExecutionRecipients > pageSize
                      const hasActiveRecipientFilters = recipientStatusFilter !== 'all' || recipientSearchApplied.length > 0
                      const manualForm = recipientFormsByExecution[execution.accountCampaignId] ?? initialRecipientFormState
                      const importResult = recipientImportResultByExecution[execution.accountCampaignId]
                      const importText = recipientImportTextByExecution[execution.accountCampaignId] ?? ''
                      const queueGeneration = queueGenerationByExecution[execution.accountCampaignId]
                      const queueGenerationState = queueGenerationStateByExecution[execution.accountCampaignId] ?? 'idle'
                      const queuePreviewItems = buildExecutionQueuePreview(execution, executionRecipients)

                      return (
                        <article key={execution.accountCampaignId} className="ia-outreach-execution-card">
                          <h4>{execution.accountDisplayName ?? execution.accountId}</h4>
                          <p>Status da execução: {execution.status}</p>
                          <p>Seed independente: {execution.independentSeed ?? 'não definido'}</p>
                          <p>Total de variações: {execution.totalVariants}</p>
                          <p>{execution.note}</p>
                          <div className="ia-outreach-execution-variants">
                            {execution.variants.map((variant) => (
                              <article key={variant.id}>
                                <strong>{getVariantLabel(variant.variantIndex)}</strong>
                                <p>{variant.content}</p>
                              </article>
                            ))}
                          </div>

                          <section className="ia-outreach-execution-queue-actions">
                            <div className="ia-outreach-execution-queue-buttons">
                              <button
                                type="button"
                                disabled={queueGenerationState === 'running'}
                                onClick={() => void handleGenerateExecutionQueue(execution)}
                              >
                                {queueGenerationState === 'running' ? 'Gerando fila...' : 'Gerar fila estrutural'}
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleExecutionQueuePreview(execution.accountCampaignId)}
                              >
                                {expandedExecutionQueues.includes(execution.accountCampaignId) ? 'Ocultar fila da execução' : 'Ver fila da execução'}
                              </button>
                            </div>

                            {queueGeneration ? (
                              <div className="ia-outreach-execution-queue-summary">
                                <p>Destinatários encontrados: {queueGeneration.totalRecipients}</p>
                                <p>Elegíveis: {queueGeneration.eligibleRecipients}</p>
                                <p>Já estavam na fila: {queueGeneration.alreadyQueued}</p>
                                <p>Agendados: {queueGeneration.scheduled}</p>
                                <p>Ignorados: {queueGeneration.skipped}</p>
                                <p>Falhas: {queueGeneration.failed}</p>
                                <p>Próximo horário previsto: {queueGeneration.nextScheduledFor ? formatDateTime(queueGeneration.nextScheduledFor) : 'Não previsto'}</p>
                              </div>
                            ) : null}

                            {expandedExecutionQueues.includes(execution.accountCampaignId) ? (
                              <div className="ia-outreach-execution-queue-preview">
                                {queuePreviewItems.length === 0 ? <p>Nenhum item de fila nesta execução.</p> : null}
                                {queuePreviewItems.map((item) => (
                                  <article key={item.queueId}>
                                    <strong>{item.recipientName ?? 'Sem nome'} · {item.phoneNumber ?? 'Sem telefone'}</strong>
                                    <p>Variante: {item.variantLabel ?? item.variantId ?? 'Não identificada'}</p>
                                    <p>Horário: {item.scheduledFor ? formatDateTime(item.scheduledFor) : 'Sem agendamento'}</p>
                                    <p>Status: {queueStatusLabel[item.status]}</p>
                                    <p>Tentativas: {item.attempts}</p>
                                    <p>Erro: {item.lastError ?? 'Sem erro'}</p>
                                  </article>
                                ))}
                              </div>
                            ) : null}
                          </section>

                          <section className="ia-outreach-recipients-section">
                            <div className="ia-outreach-recipients-header">
                              <h5>Destinatários da Execução</h5>
                              <div className="ia-outreach-recipients-actions">
                                <button type="button" onClick={() => toggleManualRecipientPanel(execution.accountCampaignId)}>
                                  Adicionar destinatário
                                </button>
                                <button type="button" onClick={() => toggleImportRecipientPanel(execution.accountCampaignId)}>
                                  Importar lista
                                </button>
                              </div>
                            </div>
                            <p className="ia-outreach-recipients-isolation">
                              Estes destinatários pertencem somente a esta execução conta+campanha. Outra conta usando a mesma campanha terá sua própria lista e histórico.
                            </p>
                            <p>
                              Total de destinatários: {summary?.total ?? executionRecipients.length} · Queued: {summary?.queued ?? 0} · Replied: {summary?.replied ?? 0}
                            </p>
                            <div className="ia-outreach-recipients-filters">
                              <label>
                                Status
                                <select
                                  value={recipientStatusFilter}
                                  onChange={(event) => {
                                    const nextStatus = event.target.value as RecipientStatusFilter
                                    void applyRecipientFilters(execution.accountCampaignId, {
                                      status: nextStatus,
                                      search: recipientSearchApplied,
                                    }).catch(() => undefined)
                                  }}
                                >
                                  {recipientStatusFilterOptions.map((option) => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                              </label>
                              <label>
                                Busca
                                <input
                                  value={recipientSearch}
                                  onChange={(event) =>
                                    setRecipientSearchByExecution((current) => ({
                                      ...current,
                                      [execution.accountCampaignId]: event.target.value,
                                    }))
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key !== 'Enter') {
                                      return
                                    }
                                    event.preventDefault()
                                    void applyRecipientFilters(execution.accountCampaignId, {
                                      status: recipientStatusFilter,
                                      search: recipientSearch,
                                    }).catch(() => undefined)
                                  }}
                                  placeholder="Nome ou telefone"
                                />
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  void applyRecipientFilters(execution.accountCampaignId, {
                                    status: recipientStatusFilter,
                                    search: recipientSearch,
                                  }).catch(() => undefined)
                                }
                              >
                                Buscar
                              </button>
                              <button
                                type="button"
                                disabled={!hasActiveRecipientFilters && recipientSearch.length === 0}
                                onClick={() => {
                                  void applyRecipientFilters(execution.accountCampaignId, {
                                    status: 'all',
                                    search: '',
                                  }).catch(() => undefined)
                                }}
                              >
                                Limpar filtros
                              </button>
                            </div>

                            {openManualRecipientExecutionId === execution.accountCampaignId ? (
                              <div className="ia-outreach-recipient-form">
                                <label>
                                  Nome (opcional)
                                  <input
                                    value={manualForm.contactName}
                                    onChange={(event) =>
                                      setRecipientFormState(execution.accountCampaignId, (current) => ({
                                        ...current,
                                        contactName: event.target.value,
                                      }))
                                    }
                                  />
                                </label>
                                <label>
                                  Telefone
                                  <input
                                    value={manualForm.phoneNumber}
                                    onChange={(event) =>
                                      setRecipientFormState(execution.accountCampaignId, (current) => ({
                                        ...current,
                                        phoneNumber: event.target.value,
                                      }))
                                    }
                                  />
                                </label>
                                <button
                                  type="button"
                                  disabled={savingRecipients}
                                  onClick={() => void handleAddRecipient(execution.accountCampaignId)}
                                >
                                  Salvar destinatário
                                </button>
                              </div>
                            ) : null}

                            {openImportRecipientExecutionId === execution.accountCampaignId ? (
                              <div className="ia-outreach-recipient-import">
                                <p>
                                  Cole uma lista com telefone ou nome + telefone. Cada linha será tratada como destinatário desta execução específica.
                                </p>
                                <textarea
                                  rows={6}
                                  value={importText}
                                  onChange={(event) =>
                                    setRecipientImportTextByExecution((current) => ({
                                      ...current,
                                      [execution.accountCampaignId]: event.target.value,
                                    }))
                                  }
                                  placeholder={`61999990000\nJoão Silva, 61999990000\nMaria Souza; 61988880000\nCarlos | 61977770000`}
                                />
                                <button
                                  type="button"
                                  disabled={savingRecipients}
                                  onClick={() => void handleBulkImportRecipients(execution.accountCampaignId)}
                                >
                                  Importar destinatários
                                </button>
                                {importResult ? (
                                  <div className="ia-outreach-recipient-import-summary">
                                    <p>Total recebido: {importResult.totalReceived}</p>
                                    <p>Válidos: {importResult.valid}</p>
                                    <p>Importados: {importResult.imported}</p>
                                    <p>Duplicados no lote: {importResult.duplicatesInBatch}</p>
                                    <p>Duplicados na execução: {importResult.duplicatesInExecution}</p>
                                    <p>Inválidos: {importResult.invalid}</p>
                                    <p>Ignorados: {importResult.ignored}</p>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="ia-outreach-recipient-list">
                              {executionRecipientsLoading ? <p>Carregando destinatários desta execução...</p> : null}
                              {executionRecipientLoadError ? <p>{executionRecipientLoadError}</p> : null}
                              {!executionRecipientsLoading && !executionRecipientLoadError && executionRecipients.length === 0 ? (
                                <p>
                                  {hasActiveRecipientFilters
                                    ? 'Nenhum destinatário encontrado com os filtros atuais.'
                                    : 'Nenhum destinatário cadastrado nesta execução.'}
                                </p>
                              ) : null}
                              {!executionRecipientsLoading && !executionRecipientLoadError && totalExecutionRecipients > 0 ? (
                                <p>
                                  Exibindo {recipientStartPosition}-{recipientEndPosition} de {totalExecutionRecipients} destinatários
                                </p>
                              ) : null}
                              {visibleExecutionRecipients.map((recipient) => (
                                <article key={recipient.id}>
                                  <strong>{recipient.contact_name ?? 'Sem nome'}</strong>
                                  <p>Telefone: {recipient.phone_number}</p>
                                  <p>Status: {recipientStatusLabel[recipient.status]}</p>
                                  <p>Criado em: {formatDateTime(recipient.created_at)}</p>
                                </article>
                              ))}
                              {shouldShowRecipientPagination ? (
                                <div className="ia-outreach-recipient-pagination">
                                  <button
                                    type="button"
                                    disabled={currentRecipientPage <= 1}
                                    onClick={() => goToRecipientPage(execution.accountCampaignId, currentRecipientPage - 1)}
                                  >
                                    Anterior
                                  </button>
                                  <span>Página {currentRecipientPage} de {totalRecipientPages}</span>
                                  <button
                                    type="button"
                                    disabled={currentRecipientPage >= totalRecipientPages}
                                    onClick={() => goToRecipientPage(execution.accountCampaignId, currentRecipientPage + 1)}
                                  >
                                    Próxima
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </section>
                        </article>
                      )
                    })}
                  </div>
                ) : null}
              </article>
            ))}
            {!loading && campaigns.length === 0 ? <p>Nenhuma campanha criada nesta base estrutural.</p> : null}
          </div>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Geração de variações</span>
              <h2>Placeholder técnico (sem provedor IA externo nesta etapa)</h2>
            </div>
          </div>
          <p>Mensagem base do usuário permanece intacta. As 4 variações abaixo são estruturais para próximas etapas.</p>
          <div className="ia-outreach-variant-list">
            {variantPreview.length === 0 ? <p>Sem variações geradas nesta sessão.</p> : null}
            {variantPreview.map((variant, index) => <article key={`${index}-${variant}`}>{variant}</article>)}
          </div>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Aquecimento Inteligente</span>
              <h2>Motor estrutural sem cron e sem envio real</h2>
            </div>
          </div>
          <ul className="ia-outreach-list">
            <li>O usuário define horário inicial, final e dias ativos.</li>
            <li>O sistema sugere ritmo por conta, sem padrão global compartilhado.</li>
            <li>Cada execução conta+campanha usa seed independente.</li>
            <li>A evolução depende do histórico individual da conta.</li>
          </ul>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Atendimento receptivo 24h</span>
              <h2>Base visual de conversas independentes por conta</h2>
            </div>
          </div>
          <div className="ia-outreach-kpis conversations">
            <article><h3>Abertas</h3><strong>{conversationCounts.open}</strong></article>
            <article><h3>Aguardando IA</h3><strong>{conversationCounts.waitingAgent}</strong></article>
            <article><h3>Precisa humano</h3><strong>{conversationCounts.humanNeeded}</strong></article>
            <article><h3>Encerradas</h3><strong>{conversationCounts.closed}</strong></article>
          </div>
        </section>

        <section className="ia-outreach-panel">
          <div className="ia-outreach-panel-title">
            <div>
              <span>Logs estruturais</span>
              <h2>Sem envio real e sem integração externa</h2>
            </div>
          </div>
          <div className="ia-outreach-log-list">
            {structuralLogs.length === 0 ? <p>Nenhuma ação estrutural registrada nesta sessão.</p> : null}
            {structuralLogs.map((line) => <article key={line}>{line}</article>)}
          </div>
        </section>

        {feedback ? <div className="ia-outreach-feedback" role="status">{feedback}</div> : null}
      </section>

      {configAccount ? (
        <div className="ia-outreach-modal" role="dialog" aria-modal="true">
          <form className="ia-outreach-modal-content" onSubmit={saveAccountConfig}>
            <h2>Configurar conta</h2>
            <p>{configAccount.display_name}</p>
            <label>
              Timezone
              <input defaultValue={configAccount.timezone ?? 'America/Sao_Paulo'} name="timezone" />
            </label>
            <label>
              Horário inicial
              <input defaultValue={configAccount.start_time ?? '09:00'} name="start_time" type="time" />
            </label>
            <label>
              Horário final
              <input defaultValue={configAccount.end_time ?? '18:00'} name="end_time" type="time" />
            </label>
            <label>
              Limite diário (visual)
              <input defaultValue={configAccount.daily_limit ?? ''} min={1} name="daily_limit" type="number" />
            </label>
            <div className="ia-outreach-modal-actions">
              <button type="submit">Salvar estrutura</button>
              <button type="button" onClick={() => setConfigAccountId(null)}>Fechar</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  )
}
