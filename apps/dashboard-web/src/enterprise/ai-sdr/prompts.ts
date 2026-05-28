export type PromptLayer = {
  system: string
  policy: string
  workspaceContext: string
}

export const buildSdrPrompt = (layer: PromptLayer, leadMessage: string) => [
  layer.system,
  layer.policy,
  layer.workspaceContext,
  `Mensagem do lead: ${leadMessage}`,
].join('\n\n')
