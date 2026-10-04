// SPDX-License-Identifier: AGPL-3.0-or-later
// DEV ONLY. One bearer token from the environment maps to one fixed tenant. It exists so Slice 1 can be
// demonstrated behind the real Principal boundary. It has no users, no rate limiting and no rotation, and
// is replaced for self-hosting by the local password provider (SPOOL-175). Never use it on the internet.
import { Scope, type AuthProvider, type Principal } from './principal.ts';

export const MIN_TOKEN_LENGTH = 32;
const MIN_DISTINCT_CHARACTERS = 8;
const BEARER = /^Bearer ([\x21-\x7e]+)$/i;

export function checkDevToken(token: string): string | null {
  if (token.length < MIN_TOKEN_LENGTH) {
    return `the dev token must be at least ${String(MIN_TOKEN_LENGTH)} characters (try: openssl rand -hex 32)`;
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return 'the dev token must use printable ASCII characters without spaces';
  }
  if (new Set(token).size < MIN_DISTINCT_CHARACTERS) {
    return 'the dev token is too repetitive (try: openssl rand -hex 32)';
  }
  return null;
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time equality of two same-length byte arrays. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function createDevTokenProvider(options: { token: string; tenantId: string }): AuthProvider {
  const problem = checkDevToken(options.token);
  if (problem !== null) throw new Error(problem);
  const expected = digest(options.token);
  const principal: Principal = {
    subject: 'dev-token',
    tenantId: options.tenantId,
    scopes: new Set<string>([Scope.LocationsRead]),
  };
  return {
    async authenticate(request: Request): Promise<Principal | null> {
      const match = BEARER.exec(request.headers.get('authorization') ?? '');
      if (!match?.[1]) return null;
      // Compare fixed-length digests, so the comparison time does not depend on how much of the token matched.
      return equalBytes(await digest(match[1]), await expected) ? principal : null;
    },
  };
}
