// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { clientKeyFor, createRateLimiter } from './rate-limit.ts';

describe('rate limiter', () => {
  it('allows the limit, then refuses until the window ends', () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a')]).toEqual([true, true, true]);
    expect(limiter.limited('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.retryAfterSeconds('a')).toBe(60);
    now = 59_999;
    expect(limiter.limited('a')).toBe(true);
    expect(limiter.retryAfterSeconds('a')).toBe(1);
    now = 60_000;
    expect(limiter.limited('a')).toBe(false);
    expect(limiter.hit('a')).toBe(true);
  });

  it('counts each key on its own', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1_000 });
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('b')).toBe(true);
    expect(limiter.limited('c')).toBe(false);
  });

  it('does not grow past the most keys it was given', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (const k of ['a', 'b', 'c', 'd', 'e']) limiter.hit(k);
    // The oldest were dropped, so they start fresh; the newest are still counted.
    expect(limiter.limited('e')).toBe(true);
    expect(limiter.limited('a')).toBe(false);
  });
});

describe('clientKeyFor', () => {
  it('uses IPv4 whole, unwraps mapped addresses, and groups IPv6 by /64', () => {
    expect(clientKeyFor('192.168.4.27')).toBe('192.168.4.27');
    expect(clientKeyFor('::ffff:192.168.4.27')).toBe('192.168.4.27');
    expect(clientKeyFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:0db8:0001:0002::/64');
    expect(clientKeyFor('2001:DB8:1:2::1')).toBe('2001:0db8:0001:0002::/64');
    expect(clientKeyFor('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(clientKeyFor('2001:db8:1:2::1'));
    expect(clientKeyFor('::1')).toBe('0000:0000:0000:0000::/64');
    expect(clientKeyFor(undefined)).toBe('unknown');
    expect(clientKeyFor('')).toBe('unknown');
  });
});
