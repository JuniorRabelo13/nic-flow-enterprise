import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { supabasePreviewConfigErrorMessage } from './supabase-auth-error'
export { getSupabaseAuthErrorMessage, supabasePreviewConfigErrorMessage } from './supabase-auth-error'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY

const isConfiguredValue = (value: string | undefined) => {
  const normalizedValue = value?.trim()
  return Boolean(normalizedValue && !normalizedValue.startsWith('COLE_AQUI_'))
}

const hasPublicSupabaseConfig = isConfiguredValue(supabaseUrl) && isConfiguredValue(supabasePublishableKey)

const createSupabaseClient = () => {
  if (!hasPublicSupabaseConfig) {
    return null
  }

  try {
    return createClient(supabaseUrl as string, supabasePublishableKey as string, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  } catch {
    return null
  }
}

export const supabase = createSupabaseClient()

export const hasSupabaseConfig = Boolean(supabase?.auth)

export const requireSupabaseAuth = (): SupabaseClient => {
  if (!supabase?.auth) {
    throw new Error(supabasePreviewConfigErrorMessage)
  }

  return supabase
}
