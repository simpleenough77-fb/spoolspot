// SPDX-License-Identifier: AGPL-3.0-or-later
// The auth boundary (ADR-0004). Everything behind a request sees only a Principal; how it was
// established (dev token now, local passwords in SPOOL-175, a managed identity provider when hosted)
// is the AuthProvider's business. Web Standard APIs only, so this runs on Node and on Workers.

export const Scope = {
  LocationsRead: 'locations:read',
} as const;
export type ScopeName = (typeof Scope)[keyof typeof Scope];

export interface Principal {
  readonly subject: string;
  readonly tenantId: string;
  readonly scopes: ReadonlySet<string>;
}

export interface AuthProvider {
  /** Resolve the caller, or null when the request carries no valid credentials. Never throws for bad input. */
  authenticate(request: Request): Promise<Principal | null>;
}

export class ForbiddenError extends Error {
  constructor(scope: string) {
    super(`missing scope ${scope}`);
    this.name = 'ForbiddenError';
  }
}

export function hasScope(principal: Principal, scope: ScopeName): boolean {
  return principal.scopes.has(scope);
}
