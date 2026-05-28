export type PlanId = 'starter' | 'growth' | 'scale' | 'enterprise'

export type PlanLimits = {
  workspaces: number
  seats: number
  whatsappSessions: number
  aiTokensPerMonth: number
  crmPipelines: number
}

export const planLimits: Record<PlanId, PlanLimits> = {
  starter: { workspaces: 1, seats: 3, whatsappSessions: 1, aiTokensPerMonth: 50_000, crmPipelines: 2 },
  growth: { workspaces: 3, seats: 15, whatsappSessions: 5, aiTokensPerMonth: 250_000, crmPipelines: 10 },
  scale: { workspaces: 10, seats: 50, whatsappSessions: 25, aiTokensPerMonth: 1_000_000, crmPipelines: 50 },
  enterprise: { workspaces: 999, seats: 999, whatsappSessions: 999, aiTokensPerMonth: 10_000_000, crmPipelines: 999 },
}

export const canUseFeature = (planId: PlanId, feature: keyof PlanLimits, currentUsage: number) => currentUsage < planLimits[planId][feature]
