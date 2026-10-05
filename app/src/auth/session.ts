// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser sessions, so a phone that has signed in once can tap tag after tag without typing again.
// The session ID is 256 random bits, travels only in an HttpOnly, SameSite=Strict cookie, and is stored
// server side as a SHA-256 hash. Web Standard APIs only. The store is an interface: this in-memory one
// suits a single process (development, a Pi); the hosted tier brings its own (SPOOL-129 and later).
import type { Principal } from './principal.ts';

export interface SessionStore {
  /** Starts a session for an authenticated Principal and returns its secret ID and lifetime. */
  create(principal: Principal): Promise<{ id: string; maxAgeSeconds: number }>;
  /** The Principal for a session ID, or null when it is malformed, unknown or expired. */
  get(id: string): Promise<Principal | null>;
  destroy(id: string): Promise<void>;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface MemorySessionOptions {
  /** Absolute lifetime. Default 12 hours. */
  ttlMs?: number;
  /** Most sessions kept at once; the oldest is dropped past this. Default 50. */
  max?: number;
  now?: () => number;
}

async function keyOf(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function newId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function createMemorySessionStore(options: MemorySessionOptions = {}): SessionStore {
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  const max = options.max ?? 50;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { principal: Principal; expiresAt: number }>();

  const dropExpired = (): void => {
    const t = now();
    for (const [key, s] of sessions) if (s.expiresAt <= t) sessions.delete(key);
  };

  return {
    async create(principal) {
      dropExpired();
      while (sessions.size >= max) {
        const oldest = sessions.keys().next();
        if (oldest.done) break;
        sessions.delete(oldest.value);
      }
      const id = newId();
      sessions.set(await keyOf(id), { principal, expiresAt: now() + ttlMs });
      return { id, maxAgeSeconds: Math.floor(ttlMs / 1000) };
    },
    async get(id) {
      if (!ID_PATTERN.test(id)) return null;
      const key = await keyOf(id);
      const found = sessions.get(key);
      if (!found) return null;
      if (found.expiresAt <= now()) {
        sessions.delete(key);
        return null;
      }
      return found.principal;
    },
    async destroy(id) {
      if (ID_PATTERN.test(id)) sessions.delete(await keyOf(id));
    },
  };
}
