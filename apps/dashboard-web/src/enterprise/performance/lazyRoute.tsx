import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

export const createLazyRoute = (importer: () => Promise<{ default: ComponentType }>, fallback: ReactNode = null) => {
  const Component = lazy(importer)
  return () => (
    <Suspense fallback={fallback}>
      <Component />
    </Suspense>
  )
}
