import { monitoredFetch } from '../requests/monitoredFetch'

export const prefetchResource = (path: string) => {
  void monitoredFetch(path, { method: 'GET', cachePolicy: 'stale-while-revalidate' })
}

export const prefetchRoute = (importer: () => Promise<unknown>) => {
  void importer()
}
