// SPDX-License-Identifier: AGPL-3.0-or-later
// A small fixed-window rate limiter kept in memory. Enough for one process (development, a Pi); the
// hosted tier puts a shared limiter at the edge. Keys are client addresses, which are not stored
// beyond the window. Web Standard APIs only.

export interface RateLimiter {
  /** Counts one attempt for `key`. False once the window's limit is used up. */
  hit(key: string): boolean;
  /** True when `key` has used up the window, without counting an attempt. */
  limited(key: string): boolean;
  /** Seconds until the window for `key` resets (at least 1). */
  retryAfterSeconds(key: string): number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** Most keys tracked at once, so a flood of addresses cannot grow memory without bound. */
  maxKeys?: number;
  now?: () => number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const windows = new Map<string, { start: number; count: number }>();

  const current = (key: string): { start: number; count: number } | undefined => {
    const w = windows.get(key);
    if (w && now() - w.start >= options.windowMs) {
      windows.delete(key);
      return undefined;
    }
    return w;
  };

  return {
    hit(key) {
      const w = current(key);
      if (w) {
        w.count += 1;
        return w.count <= options.limit;
      }
      if (windows.size >= maxKeys) {
        const t = now();
        for (const [k, v] of windows) if (t - v.start >= options.windowMs) windows.delete(k);
        // Still full of live windows: drop the oldest rather than refuse everyone.
        while (windows.size >= maxKeys) {
          const oldest = windows.keys().next();
          if (oldest.done) break;
          windows.delete(oldest.value);
        }
      }
      windows.set(key, { start: now(), count: 1 });
      return options.limit >= 1;
    },
    limited(key) {
      const w = current(key);
      return w !== undefined && w.count >= options.limit;
    },
    retryAfterSeconds(key) {
      const w = windows.get(key);
      if (!w) return 1;
      return Math.max(1, Math.ceil((w.start + options.windowMs - now()) / 1000));
    },
  };
}
