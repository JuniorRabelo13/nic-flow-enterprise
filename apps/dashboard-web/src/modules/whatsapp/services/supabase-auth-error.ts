export const supabasePreviewConfigErrorMessage = 'Supabase não está configurado no ambiente do Preview. Verifique a conexão do banco no Lovable.'

export const isSupabaseAuthConfigError = (error: unknown) => {
  if (!error) {
    return false
  }

  const message = error instanceof Error ? error.message : String(error)
  const normalizedMessage = message.toLowerCase()
  return (
    normalizedMessage.includes('supabase') ||
    normalizedMessage.includes('auth') ||
    normalizedMessage.includes('cannot read properties of null') ||
    normalizedMessage.includes("reading 'auth'") ||
    normalizedMessage.includes('reading "auth"') ||
    normalizedMessage.includes('not configured')
  )
}

export const getSupabaseAuthErrorMessage = (error: unknown, fallback = 'Não foi possível autenticar.') =>
  isSupabaseAuthConfigError(error) ? supabasePreviewConfigErrorMessage : fallback
