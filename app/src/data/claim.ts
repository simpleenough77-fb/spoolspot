// SPDX-License-Identifier: AGPL-3.0-or-later
// Claiming a tag that already exists (SPOOL-191 decision 4): a signed-in person taps or scans a tag whose
// URL already carries an ADR-0001 tag ID and assigns that ID to a place. Only ADR-0001 IDs can be
// claimed; a tag carrying another system's payload never reaches this instance (ADR-0001: the tag is a
// URL) and is out of scope.
//
// Writes go through the existing columns so the 0002 triggers keep the registry consistent: a leaf's
// tag is location.tag_id; a container's tag is a registry row only (decision 2). Every statement is
// bound to the caller's tenant. A tag ID is unique per tenant (SPOOL-177), so the same ID in another
// tenant neither blocks a claim nor is revealed by one.
import type { Sql } from '../db/sql.ts';
import { isReservedTagId, isTagConflict, isTargetTagConflict, normalizeTagId } from './tags.ts';

export type ClaimRefusal =
  | 'invalid_tag'
  /** Unknown place, or another tenant's place: the same answer. */
  | 'location_not_found'
  /** The ID is already on a clip or a place in this tenant. Says nothing about which. */
  | 'tag_in_use'
  /** The place already has a tag; claiming again needs `replace`. */
  | 'location_has_tag'
  /** The place's tag changed between the check and the write; nothing was stored. */
  | 'conflict';

export type ClaimResult =
  | { ok: true; tag_id: string; location_id: string; replaced: boolean; changed: boolean }
  | { ok: false; refusal: ClaimRefusal };

export interface ClaimOps {
  /**
   * Assigns an existing tag ID to a place in the caller's tenant. A place that already has another tag
   * keeps it unless `replace` is true; replacing is one atomic statement. Claiming the place's own tag
   * again changes nothing.
   */
  claimTag(tagId: string, locationId: string, replace: boolean): Promise<ClaimResult>;
}

/**
 * Runs in the same atomic batch, straight after the claim's write. Every write is keyed to one record,
 * so it changes at most one row; if it ever changed more, this statement fails (a NULL into the
 * registry's NOT NULL key) and the whole batch rolls back, so nothing is stored. changes() counts the
 * previous statement only, not rows its triggers touched. Zero rows is the normal "someone else got
 * there first" case and is reported as a conflict.
 *
 * It must run immediately after the write, in the same batch: changes() keeps its value across
 * statements that change nothing, so anything placed between them could make it read a stale count.
 * That D1 evaluates changes() the same way inside a batch is still to be verified (SPOOL-199).
 */
const MORE_THAN_ONE_ROW_ABORTS = {
  query: `INSERT INTO tag (tenant_id, tag_id, kind, target_id)
          SELECT NULL, NULL, NULL, NULL WHERE changes() > 1`,
} as const;

/** The guard above fired: a claim's write would have changed more than one row. Nothing was stored. */
export class ClaimInvariantError extends Error {
  constructor() {
    super('tag claim write would have changed more than one row; rolled back');
    this.name = 'ClaimInvariantError';
  }
}

/** True for the failure the guard statement raises (its NULL into the registry's NOT NULL key). */
function isGuardFailure(error: unknown): boolean {
  return (
    error instanceof Error && /NOT NULL constraint failed: tag\.tenant_id\b/.test(error.message)
  );
}

export function createClaimOps(deps: {
  sql: Sql;
  tenantId: string;
  requireWrite: () => void;
}): ClaimOps {
  const { sql, tenantId } = deps;
  return {
    async claimTag(tagText, locationId, replace) {
      deps.requireWrite();
      const tagId = normalizeTagId(tagText);
      // The fixed demo IDs are public and owned by the demo data; they are refused like any invalid ID.
      if (tagId === null || isReservedTagId(tagId)) return { ok: false, refusal: 'invalid_tag' };
      const places = await sql.all<{ leaf: number; tag_id: string | null }>(
        'SELECT leaf, tag_id FROM location WHERE tenant_id = ? AND id = ?',
        [tenantId, locationId],
      );
      const place = places[0];
      if (!place) return { ok: false, refusal: 'location_not_found' };
      const registered =
        (
          await sql.all<{ tag_id: string }>(
            "SELECT tag_id FROM tag WHERE tenant_id = ? AND kind = 'location' AND target_id = ?",
            [tenantId, locationId],
          )
        )[0]?.tag_id ?? null;
      // The place's current tag, read the same way for leaves and containers (SPOOL-198): a container's
      // tag is its registry row; a leaf's is its column, which the registry follows. A leaf that has a
      // registry row its column does not show (a container turned into a leaf before migration 0005)
      // still counts that row as its tag, so it is never dropped without `replace`.
      const column = place.leaf === 1 ? place.tag_id : null;
      const current = column ?? registered;
      // The tag is fully in place: for a leaf, in its column as well as the registry.
      const settled = current === tagId && (place.leaf !== 1 || column === tagId);
      const done = (changed: boolean) =>
        ({
          ok: true,
          tag_id: tagId,
          location_id: locationId,
          replaced: changed && current !== null && current !== tagId,
          changed,
        }) as const;
      if (settled) return done(false);
      // The place's own registry row is not "in use elsewhere": claiming it again sets the leaf's column.
      if (registered !== tagId) {
        const inUse = await sql.all<{ one: number }>(
          'SELECT 1 AS one FROM tag WHERE tenant_id = ? AND tag_id = ?',
          [tenantId, tagId],
        );
        if (inUse.length > 0) return { ok: false, refusal: 'tag_in_use' };
      }
      if (current !== null && current !== tagId && !replace) {
        return { ok: false, refusal: 'location_has_tag' };
      }
      // One guarded statement: it applies only if the place still has the tag read above, so a
      // concurrent claim cannot be overwritten unseen. For a leaf the 0002 trigger swaps the registry
      // row inside the same statement (including a row its column did not show); a clash there aborts
      // the whole statement.
      let statement: { query: string; params: (string | null)[] };
      if (place.leaf === 1) {
        statement = {
          query: `UPDATE location SET tag_id = ?
                   WHERE tenant_id = ? AND id = ? AND leaf = 1 AND tag_id IS ?`,
          params: [tagId, tenantId, locationId, column],
        };
      } else if (current === null) {
        statement = {
          query: `INSERT INTO tag (tenant_id, tag_id, kind, target_id)
                  SELECT ?, ?, 'location', l.id FROM location l
                   WHERE l.tenant_id = ? AND l.id = ? AND l.leaf = 0
                     AND NOT EXISTS (SELECT 1 FROM tag t
                                      WHERE t.tenant_id = l.tenant_id AND t.kind = 'location'
                                        AND t.target_id = l.id)`,
          params: [tenantId, tagId, tenantId, locationId],
        };
      } else {
        statement = {
          query: `UPDATE tag SET tag_id = ?
                   WHERE tenant_id = ? AND kind = 'location' AND target_id = ? AND tag_id = ?`,
          params: [tagId, tenantId, locationId, current],
        };
      }
      let changed: number;
      try {
        [changed = 0] = await sql.batch([statement, MORE_THAN_ONE_ROW_ABORTS]);
      } catch (error) {
        if (isTagConflict(error)) return { ok: false, refusal: 'tag_in_use' };
        // The place got a tag from another request between the check and the write.
        if (isTargetTagConflict(error)) return { ok: false, refusal: 'conflict' };
        if (isGuardFailure(error)) throw new ClaimInvariantError();
        throw error;
      }
      if (changed > 1) throw new Error('tag claim changed more than one row');
      return changed === 1 ? done(true) : { ok: false, refusal: 'conflict' };
    },
  };
}
