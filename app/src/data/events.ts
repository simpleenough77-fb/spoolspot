// SPDX-License-Identifier: AGPL-3.0-or-later
// The one write path for the append-only movement history (ADR-0006, SPOOL-134). A state change and its
// event are stored in the same transaction: callers add the Statement built here to the same atomic
// batch as the change it records (D1 has atomic batches, not interactive transactions; see db/sql.ts).
// Only types, ids and a server timestamp are stored: no free text. The tenant always comes from the
// authenticated Principal, never from the event fields. A guard is chosen from a closed set of typed
// kinds and rendered here, with the tenant bound from the Principal: no caller can pass SQL text in.
import { ForbiddenError, hasScope, Scope, type Principal } from '../auth/principal.ts';
import type { SqlParam, Statement } from '../db/sql.ts';

/** The same set as the event table's CHECK (migration 0001) and schema/event.schema.json; a test keeps them equal. */
export const EVENT_TYPES = [
  'intake',
  'open',
  'move',
  'load',
  'unload',
  'empty',
  'retire',
  'refill',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * One event, without tenant, id or time (those are set here and by the database). When `clipId` is
 * given, leave `filamentId` null: the filament is read from the clip in the caller's tenant inside the
 * write (a clip belongs to one filament for life), so the two can never disagree.
 */
export interface NewEvent {
  type: EventType;
  clipId: string | null;
  filamentId: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
}

/**
 * The event's clip is still at `locationId` (null: not placed) in the caller's tenant, and, unless
 * `confirm` is true, the destination still has room when its capacity is a hard limit. Evaluated inside
 * the write. With this guard the event needs a clip, `locationId` must equal the event's `from` and
 * `destinationId` its `to`, so the stored event says exactly what the guard checked.
 */
export interface ClipStillAtGuard {
  readonly kind: 'clipStillAt';
  readonly locationId: string | null;
  readonly hardLimit: { readonly destinationId: string; readonly confirm: boolean };
}

/** The closed set of conditions an event insert can carry. A new kind is added here, rendered here. */
export type EventGuard = ClipStillAtGuard;

/**
 * A guard rendered to an SQL predicate (fixed text) and its bound values, for the state change that
 * goes in the same batch as the event. Output only: nothing in this module accepts it as input.
 */
export interface GuardCondition {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

export class InvalidEventError extends Error {
  constructor(reason: string) {
    super(`invalid event: ${reason}`);
    this.name = 'InvalidEventError';
  }
}

const EVENT_FIELDS = ['type', 'clipId', 'filamentId', 'fromLocationId', 'toLocationId'] as const;
const GUARD_FIELDS = ['kind', 'locationId', 'hardLimit'] as const;
const HARD_LIMIT_FIELDS = ['destinationId', 'confirm'] as const;
// Same shapes as the JSON schema: lower-case canonical UUIDs, location slugs of at most 64 characters.
// The UUID check is stricter than the clip, filament and event table CHECKs (36 characters of
// [0-9a-f-], any arrangement), so a clip stored with a non-canonical id cannot have an event written
// for it; moveClip reports that as invalid_request. Closing the gap needs a migration: SPOOL-197.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const LOCATION_ID_MAX = 64;
const TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * The fields an event type must carry, where the rule is certain from the schema and today's use.
 * A move without its clip or its destination records nothing meaningful. The other types are left
 * open until their workflows define them (SPOOL-84).
 */
const REQUIRED: Readonly<Partial<Record<EventType, readonly (typeof EVENT_FIELDS)[number][]>>> = {
  move: ['clipId', 'toLocationId'],
};

/**
 * Reads a plain object's own fields exactly once each, so a getter or proxy cannot pass validation
 * with one value and be bound with another. Any other own field is refused.
 */
function snapshot<K extends string>(
  value: unknown,
  what: string,
  fields: readonly K[],
): Record<K, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidEventError(`${what} must be an object`);
  }
  const allowed: readonly string[] = fields;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new InvalidEventError(`unexpected field in ${what}`);
    }
  }
  const out = {} as Record<K, unknown>;
  for (const key of fields) {
    if (!Object.hasOwn(value, key)) throw new InvalidEventError(`${what} is missing ${key}`);
    out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

function uuidOrNull(name: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) {
    throw new InvalidEventError(`${name} is malformed`);
  }
  return value;
}

function locationOrNull(name: string, value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > LOCATION_ID_MAX || !LOCATION_ID.test(value)) {
    throw new InvalidEventError(`${name} is malformed`);
  }
  return value;
}

interface CheckedEvent {
  readonly type: EventType;
  readonly clipId: string | null;
  readonly filamentId: string | null;
  readonly fromLocationId: string | null;
  readonly toLocationId: string | null;
}

function readEvent(value: unknown): CheckedEvent {
  // Runtime checks as well as types: the fields may come from parsed input one day.
  const raw = snapshot(value, 'event', EVENT_FIELDS);
  const type = raw.type;
  if (typeof type !== 'string' || !TYPES.has(type)) throw new InvalidEventError('unknown type');
  const event: CheckedEvent = {
    type: type as EventType,
    clipId: uuidOrNull('clipId', raw.clipId),
    filamentId: uuidOrNull('filamentId', raw.filamentId),
    fromLocationId: locationOrNull('fromLocationId', raw.fromLocationId),
    toLocationId: locationOrNull('toLocationId', raw.toLocationId),
  };
  if (event.clipId !== null && event.filamentId !== null) {
    throw new InvalidEventError('filamentId is derived from clipId; pass one or the other');
  }
  for (const field of REQUIRED[event.type] ?? []) {
    if (event[field] === null) throw new InvalidEventError(`a ${event.type} event needs ${field}`);
  }
  return event;
}

function readGuard(value: unknown): ClipStillAtGuard {
  const raw = snapshot(value, 'guard', GUARD_FIELDS);
  if (raw.kind !== 'clipStillAt') throw new InvalidEventError('unknown guard kind');
  const limit = snapshot(raw.hardLimit, 'guard.hardLimit', HARD_LIMIT_FIELDS);
  const destinationId = locationOrNull('guard.hardLimit.destinationId', limit.destinationId);
  if (destinationId === null)
    throw new InvalidEventError('guard.hardLimit.destinationId is missing');
  if (typeof limit.confirm !== 'boolean') {
    throw new InvalidEventError('guard.hardLimit.confirm must be a boolean');
  }
  return {
    kind: 'clipStillAt',
    locationId: locationOrNull('guard.locationId', raw.locationId),
    hardLimit: { destinationId, confirm: limit.confirm },
  };
}

/**
 * Internal check on every statement this module builds: one bound value per `?`, and no numbered or
 * named parameters. node:sqlite binds a missing value as NULL, so a count mismatch would fail open.
 * Exported for its test only.
 */
export function checkBindings(statement: Statement): void {
  const { query } = statement;
  const params = statement.params ?? [];
  if (/\?\d|[:@$][A-Za-z_]/.test(query)) {
    throw new Error('event statement uses numbered or named parameters');
  }
  const placeholders = query.split('?').length - 1;
  if (placeholders !== params.length) {
    throw new Error(
      `event statement has ${String(placeholders)} placeholders and ${String(params.length)} values`,
    );
  }
}

const CLIP_STILL_AT_SQL =
  'EXISTS (SELECT 1 FROM clip g WHERE g.tenant_id = ? AND g.id = ? AND g.location_id IS ?' +
  ' AND (? = 1 OR NOT EXISTS (SELECT 1 FROM location d' +
  ' WHERE d.tenant_id = g.tenant_id AND d.id = ?' +
  " AND d.capacity_mode = 'hard' AND d.capacity IS NOT NULL" +
  ' AND COALESCE((SELECT SUM(s.count) FROM stock_line s' +
  ' WHERE s.tenant_id = d.tenant_id AND s.location_id = d.id), 0)' +
  ' + (SELECT COUNT(*) FROM clip k WHERE k.tenant_id = d.tenant_id AND k.location_id = d.id)' +
  ' >= d.capacity)))';

function render(tenantId: string, clipId: string, guard: ClipStillAtGuard): GuardCondition {
  const condition: GuardCondition = {
    sql: CLIP_STILL_AT_SQL,
    params: [
      tenantId,
      clipId,
      guard.locationId,
      guard.hardLimit.confirm ? 1 : 0,
      guard.hardLimit.destinationId,
    ],
  };
  checkBindings({ query: condition.sql, params: condition.params });
  return condition;
}

/**
 * Renders a guard for the state change that is batched with the event (moveClip's UPDATE), so the
 * change and its event are guarded by the same text and values. The tenant is the Principal's; the clip
 * id is validated like an event's. Throws InvalidEventError for a malformed guard or clip id and
 * ForbiddenError without the inventory write scope.
 */
export function guardCondition(
  principal: Principal,
  clipId: string,
  guard: EventGuard,
): GuardCondition {
  if (!hasScope(principal, Scope.InventoryWrite)) throw new ForbiddenError(Scope.InventoryWrite);
  const id = uuidOrNull('clipId', clipId);
  if (id === null) throw new InvalidEventError('clipId is missing');
  return render(principal.tenantId, id, readGuard(guard));
}

const INSERT_HEAD =
  'INSERT INTO event (tenant_id, id, type, clip_id, filament_id, from_location_id, to_location_id)';
const FILAMENT_OF_CLIP = '(SELECT k.filament_id FROM clip k WHERE k.tenant_id = ? AND k.id = ?)';

/**
 * Builds the parameterised insert for one event, for the caller's atomic batch. Throws
 * InvalidEventError for an unknown type, a missing or unexpected field, a malformed id, an event its
 * type cannot mean, or a malformed or mismatched guard; ForbiddenError without the inventory write
 * scope. A clip, filament or location that is not in the caller's tenant fails the table's tenant-bound
 * foreign keys, which aborts the whole batch; a guard that does not hold in the caller's tenant stores
 * nothing.
 */
export function eventInsert(principal: Principal, event: NewEvent, guard?: EventGuard): Statement {
  if (!hasScope(principal, Scope.InventoryWrite)) throw new ForbiddenError(Scope.InventoryWrite);
  const e = readEvent(event);
  const g = guard === undefined ? null : readGuard(guard);
  if (g !== null) {
    if (e.clipId === null) throw new InvalidEventError('a clipStillAt guard needs the event clip');
    if (g.locationId !== e.fromLocationId) {
      throw new InvalidEventError('guard locationId must equal the event fromLocationId');
    }
    if (g.hardLimit.destinationId !== e.toLocationId) {
      throw new InvalidEventError('guard destinationId must equal the event toLocationId');
    }
  }
  const tenantId = principal.tenantId;
  const filament =
    e.clipId === null
      ? { expr: '?', params: [e.filamentId] }
      : { expr: FILAMENT_OF_CLIP, params: [tenantId, e.clipId] };
  const condition = g !== null && e.clipId !== null ? render(tenantId, e.clipId, g) : null;
  const statement: Statement = {
    query:
      `${INSERT_HEAD} SELECT ?, ?, ?, ?, ${filament.expr}, ?, ?` +
      (condition === null ? '' : ` WHERE ${condition.sql}`),
    params: [
      tenantId,
      crypto.randomUUID(),
      e.type,
      e.clipId,
      ...filament.params,
      e.fromLocationId,
      e.toLocationId,
      ...(condition?.params ?? []),
    ],
  };
  checkBindings(statement);
  return statement;
}
