/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_APP_ENV?: string
  readonly VITE_APP_VERSION?: string
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_SAMPLE_RATE?: string
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string
  readonly VITE_EVOLUTION_API_BASE_URL?: string
  readonly VITE_EVOLUTION_API_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
