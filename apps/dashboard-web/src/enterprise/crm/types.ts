export type CrmOwner = {
  id: string
  name: string
}

export type CrmTag = {
  id: string
  label: string
  color: string
}

export type PipelineStage = {
  id: string
  name: string
  order: number
  automations: string[]
}

export type CrmPipeline = {
  id: string
  workspaceId: string
  name: string
  stages: PipelineStage[]
}

export type CrmActivity = {
  id: string
  dealId: string
  ownerId: string
  type: 'call' | 'message' | 'email' | 'task' | 'note'
  description: string
  createdAt: string
}

export type DealHistory = {
  id: string
  dealId: string
  actorId: string
  fromStageId?: string
  toStageId?: string
  occurredAt: string
}
