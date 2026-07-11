export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

const defaultRetry: Required<RetryOptions> = {
  attempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs } = { ...defaultRetry, ...opts }
  let lastErr: unknown

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) {
        const delay = Math.min(baseDelayMs * 2 ** i, maxDelayMs)
        const jitter = Math.random() * delay * 0.2
        await new Promise((r) => setTimeout(r, delay + jitter))
      }
    }
  }

  throw lastErr
}
