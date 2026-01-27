import type { Request, Response, NextFunction } from "express"

type RateLimitOptions = {
  windowMs: number
  max: number
}

type Bucket = {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

function getClientIp(req: Request) {
  const forwarded = req.headers["x-forwarded-for"]
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim()
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]
  }
  return req.ip ?? "unknown"
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req)
    const now = Date.now()
    const bucket = buckets.get(ip)

    if (!bucket || now - bucket.windowStart >= options.windowMs) {
      buckets.set(ip, { count: 1, windowStart: now })
      return next()
    }

    bucket.count += 1

    if (bucket.count > options.max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((options.windowMs - (now - bucket.windowStart)) / 1000)
      )
      res.setHeader("Retry-After", retryAfterSeconds.toString())
      return res
        .status(429)
        .json({ error: "Too many requests. Please try again later." })
    }

    return next()
  }
}
