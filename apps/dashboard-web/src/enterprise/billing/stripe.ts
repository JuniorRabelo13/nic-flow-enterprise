import { monitoredFetch } from '../requests/monitoredFetch'
import { type PlanId } from './plans'

export type CheckoutSession = {
  url: string
}

export type BillingUsage = {
  workspaceId: string
  metric: string
  quantity: number
}

export const createSubscriptionCheckout = (workspaceId: string, planId: PlanId) =>
  monitoredFetch<CheckoutSession>('/billing/stripe/checkout', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, planId }),
    cachePolicy: 'network-only',
  })

export const reportBillingUsage = (usage: BillingUsage) =>
  monitoredFetch('/billing/usage', {
    method: 'POST',
    body: JSON.stringify(usage),
    cachePolicy: 'network-only',
  })
