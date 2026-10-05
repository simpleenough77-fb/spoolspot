// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Scope, type Principal } from './principal.ts';
import { createMemorySessionStore } from './session.ts';

const principal: Principal = {
  subject: 'dev-token',
  tenantId: 'tenant-a',
  scopes: new Set([Scope.LocationsRead]),
};

describe('memory session store', () => {
  it('makes an unguessable ID and hands back the Principal for it', async () => {
    const store = createMemorySessionStore();
    const a = await store.create(principal);
    const b = await store.create(principal);
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.maxAgeSeconds).toBe(12 * 3600);
    expect(await store.get(a.id)).toEqual(principal);
  });

  it('refuses malformed, unknown and destroyed IDs alike', async () => {
    const store = createMemorySessionStore();
    const { id } = await store.create(principal);
    for (const bad of ['', 'short', `${id}x`, id.replace(/.$/, '!'), 'A'.repeat(43)]) {
      expect(await store.get(bad), bad).toBeNull();
    }
    await store.destroy(id);
    expect(await store.get(id)).toBeNull();
    await store.destroy('not an id');
  });

  it('expires a session after its lifetime', async () => {
    let now = 1_000;
    const store = createMemorySessionStore({ ttlMs: 5_000, now: () => now });
    const { id } = await store.create(principal);
    now += 4_999;
    expect(await store.get(id)).toEqual(principal);
    now += 1;
    expect(await store.get(id)).toBeNull();
  });

  it('keeps at most the configured number, dropping the oldest', async () => {
    const store = createMemorySessionStore({ max: 2 });
    const first = await store.create(principal);
    const second = await store.create(principal);
    const third = await store.create(principal);
    expect(await store.get(first.id)).toBeNull();
    expect(await store.get(second.id)).toEqual(principal);
    expect(await store.get(third.id)).toEqual(principal);
  });
});
