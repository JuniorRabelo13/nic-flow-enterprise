import { monitoredFetch } from '../requests/monitoredFetch'
import { type CrmActivity, type CrmPipeline, type DealHistory } from './types'

export const crmClient = {
  listPipelines(workspaceId: string) {
    return monitoredFetch<CrmPipeline[]>(`/crm/workspaces/${workspaceId}/pipelines`, { method: 'GET', cachePolicy: 'cache-first' })
  },
  createActivity(activity: Omit<CrmActivity, 'id' | 'createdAt'>) {
    return monitoredFetch<CrmActivity>('/crm/activities', {
      method: 'POST',
      body: JSON.stringify(activity),
      cachePolicy: 'network-only',
    })
  },
  listHistory(dealId: string) {
    return monitoredFetch<DealHistory[]>(`/crm/deals/${dealId}/history`, { method: 'GET', cachePolicy: 'stale-while-revalidate' })
  },
}
