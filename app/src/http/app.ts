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
import type { SessionStore } from '../auth/session.ts';
import type { ScopedData } from '../data/scoped.ts';
import { normalizeTagId } from '../data/tags.ts';
import { createRateLimiter } from './rate-limit.ts';
import type { LocationType } from '../seed/validate.ts';

export interface AppOptions {
  auth: AuthProvider;
  /** Builds the tenant-scoped data layer for an authenticated Principal. */
  data: (principal: Principal) => ScopedData;
  /** Host names (no port) this server answers to; anything else is refused (DNS rebinding, ADR-0007). */
  allowedHosts: readonly string[];
  /** Optional static file handler, registered after the API routes (Node adapter only). */
  staticHandler?: MiddlewareHandler;
  /** Browser sessions behind an HttpOnly cookie. Without it, only the Authorization header signs a request in. */
  sessions?: SessionStore;
  /**
   * The tag route (ADR-0001 phase 1): `/<code><id>` serves `shell`, the page that resolves the tag after
   * sign-in. Anything else on that route gets one neutral page. The route never redirects anywhere.
   */
  tagPages?: { instanceCode: string; shell: string };
  /** Identifies the caller for rate limiting (the connecting address). Default: one shared bucket. */
  clientKey?: (c: { env: unknown; req: { raw: Request } }) => string;
  /** Limits per minute per caller; defaults are 60 tag lookups and 10 failed sign-ins. */
  rateLimits?: { resolverPerMinute?: number; failedAuthPerMinute?: number };
}

/** The parts of a request the helpers below read; any Hono context satisfies it. */
interface RequestLike {
  req: { url: string; method: string; header: (name: string) => string | undefined };
}

export interface AppEnv {
  Variables: { principal: Principal; data: ScopedData; viaCookie: boolean };
}

const NEUTRAL_TAG_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SpoolSpot</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <main>
      <h1>SpoolSpot</h1>
      <p>This tag is not recognised here.</p>
      <p><a href="/">Open SpoolSpot</a></p>
    </main>
  </body>
</html>
`;

const SESSION_COOKIE = 'spoolspot_session';
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/;
const CLIP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_BODY_BYTES = 1024;

function isHttps(c: RequestLike): boolean {
  return new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
}

/** Over HTTPS the cookie takes the __Host- prefix, which stops a sibling host from planting one. */
function cookieName(c: RequestLike): string {
  return isHttps(c) ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

function readSessionId(c: RequestLike): string | null {
  const wanted = cookieName(c);
  for (const part of (c.req.header('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === wanted) {
      const value = part.slice(eq + 1).trim();
      return SESSION_ID.test(value) ? value : null;
    }
  }
  return null;
}

function sessionCookie(c: RequestLike, value: string, maxAgeSeconds: number): string {
  const secure = isHttps(c) ? '; Secure' : '';
  return `${cookieName(c)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAgeSeconds)}${secure}`;
}

/** A cookie-signed request that changes something must come from this site itself (CSRF). */
function sameOrigin(c: RequestLike): boolean {
  const origin = c.req.header('origin');
  const host = c.req.header('host');
  if (origin === undefined || host === undefined) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
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

/** `{ to, confirm? }` as strict JSON of a small size, or null. Anything else, including extra keys, is refused. */
async function readMoveBody(c: {
  req: { header: (name: string) => string | undefined; text: () => Promise<string> };
}): Promise<{ to: string; confirm: boolean } | null> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json'))
    return null;
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => k !== 'to' && k !== 'confirm');
  const { to, confirm } = record;
  if (
    extra.length > 0 ||
    typeof to !== 'string' ||
    to.length > 64 ||
    !LOCATION_ID.test(to) ||
    (confirm !== undefined && typeof confirm !== 'boolean')
  ) {
    return null;
  }
  return { to, confirm: confirm === true };
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()));
  const app = new Hono<AppEnv>();

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

  const clientKey = options.clientKey ?? (() => 'shared');
  const failedAuth = createRateLimiter({
    limit: options.rateLimits?.failedAuthPerMinute ?? 10,
    windowMs: 60_000,
  });
  const resolverLimit = createRateLimiter({
    limit: options.rateLimits?.resolverPerMinute ?? 60,
    windowMs: 60_000,
  });
  const tooMany = (limiter: ReturnType<typeof createRateLimiter>, key: string): Response =>
    new Response(JSON.stringify({ error: 'too_many_requests' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(limiter.retryAfterSeconds(key)),
      },
    });

  app.use('/api/*', async (c, next) => {
    const key = clientKey(c);
    const bearer = c.req.header('authorization') !== undefined;
    // Guessing the token is slowed down: a caller who keeps failing is refused before any comparison.
    if (bearer && failedAuth.limited(key)) return tooMany(failedAuth, key);
    let principal: Principal | null = null;
    let viaCookie = false;
    if (!bearer && options.sessions) {
      const id = readSessionId(c);
      if (id !== null) {
        principal = await options.sessions.get(id);
        viaCookie = principal !== null;
      }
    }
    if (!principal) {
      principal = await options.auth.authenticate(c.req.raw);
      if (!principal && bearer) failedAuth.hit(key);
    }
    if (!principal) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized' }, 401);
    }
    if (viaCookie && !SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    c.set('principal', principal);
    c.set('data', options.data(principal));
    c.set('viaCookie', viaCookie);
    await next();
  });

  // Signing in once with the token starts a session, so a phone can tap tag after tag without typing.
  app.post('/api/v1/session', async (c) => {
    const sessions = options.sessions;
    if (!sessions) return c.json({ error: 'not_found' }, 404);
    if (c.get('viaCookie')) return c.json({ error: 'unauthorized' }, 401);
    const { id, maxAgeSeconds } = await sessions.create(c.get('principal'));
    c.header('Set-Cookie', sessionCookie(c, id, maxAgeSeconds));
    return c.body(null, 204);
  });

  app.delete('/api/v1/session', async (c) => {
    const sessions = options.sessions;
    if (!sessions) return c.json({ error: 'not_found' }, 404);
    const id = readSessionId(c);
    if (id !== null) await sessions.destroy(id);
    c.header('Set-Cookie', sessionCookie(c, '', 0));
    return c.body(null, 204);
  });

  // What a tag stands for. Malformed, unknown and another tenant's tags all give the same 404.
  app.get('/api/v1/tags/:tag', async (c) => {
    if (!hasScope(c.get('principal'), Scope.LocationsRead)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const key = clientKey(c);
    if (!resolverLimit.hit(key)) return tooMany(resolverLimit, key);
    const id = normalizeTagId(c.req.param('tag'));
    const view = id === null ? null : await c.get('data').tagView(id);
    return view ? c.json(view) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/api/v1/locations/:id/clips', async (c) => {
    if (!hasScope(c.get('principal'), Scope.LocationsRead)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const id = c.req.param('id');
    if (id.length > 64 || !LOCATION_ID.test(id)) return c.json({ error: 'invalid_request' }, 400);
    const clips = await c.get('data').clipsAt(id);
    return clips ? c.json({ clips }) : c.json({ error: 'not_found' }, 404);
  });

  app.post('/api/v1/clips/:id/move', async (c) => {
    if (!hasScope(c.get('principal'), Scope.InventoryWrite)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const clipId = c.req.param('id');
    const body = await readMoveBody(c);
    if (!CLIP_ID.test(clipId) || body === null) return c.json({ error: 'invalid_request' }, 400);
    const result = await c.get('data').moveClip(clipId, body.to, body.confirm);
    if (result.ok) return c.json({ moved: result.moved, clip: result.clip, check: result.check });
    switch (result.refusal) {
      case 'clip_not_found':
        return c.json({ error: 'not_found' }, 404);
      case 'location_not_found':
        return c.json({ error: 'location_not_found' }, 404);
      case 'needs_confirmation':
        return c.json({ error: 'needs_confirmation', check: result.check }, 409);
      default:
        return c.json({ error: result.refusal }, 422);
    }
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
    const withinValues = c.req.queries('within');
    const within = single(withinValues);
    if (
      count === null ||
      (typeValues !== undefined && type === undefined) ||
      (typeValues?.length ?? 0) > 1 ||
      (withinValues !== undefined &&
        (within === undefined || within.length > 64 || !LOCATION_ID.test(within)))
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const suggestions = await c.get('data').placementSuggestions(count, type, within);
    if (suggestions === 'not_found') return c.json({ error: 'not_found' }, 404);
    return c.json({ suggestions });
  });

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));

  // The tag route (ADR-0001, phase 1): /<6-character instance code><12-character tag ID>. It never
  // redirects. A tag for this instance gets the page that signs in and resolves it; a wrong code, a
  // malformed path and an unknown tag all look the same from outside, and no data is in the page.
  const tagPages = options.tagPages;
  if (tagPages) {
    const code = tagPages.instanceCode.toUpperCase();
    const neutral = (): Response =>
      new Response(NEUTRAL_TAG_PAGE, {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    app.get('/:tag{[A-Za-z0-9_-]{1,64}}', (c) => {
      const key = clientKey(c);
      if (!resolverLimit.hit(key)) return tooMany(resolverLimit, key);
      const path = c.req.param('tag').toUpperCase();
      const ours = path.length === 18 && path.startsWith(code) && normalizeTagId(path.slice(6));
      if (!ours) return neutral();
      return new Response(tagPages.shell, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    });
  }

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
