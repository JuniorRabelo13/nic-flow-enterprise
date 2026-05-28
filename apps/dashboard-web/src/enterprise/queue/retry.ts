export type RetryPolicy = {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

export const withRetry = async <T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < policy.attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt)
      await sleep(delay)
    }
  }

  throw lastError
}
