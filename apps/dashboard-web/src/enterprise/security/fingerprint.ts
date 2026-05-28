const fingerprintKey = 'nic.sessionFingerprint'

export const getSessionFingerprint = async () => {
  const existing = sessionStorage.getItem(fingerprintKey)
  if (existing) {
    return existing
  }

  const source = [navigator.userAgent, navigator.language, screen.width, screen.height, Intl.DateTimeFormat().resolvedOptions().timeZone].join('|')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
  sessionStorage.setItem(fingerprintKey, fingerprint)
  return fingerprint
}
