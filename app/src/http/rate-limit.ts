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
        // Make room in one pass: expired windows first, then the oldest tenth. Doing it in batches
        // keeps a flood of new keys from costing a full scan on every request.
        const t = now();
        const target = Math.floor(maxKeys * 0.9);
        for (const [k, v] of windows) {
          if (windows.size <= target) break;
          if (t - v.start >= options.windowMs || windows.size > target) windows.delete(k);
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

/**
 * A rate-limit key for a connecting address. IPv6 addresses count as their /64, so rotating through one
 * network's addresses is still one client; IPv4 and IPv4-mapped addresses are used whole.
 */
export function clientKeyFor(address: string | undefined): string {
  if (address === undefined || address === '') return 'unknown';
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1]) return mapped[1];
  if (!lower.includes(':')) return lower;
  // Expand "::" so the first four groups are the /64.
  const [head = '', tail] = lower.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  return `${groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':')}::/64`;
}
