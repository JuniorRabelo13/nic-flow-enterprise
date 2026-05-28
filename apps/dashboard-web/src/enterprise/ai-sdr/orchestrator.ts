import { monitoredFetch } from '../requests/monitoredFetch'
import { reportBillingUsage } from '../billing/stripe'
import { buildSdrPrompt, type PromptLayer } from './prompts'

export type SdrAgentRequest = {
  workspaceId: string
  conversationId: string
  contactId: string
  message: string
  promptLayer: PromptLayer
}

export type SdrAgentResponse = {
  reply: string
  inputTokens: number
  outputTokens: number
}

export const runSdrAgent = async (request: SdrAgentRequest) => {
  const response = await monitoredFetch<SdrAgentResponse>('/ai-sdr/agent/run', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: request.workspaceId,
      conversationId: request.conversationId,
      contactId: request.contactId,
      prompt: buildSdrPrompt(request.promptLayer, request.message),
    }),
    cachePolicy: 'network-only',
    retry: 2,
  })

  await reportBillingUsage({
    workspaceId: request.workspaceId,
    metric: 'ai_tokens',
    quantity: response.inputTokens + response.outputTokens,
  })

  return response
}
