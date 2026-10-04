// SPDX-License-Identifier: AGPL-3.0-or-later
// The HTTP application. Web Standard APIs only (ADR-0003): the same app runs under the Node adapter
// (server.ts) and, later, a Worker. Order of defence: host check, security headers, authentication,
// scope, tenant-scoped data. Unauthenticated callers learn nothing beyond "401".
import { Hono, type MiddlewareHandler } from 'hono';
import {
  ForbiddenError,
  hasScope,
  Scope,
  type AuthProvider,
  type Principal,
} from '../auth/principal.ts';
import type { ScopedData } from '../data/scoped.ts';

export interface AppOptions {
  auth: AuthProvider;
  /** Builds the tenant-scoped data layer for an authenticated Principal. */
  data: (principal: Principal) => ScopedData;
  /** Host names (no port) this server answers to; anything else is refused (DNS rebinding, ADR-0007). */
  allowedHosts: readonly string[];
  /** Optional static file handler, registered after the API routes (Node adapter only). */
  staticHandler?: MiddlewareHandler;
}

interface Env {
  Variables: { principal: Principal; data: ScopedData };
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** "Host" header to a lower-case host name without port. IPv6 literals keep their brackets. */
export function hostName(header: string | undefined): string | null {
  if (header === undefined) return null;
  const value = header.trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(value);
  return m?.[1] ?? null;
}

export function createApp(options: AppOptions): Hono<Env> {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const app = new Hono<Env>();

  // Headers go on every response, including refusals, so this wraps everything below it.
  app.use('*', async (c, next) => {
    await next();
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.use('*', async (c, next) => {
    const host = hostName(c.req.header('host'));
    if (host === null || !allowed.has(host)) {
      return c.body(null, 421);
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    const principal = await options.auth.authenticate(c.req.raw);
    if (!principal) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('principal', principal);
    c.set('data', options.data(principal));
    await next();
  });

  app.get('/api/v1/locations/summary', async (c) => {
    if (!hasScope(c.get('principal'), Scope.LocationsRead)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json(await c.get('data').locationSummary());
  });

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  if (options.staticHandler) app.use('*', options.staticHandler);

  app.onError((error, c) => {
    if (error instanceof ForbiddenError) return c.json({ error: 'forbidden' }, 403);
    // Name only: messages and stacks can carry data. Nothing from the request is logged.
    console.error(`request failed: ${error.name}`);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
