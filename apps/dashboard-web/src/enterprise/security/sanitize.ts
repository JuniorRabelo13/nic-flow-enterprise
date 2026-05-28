const dangerousPattern = /<script[\s\S]*?>[\s\S]*?<\/script>|on\w+="[^"]*"|javascript:/gi

export const sanitizeText = (value: string) => value.replace(dangerousPattern, '').trim()

export const sanitizePayload = <T>(value: T): T => {
  if (typeof value === 'string') {
    return sanitizeText(value) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePayload(item)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [sanitizeText(key), sanitizePayload(item)]),
    ) as T
  }

  return value
}
