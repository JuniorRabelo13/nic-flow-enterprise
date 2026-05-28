type EnterpriseEnv = {
  apiBaseUrl: string
  appEnv: 'development' | 'staging' | 'production'
  appVersion: string
  sentryDsn?: string
  sentrySampleRate: number
  stripePublishableKey?: string
  evolutionApiBaseUrl?: string
  evolutionApiKey?: string
}

const parseRate = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback
}

export const enterpriseEnv: EnterpriseEnv = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? '/api',
  appEnv: (import.meta.env.VITE_APP_ENV ?? import.meta.env.MODE) as EnterpriseEnv['appEnv'],
  appVersion: import.meta.env.VITE_APP_VERSION ?? '0.0.0-local',
  sentryDsn: import.meta.env.VITE_SENTRY_DSN,
  sentrySampleRate: parseRate(import.meta.env.VITE_SENTRY_SAMPLE_RATE, 1),
  stripePublishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
  evolutionApiBaseUrl: import.meta.env.VITE_EVOLUTION_API_BASE_URL,
  evolutionApiKey: import.meta.env.VITE_EVOLUTION_API_KEY,
}

export const isProduction = enterpriseEnv.appEnv === 'production'
