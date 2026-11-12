// SPDX-License-Identifier: AGPL-3.0-or-later
// The one write path for the append-only movement history (ADR-0006, SPOOL-134). A state change and its
// event are stored in the same transaction: callers add the Statement built here to the same atomic
// batch as the change it records (D1 has atomic batches, not interactive transactions; see db/sql.ts).
// Only types, ids and a server timestamp are stored: no free text. The tenant always comes from the
// authenticated Principal, never from the event fields.
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
 * An extra condition the insert must meet, evaluated inside the write: when it does not hold, no event
 * is stored (the state change it records should carry the same guard). `where` is SQL written in code,
 * never built from input; every value goes in `params`.
 */
export interface EventGuard {
  where: string;
  params: readonly SqlParam[];
}

export class InvalidEventError extends Error {
  constructor(reason: string) {
    super(`invalid event: ${reason}`);
    this.name = 'InvalidEventError';
  }
}

const FIELDS: readonly string[] = [
  'type',
  'clipId',
  'filamentId',
  'fromLocationId',
  'toLocationId',
];
// Same shapes as the table's CHECKs and the JSON schema: lower-case UUIDs, location slugs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCATION_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);

function checkId(name: string, value: unknown, shape: RegExp, maxLength: number): void {
  if (value === null) return;
  if (typeof value !== 'string' || value.length > maxLength || !shape.test(value)) {
    throw new InvalidEventError(`${name} is malformed`);
  }
}

function validate(event: NewEvent): void {
  // Runtime checks as well as types: the fields may come from parsed input one day.
  for (const key of Object.keys(event)) {
    if (!FIELDS.includes(key)) throw new InvalidEventError(`unexpected field ${key}`);
  }
  if (typeof event.type !== 'string' || !TYPES.has(event.type)) {
    throw new InvalidEventError('unknown type');
  }
  checkId('clipId', event.clipId, UUID, 36);
  checkId('filamentId', event.filamentId, UUID, 36);
  checkId('fromLocationId', event.fromLocationId, LOCATION_ID, 64);
  checkId('toLocationId', event.toLocationId, LOCATION_ID, 64);
  if (event.clipId !== null && event.filamentId !== null) {
    throw new InvalidEventError('filamentId is derived from clipId; pass one or the other');
  }
}

/**
 * Builds the parameterised insert for one event, for the caller's atomic batch. Throws
 * InvalidEventError for an unknown type, an unexpected field or a malformed id, and ForbiddenError
 * without the inventory write scope. A clip, filament or location that is not in the caller's tenant
 * fails the table's tenant-bound foreign keys, which aborts the whole batch.
 */
export function eventInsert(principal: Principal, event: NewEvent, guard?: EventGuard): Statement {
  if (!hasScope(principal, Scope.InventoryWrite)) throw new ForbiddenError(Scope.InventoryWrite);
  validate(event);
  const tenantId = principal.tenantId;
  const filament =
    event.clipId === null
      ? { expr: '?', params: [event.filamentId] }
      : {
          expr: '(SELECT k.filament_id FROM clip k WHERE k.tenant_id = ? AND k.id = ?)',
          params: [tenantId, event.clipId],
        };
  return {
    query: `INSERT INTO event (tenant_id, id, type, clip_id, filament_id, from_location_id, to_location_id)
            SELECT ?, ?, ?, ?, ${filament.expr}, ?, ?${guard ? ` WHERE ${guard.where}` : ''}`,
    params: [
      tenantId,
      crypto.randomUUID(),
      event.type,
      event.clipId,
      ...filament.params,
      event.fromLocationId,
      event.toLocationId,
      ...(guard?.params ?? []),
    ],
  };
}
