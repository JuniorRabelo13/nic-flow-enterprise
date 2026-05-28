import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'

export const createLazyRoute = <T extends ComponentType<object>>(importer: () => Promise<{ default: T }>, fallback: ReactNode = null) => {
  const Component = lazy(importer)
  return () => (
    <Suspense fallback={fallback}>
      <Component />
    </Suspense>
  )
}
