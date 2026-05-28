export const memoize = <Args extends readonly unknown[], Result>(
  fn: (...args: Args) => Result,
  keyFactory: (...args: Args) => string = (...args) => JSON.stringify(args),
) => {
  const cache = new Map<string, Result>()
  return (...args: Args) => {
    const key = keyFactory(...args)
    if (cache.has(key)) {
      return cache.get(key) as Result
    }

    const result = fn(...args)
    cache.set(key, result)
    return result
  }
}
