export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private lastCleanupAt = Date.now();

  constructor(maxAttempts: number, windowMs: number) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }

  check(key: string, now = Date.now()): RateLimitResult {
    this.maybeCleanup(now);
    const cutoff = now - this.windowMs;
    const recent = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);

    if (recent.length >= this.maxAttempts) {
      const oldest = recent[0];
      const retryAfterMs = Math.max(1000, oldest + this.windowMs - now);
      this.buckets.set(key, recent);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      };
    }

    recent.push(now);
    this.buckets.set(key, recent);
    return {
      allowed: true,
      remaining: Math.max(0, this.maxAttempts - recent.length),
      retryAfterSeconds: 0,
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < this.windowMs) {
      return;
    }
    this.lastCleanupAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.buckets.entries()) {
      const filtered = timestamps.filter((ts) => ts > cutoff);
      if (filtered.length === 0) {
        this.buckets.delete(key);
      } else {
        this.buckets.set(key, filtered);
      }
    }
  }
}
