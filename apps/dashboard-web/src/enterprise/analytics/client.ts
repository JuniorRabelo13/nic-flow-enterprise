import { monitoredFetch } from '../requests/monitoredFetch'
import { metricsStore, type MetricPoint } from './metrics'

export type DashboardKpis = {
  revenue: number
  activeWorkspaces: number
  conversionRate: number
  averageResponseTimeMs: number
}

export const analyticsClient = {
  async loadKpis(workspaceId: string) {
    return monitoredFetch<DashboardKpis>(`/analytics/workspaces/${workspaceId}/kpis`, { method: 'GET', cachePolicy: 'stale-while-revalidate' })
  },
  ingestRealtimeMetric(point: MetricPoint) {
    metricsStore.push(point)
  },
}
