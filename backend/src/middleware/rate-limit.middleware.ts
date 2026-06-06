import type { NextFunction, Request, Response } from 'express'

type Bucket = { count: number; resetAt: number }

/**
 * Lightweight in-memory fixed-window rate limiter. Suitable for a single-instance
 * deployment; swap for a Redis-backed limiter when running multiple instances.
 */
export function rateLimit(options: { windowMs: number; max: number; keyPrefix?: string; message?: string }) {
  const buckets = new Map<string, Bucket>()
  const { windowMs, max, keyPrefix = 'rl', message = 'Too many requests. Please try again later.' } = options

  // Periodically evict expired buckets so the map does not grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key)
  }, windowMs)
  if (typeof sweep.unref === 'function') sweep.unref()

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const identifier = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : ''
    const key = `${keyPrefix}:${ip}:${identifier}`
    const now = Date.now()
    const bucket = buckets.get(key)

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    bucket.count += 1
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({ code: 'RATE_LIMITED', message })
    }
    return next()
  }
}
