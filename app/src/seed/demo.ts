// SPDX-License-Identifier: AGPL-3.0-or-later
// Demo data for phone demos of the location tree (SPOOL-30), clearly marked and removable. It stands in
// for the intake and placement workflows that arrive in later slices, so a real tree shows used and free
// places. It never touches anything that is not its own, and it records no weight, cost or usage.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { guardedEventDelete } from '../data/event-delete.ts';
import { DEMO_CLIP_TAG_PREFIX, DEMO_PLACE_TAG_PREFIX } from '../data/tags.ts';
import { GRANT_CLOSED_CHECK } from '../db/integrity.ts';

/** Marks every demo row: the filament's manufacturer, and the "DEM0" start of each clip tag. */
export const DEMO_MANUFACTURER = 'SpoolSpot demo';
const TAG_PREFIX = DEMO_CLIP_TAG_PREFIX;
/** Fixed place tags for phone demos: "DEM1" and eight digits (valid tag IDs; clips use "DEM0"). */
export const DEMO_PLACE_TAGS: readonly (readonly [string, string])[] = [
  ['loc1.shelf-1', `${DEMO_PLACE_TAG_PREFIX}00000001`],
  ['loc1.shelf-2', `${DEMO_PLACE_TAG_PREFIX}00000002`],
  ['closet-storage.shelf-1', `${DEMO_PLACE_TAG_PREFIX}00000003`],
];
/** Closet shelf 1 gets a small soft capacity so the "over a soft limit" notice can be shown. */
const SOFT_DEMO_LOCATION = 'closet-storage.shelf-1';
const SOFT_DEMO_CAPACITY = 4;
/** fill records on the demo filament that it set the capacity, so remove only undoes its own change. */
const COLOR_PLAIN = 'Demo';
const COLOR_CAPACITY_SET = 'Demo (capacity set)';

export interface DemoResult {
  clips: number;
  stockSpools: number;
  alreadyThere: boolean;
}

function clipTag(n: number): string {
  return `${TAG_PREFIX}${String(n).padStart(8, '0')}`;
}

/** Demo removal stopped because something it would delete is not demo data. Nothing was changed. */
export class DemoRemovalRefused extends Error {
  constructor(reason: string) {
    super(`demo removal refused, nothing changed: ${reason}`);
    this.name = 'DemoRemovalRefused';
  }
}

/** Every demo clip tag: the shared demo clip prefix (data/tags.ts) and eight digits (see clipTag). */
const DEMO_CLIP_TAG_GLOB = `${DEMO_CLIP_TAG_PREFIX}[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]`;

/**
 * The demo filament, found by its whole fingerprint (manufacturer, type, one of the two demo colours,
 * disposable), not by its name alone. The catalog import refuses the demo manufacturer name, but a
 * database may hold one from before; more than one match is refused rather than guessed.
 */
function demoFilament(db: DatabaseSync, tenantId: string): string | undefined {
  const rows = db
    .prepare(
      `SELECT id FROM filament
        WHERE tenant_id = ? AND manufacturer = ? AND type = 'PLA' AND color IN (?, ?)
          AND spool_kind = 'disposable'`,
    )
    .all(tenantId, DEMO_MANUFACTURER, COLOR_PLAIN, COLOR_CAPACITY_SET) as { id: string }[];
  if (rows.length > 1) throw new DemoRemovalRefused('more than one filament looks like the demo');
  return rows[0]?.id;
}

/**
 * Refuses unless everything the removal would delete is demo data: every clip of the demo filament
 * carries a demo clip tag, its only boxed stock is the demo line, and every event about the demo filament or its clips names a demo clip and
 * the demo filament (or no filament). An event with no clip, a real clip or another filament is the
 * person's history, so the whole removal stops instead.
 */
function assertOnlyDemo(db: DatabaseSync, tenantId: string, filament: string): void {
  const realClip = db
    .prepare(
      'SELECT 1 AS n FROM clip WHERE tenant_id = ? AND filament_id = ? AND tag_id NOT GLOB ? LIMIT 1',
    )
    .get(tenantId, filament, DEMO_CLIP_TAG_GLOB);
  if (realClip !== undefined) throw new DemoRemovalRefused('a clip of this filament is not a demo clip');
  // fillDemo creates one boxed line: spools on the soft demo shelf. Its count may have been tapped
  // during a demo; any other line of the demo filament was added by the person, so stop.
  const otherStock = db
    .prepare(
      `SELECT 1 AS n FROM stock_line
        WHERE tenant_id = ? AND filament_id = ? AND NOT (location_id = ? AND pack = 'spool') LIMIT 1`,
    )
    .get(tenantId, filament, SOFT_DEMO_LOCATION);
  if (otherStock !== undefined) {
    throw new DemoRemovalRefused('boxed stock of this filament is not the demo line');
  }
  const demoClips = `SELECT k.id FROM clip k
                      WHERE k.tenant_id = ? AND k.filament_id = ? AND k.tag_id GLOB ?`;
  const notDemo = db
    .prepare(
      `SELECT 1 AS n FROM event e
        WHERE e.tenant_id = ?
          AND (e.filament_id = ? OR e.clip_id IN (${demoClips}))
          AND NOT (e.clip_id IS NOT NULL AND e.clip_id IN (${demoClips})
                   AND (e.filament_id IS NULL OR e.filament_id = ?))
        LIMIT 1`,
    )
    .get(
      tenantId,
      filament,
      tenantId,
      filament,
      DEMO_CLIP_TAG_GLOB,
      tenantId,
      filament,
      DEMO_CLIP_TAG_GLOB,
      filament,
    );
  if (notDemo !== undefined) throw new DemoRemovalRefused('an event about the demo is not demo history');
}

/** Adds the demo items. Safe to run twice: the second run changes nothing. */
export function fillDemo(db: DatabaseSync, tenantId: string): DemoResult {
  if (demoFilament(db, tenantId) !== undefined) return { clips: 0, stockSpools: 0, alreadyThere: true };

  const present = (id: string): boolean =>
    db.prepare('SELECT 1 AS n FROM location WHERE tenant_id = ? AND id = ?').get(tenantId, id) !==
    undefined;
  const slot = db
    .prepare(
      "SELECT id FROM location WHERE tenant_id = ? AND type = 'active_use' ORDER BY rowid LIMIT 1",
    )
    .get(tenantId) as { id: string } | undefined;
  const clipPlan: [string, number][] = [
    ['loc1.shelf-1', 10],
    ['loc1.shelf-2', 16],
    ...(slot ? ([[slot.id, 1]] as [string, number][]) : []),
  ];
  const usable = clipPlan.filter(([id]) => present(id));
  // Boxed stock goes on passive storage only (SPOOL-200): no demo line if the shelf is anything else.
  const stockHere =
    db
      .prepare(
        "SELECT 1 AS n FROM location WHERE tenant_id = ? AND id = ? AND leaf = 1 AND type = 'passive_storage'",
      )
      .get(tenantId, SOFT_DEMO_LOCATION) !== undefined;
  const capacityWasUnset =
    stockHere &&
    (
      db
        .prepare('SELECT capacity FROM location WHERE tenant_id = ? AND id = ?')
        .get(tenantId, SOFT_DEMO_LOCATION) as { capacity: number | null }
    ).capacity === null;

  const filament = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', ?, 'disposable')",
    ).run(tenantId, filament, DEMO_MANUFACTURER, capacityWasUnset ? COLOR_CAPACITY_SET : COLOR_PLAIN);
    let n = 0;
    for (const [location, count] of usable) {
      for (let i = 0; i < count; i += 1) {
        n += 1;
        db.prepare(
          "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
        ).run(tenantId, randomUUID(), clipTag(n), filament, location);
      }
    }
    // Tag only places that exist and have no tag yet, so a real tag is never replaced.
    for (const [location, tag] of DEMO_PLACE_TAGS) {
      db.prepare(
        'UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ? AND tag_id IS NULL',
      ).run(tag, tenantId, location);
    }
    let spools = 0;
    if (stockHere) {
      if (capacityWasUnset) {
        db.prepare('UPDATE location SET capacity = ? WHERE tenant_id = ? AND id = ?').run(
          SOFT_DEMO_CAPACITY,
          tenantId,
          SOFT_DEMO_LOCATION,
        );
      }
      db.prepare(
        "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, ?, 'spool', 5)",
      ).run(tenantId, randomUUID(), filament, SOFT_DEMO_LOCATION);
      spools = 5;
    }
    db.exec('COMMIT');
    return { clips: n, stockSpools: spools, alreadyThere: false };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Removes only what fillDemo added, and puts the closet shelf's capacity back to "not set". Moving a demo
 * clip records events about it; those are demo history, not the person's, so they go too, under a grant
 * limited to the demo filament (SPOOL-194). Every other event stays: the database refuses the rest.
 */
export function removeDemo(db: DatabaseSync, tenantId: string): number {
  // Everything is read inside the write transaction, so nothing can change between the checks and
  // the deletes.
  db.exec('BEGIN IMMEDIATE');
  try {
    const filament = demoFilament(db, tenantId);
    if (filament === undefined) {
      db.exec('COMMIT');
      return 0;
    }
    const setCapacity =
      (
        db
          .prepare('SELECT color FROM filament WHERE tenant_id = ? AND id = ?')
          .get(tenantId, filament) as { color: string } | undefined
      )?.color === COLOR_CAPACITY_SET;
    assertOnlyDemo(db, tenantId, filament);
    // Events first (they reference the demo clips and filament), and the grant is closed before the
    // filament it names is deleted.
    for (const s of guardedEventDelete(tenantId, { scope: 'filament', filamentId: filament })) {
      db.prepare(s.query).run(...(s.params ?? []));
    }
    const clips = db
      .prepare('DELETE FROM clip WHERE tenant_id = ? AND filament_id = ?')
      .run(tenantId, filament);
    db.prepare('DELETE FROM stock_line WHERE tenant_id = ? AND filament_id = ?').run(
      tenantId,
      filament,
    );
    for (const [, tag] of DEMO_PLACE_TAGS) {
      db.prepare('UPDATE location SET tag_id = NULL WHERE tenant_id = ? AND tag_id = ?').run(
        tenantId,
        tag,
      );
    }
    db.prepare('DELETE FROM filament WHERE tenant_id = ? AND id = ?').run(tenantId, filament);
    if (setCapacity) {
      db.prepare(
        'UPDATE location SET capacity = NULL WHERE tenant_id = ? AND id = ? AND capacity = ?',
      ).run(tenantId, SOFT_DEMO_LOCATION, SOFT_DEMO_CAPACITY);
    }
    // This transaction does not go through the adapter, so it runs the closing check itself, last.
    db.prepare(GRANT_CLOSED_CHECK.query).run();
    db.exec('COMMIT');
    return Number(clips.changes);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
