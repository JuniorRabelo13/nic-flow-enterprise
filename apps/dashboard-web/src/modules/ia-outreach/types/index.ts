export type OutreachAccountStatus =
  | 'draft'
  | 'disconnected'
  | 'connected'
  | 'warming'
  | 'paused'
  | 'risk'
  | 'blocked'

export type OutreachCampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived'

export type OutreachAccountCampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'stopped'

export type OutreachRecipientStatus = 'queued' | 'scheduled' | 'contacted' | 'replied' | 'paused' | 'removed' | 'failed'

export type OutreachMessageQueueStatus = 'pending' | 'scheduled' | 'processing' | 'sent' | 'failed' | 'cancelled' | 'skipped'

export type OutreachConversationStatus = 'open' | 'waiting_user' | 'waiting_agent' | 'human_needed' | 'closed'

export type OutreachConversationDirection = 'inbound' | 'outbound'

export type OutreachConversationSenderType = 'user' | 'ai' | 'human' | 'system'

export type OutreachWarmupEventType =
  | 'warmup_started'
  | 'warmup_increased'
  | 'warmup_decreased'
  | 'warmup_paused'
  | 'warmup_resumed'
  | 'manual_pause'
  | 'system_pause'
  | 'message_scheduled'
  | 'message_skipped'

export type OutreachAccount = {
  id: string
  workspace_id: string
  display_name: string
  phone_number: string | null
  connection_type: 'qrcode'
  status: OutreachAccountStatus
  health_score: number
  warmup_level: number
  daily_limit: number | null
  hourly_limit_min: number | null
  hourly_limit_max: number | null
  start_time: string | null
  end_time: string | null
  timezone: string | null
  active_days: string[] | null
  is_active: boolean
  last_connected_at: string | null
  last_activity_at: string | null
  created_at: string
  updated_at: string
}

export type OutreachCampaign = {
  id: string
  workspace_id: string
  name: string
  objective: string | null
  base_message: string
  status: OutreachCampaignStatus
  created_by: string | null
  created_at: string
  updated_at: string
}

export type OutreachAccountCampaign = {
  id: string
  workspace_id: string
  account_id: string
  campaign_id: string
  status: OutreachAccountCampaignStatus
  independent_seed: string | null
  warmup_profile: Record<string, unknown> | null
  started_at: string | null
  paused_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export type OutreachMessageVariant = {
  id: string
  workspace_id: string
  account_campaign_id: string
  variant_index: number
  content: string
  source: 'ai' | 'placeholder' | 'user'
  is_base: boolean
  created_at: string
}

export type OutreachRecipient = {
  id: string
  workspace_id: string
  account_campaign_id: string
  lead_id: string | null
  contact_name: string | null
  phone_number: string
  status: OutreachRecipientStatus
  last_message_at: string | null
  replied_at: string | null
  created_at: string
  updated_at: string
}

export type OutreachWarmupEvent = {
  id: string
  workspace_id: string
  account_id: string
  account_campaign_id: string | null
  event_type: OutreachWarmupEventType
  event_payload: Record<string, unknown> | null
  created_at: string
}

export type OutreachMessageQueue = {
  id: string
  workspace_id: string
  account_id: string
  account_campaign_id: string
  recipient_id: string
  variant_id: string | null
  scheduled_for: string | null
  status: OutreachMessageQueueStatus
  attempts: number
  last_error: string | null
  created_at: string
  updated_at: string
}

export type OutreachConversation = {
  id: string
  workspace_id: string
  account_id: string
  recipient_id: string | null
  phone_number: string
  status: OutreachConversationStatus
  last_inbound_at: string | null
  last_outbound_at: string | null
  assigned_to_human: boolean
  created_at: string
  updated_at: string
}

export type OutreachConversationMessage = {
  id: string
  workspace_id: string
  conversation_id: string
  account_id: string
  direction: OutreachConversationDirection
  content: string
  sender_type: OutreachConversationSenderType
  metadata: Record<string, unknown> | null
  created_at: string
}

export type CreateOutreachAccountInput = {
  workspaceId: string
  displayName: string
  timezone?: string | null
  startTime?: string | null
  endTime?: string | null
  activeDays?: string[] | null
}

export type UpdateOutreachAccountInput = Partial<{
  display_name: string
  phone_number: string | null
  status: OutreachAccountStatus
  health_score: number
  warmup_level: number
  daily_limit: number | null
  hourly_limit_min: number | null
  hourly_limit_max: number | null
  start_time: string | null
  end_time: string | null
  timezone: string | null
  active_days: string[] | null
  is_active: boolean
}>

export type CreateOutreachCampaignInput = {
  workspaceId: string
  name: string
  objective?: string | null
  baseMessage: string
}

export type CampaignFormState = {
  name: string
  objective: string
  baseMessage: string
  tone: string
  startTime: string
  endTime: string
  activeDays: string[]
  selectedAccountIds: string[]
}

export type CreateIndependentAccountCampaignInput = {
  workspaceId: string
  accountId: string
  campaignId: string
  warmupProfile?: Record<string, unknown> | null
}

export type MessageVariantPreview = {
  id: string
  accountCampaignId: string
  variantIndex: number
  content: string
  source: OutreachMessageVariant['source']
  isBase: boolean
  createdAt: string
}

export type CampaignExecutionSummary = {
  workspaceId: string
  campaignId: string
  accountCampaignId: string
  accountId: string
  accountDisplayName: string | null
  status: OutreachAccountCampaignStatus
  independentSeed: string | null
  createdAt: string
  totalVariants: number
  variants: MessageVariantPreview[]
  note: string
}

export type CreateCampaignWithExecutionsInput = {
  workspaceId: string
  name: string
  objective?: string | null
  baseMessage: string
  tone: string
  startTime?: string | null
  endTime?: string | null
  activeDays?: string[]
  selectedAccountIds: string[]
}

export type CreateCampaignWithExecutionsResult = {
  campaign: OutreachCampaign
  executions: CampaignExecutionSummary[]
  totalExecutions: number
  totalVariants: number
}

export type OutreachRecipientInput = {
  workspaceId: string
  accountCampaignId: string
  leadId?: string | null
  contactName?: string | null
  phoneNumber: string
  status?: OutreachRecipientStatus
}

export type BulkRecipientInput = {
  workspaceId: string
  accountCampaignId: string
  inputText: string
}

export type RecipientImportRow = {
  lineNumber: number
  raw: string
  contactName: string | null
  phoneNumberRaw: string
  normalizedPhoneNumber: string | null
  isValid: boolean
  reason: string | null
}

export type RecipientImportPreview = {
  rows: RecipientImportRow[]
  totalReceived: number
  valid: number
  invalid: number
  duplicatesInBatch: number
}

export type BulkRecipientResult = {
  accountCampaignId: string
  totalReceived: number
  valid: number
  invalid: number
  duplicatesInBatch: number
  duplicatesInExecution: number
  imported: number
  ignored: number
  rows: RecipientImportRow[]
  recipients: OutreachRecipient[]
}

export type RecipientFormState = {
  contactName: string
  phoneNumber: string
}

export type RecipientSummaryByExecution = {
  workspaceId: string
  accountCampaignId: string
  total: number
  queued: number
  scheduled: number
  contacted: number
  replied: number
  paused: number
  removed: number
  failed: number
}

export type WarmupWindowSuggestion = {
  accountId: string
  suggestedStartTime: string
  suggestedEndTime: string
  hourlyLimitMin: number
  hourlyLimitMax: number
  note: string
}

export type WarmupProfile = {
  workspaceId: string
  accountId: string
  seed: string
  timezone: string
  activeDays: string[]
  windowStartTime: string
  windowEndTime: string
  hourlyRange: {
    min: number
    max: number
  }
  dailyLimit: number
  warmupLevel: number
  pauseRecommended: boolean
  reason: string | null
}

export type WarmupScheduleSlot = {
  accountId: string
  accountCampaignId: string
  seed: string
  scheduledFor: string
  slotIndex: number
  jitterMinutes: number
}

export type QueueStatus = OutreachMessageQueueStatus

export type QueuePreviewItem = {
  queueId: string
  workspaceId: string
  accountId: string
  accountCampaignId: string
  recipientId: string
  recipientName: string | null
  phoneNumber: string | null
  variantId: string | null
  variantLabel: string | null
  scheduledFor: string | null
  status: QueueStatus
  attempts: number
  lastError: string | null
}

export type QueueGenerationSummary = {
  totalRecipients: number
  eligibleRecipients: number
  alreadyQueued: number
  scheduled: number
  skipped: number
  failed: number
}

export type QueueGenerationResult = {
  workspaceId: string
  accountId: string
  accountCampaignId: string
  totalRecipients: number
  eligibleRecipients: number
  alreadyQueued: number
  scheduled: number
  skipped: number
  failed: number
  nextScheduledFor: string | null
  message: string
}

export type QueueBuildResult = QueueGenerationResult & {
  createdCount: number
  skippedCount: number
  firstScheduledFor: string | null
  lastScheduledFor: string | null
  note: string
}

export type QueueGenerationState = 'idle' | 'running' | 'success' | 'error'

export type OutreachErrorCode =
  | 'DUPLICATE_VARIANT_INDEX'
  | 'DUPLICATE_ACTIVE_RECIPIENT'
  | 'DUPLICATE_ACTIVE_QUEUE_ITEM'
  | 'DUPLICATE_ACTIVE_ACCOUNT_CAMPAIGN'
  | 'DUPLICATE_OPEN_CONVERSATION'
  | 'WORKSPACE_SCOPE_VIOLATION'
  | 'OUTREACH_WORKSPACE_REQUIRED'
  | 'INVALID_ACCOUNT_CAMPAIGN'
  | 'OUTREACH_BACKEND_UNAVAILABLE'
  | 'OUTREACH_LOCAL_FALLBACK_DISABLED'
  | 'OUTREACH_PERSISTENCE_UNAVAILABLE'
  | 'UNKNOWN_OUTREACH_ERROR'

export type OutreachDomainError = Error & {
  code: OutreachErrorCode
  details?: Record<string, unknown>
}

export type QueueItemInput = {
  workspaceId: string
  accountId: string
  accountCampaignId: string
  recipientId: string
  variantId?: string | null
  scheduledFor: string
  status?: OutreachMessageQueueStatus
}

export type IndependentScheduleParams = {
  workspaceId: string
  accountId: string
  accountCampaignId: string
  warmupProfile: WarmupProfile
  desiredCount: number
  referenceAt?: string
  minSpacingMinutes?: number
}

export type AccountHealthSnapshot = {
  workspaceId: string
  accountId: string
  status: OutreachAccountStatus
  healthScore: number
  warmupLevel: number
  isActive: boolean
  pauseRecommended: boolean
  reason: string | null
}
