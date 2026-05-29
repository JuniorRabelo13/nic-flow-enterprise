type CacheEntry<T> = {
  value: T
  expiresAt: number
}

class ResourceCache {
  private readonly maxEntries = 500
  private entries = new Map<string, CacheEntry<unknown>>()

  get<T>(key: string) {
    const entry = this.entries.get(key)
    if (!entry || entry.expiresAt < Date.now()) {
      this.entries.delete(key)
      return undefined
    }

    return entry.value as T
  }

  set<T>(key: string, value: T, ttlMs = 60_000) {
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey) {
        this.entries.delete(oldestKey)
      }
    }

    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  invalidate(prefix: string) {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key)
      }
    }
  }
}

export const resourceCache = new ResourceCache()
