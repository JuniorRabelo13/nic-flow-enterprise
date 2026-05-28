type Bucket = {
  tokens: number
  updatedAt: number
}

export class TokenBucketRateLimiter {
  private buckets = new Map<string, Bucket>()

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  consume(key: string, tokens = 1) {
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now }
    const elapsed = (now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond)
    bucket.updatedAt = now

    if (bucket.tokens < tokens) {
      this.buckets.set(key, bucket)
      return false
    }

    bucket.tokens -= tokens
    this.buckets.set(key, bucket)
    return true
  }
}

export const requestRateLimiter = new TokenBucketRateLimiter(90, 3)
export const bruteForceRateLimiter = new TokenBucketRateLimiter(5, 0.05)
