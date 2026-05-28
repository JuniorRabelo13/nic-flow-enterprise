const tokenKey = 'nic.csrf'

const createToken = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const getCsrfToken = () => {
  const current = sessionStorage.getItem(tokenKey)
  if (current) {
    return current
  }

  const token = createToken()
  sessionStorage.setItem(tokenKey, token)
  return token
}
