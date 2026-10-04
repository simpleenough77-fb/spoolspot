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
import type { LocationType } from '../seed/validate.ts';

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

const LOCATION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const LEAF_TYPES: readonly LocationType[] = [
  'active_storage',
  'active_use',
  'passive_storage',
  'clip_storage',
];

/** A whole number from 1 to 1000, or null. Rejects signs, decimals, exponents, spaces and leading zeros. */
export function parseCount(text: string | undefined): number | null {
  if (text === undefined || !/^[1-9]\d{0,3}$/.test(text)) return null;
  const n = Number(text);
  return n <= 1000 ? n : null;
}

/** One query value, or undefined when absent or repeated: a repeated parameter is ambiguous, so it is refused. */
function single(values: string[] | undefined): string | undefined {
  return values?.length === 1 ? values[0] : undefined;
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

  // Hono hands only Error instances to onError; normalise anything else so it gets the generic 500.
  app.use('*', async (_c, next) => {
    try {
      await next();
    } catch (error) {
      throw error instanceof Error ? error : new Error('non-error value thrown');
    }
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

  app.get('/api/v1/locations/tree', async (c) => {
    if (!hasScope(c.get('principal'), Scope.LocationsRead)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ locations: await c.get('data').locationTree() });
  });

  // Read-only: asks what would happen, stores nothing. An id that does not exist and an id that belongs
  // to another tenant get the same 404.
  app.get('/api/v1/locations/:id/placement', async (c) => {
    if (!hasScope(c.get('principal'), Scope.LocationsRead)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const id = c.req.param('id');
    const count = parseCount(single(c.req.queries('count')));
    if (id.length > 64 || !LOCATION_ID.test(id) || count === null) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const result = await c.get('data').placementCheck(id, count);
    if (result === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (result === 'not_a_leaf') return c.json({ error: 'not_a_leaf' }, 422);
    return c.json(result);
  });

  app.get('/api/v1/placement-suggestions', async (c) => {
    if (!hasScope(c.get('principal'), Scope.LocationsRead)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const count = parseCount(single(c.req.queries('count')));
    const typeValues = c.req.queries('type');
    const typeText = single(typeValues);
    const type = LEAF_TYPES.find((t) => t === typeText);
    if (
      count === null ||
      (typeValues !== undefined && type === undefined) ||
      (typeValues?.length ?? 0) > 1
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    return c.json({ suggestions: await c.get('data').placementSuggestions(count, type) });
  });

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  const staticHandler = options.staticHandler;
  if (staticHandler) {
    app.use('*', async (c, next) => {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        c.header('Allow', 'GET, HEAD');
        return c.body(null, 405);
      }
      return staticHandler(c as Parameters<MiddlewareHandler>[0], next);
    });
  }

  app.onError((error, c) => {
    if (error instanceof ForbiddenError) return c.json({ error: 'forbidden' }, 403);
    // Name only: messages and stacks can carry data. Nothing from the request is logged.
    console.error(`request failed: ${error.name}`);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}
