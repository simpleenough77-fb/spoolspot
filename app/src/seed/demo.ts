// SPDX-License-Identifier: AGPL-3.0-or-later
// Demo data for phone demos of the location tree (SPOOL-30), clearly marked and removable. It stands in
// for the intake and placement workflows that arrive in later slices, so a real tree shows used and free
// places. It never touches anything that is not its own, and it records no weight, cost or usage.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Marks every demo row: the filament's manufacturer, and the "DEM0" start of each clip tag. */
export const DEMO_MANUFACTURER = 'SpoolSpot demo';
const TAG_PREFIX = 'DEM0';
/** Closet shelf 1 gets a small soft capacity so the "over a soft limit" notice can be shown. */
const SOFT_DEMO_LOCATION = 'closet-storage.shelf-1';
const SOFT_DEMO_CAPACITY = 4;

export interface DemoResult {
  clips: number;
  stockSpools: number;
  alreadyThere: boolean;
}

function clipTag(n: number): string {
  return `${TAG_PREFIX}${String(n).padStart(8, '0')}`;
}

function demoFilament(db: DatabaseSync, tenantId: string): string | undefined {
  const row = db
    .prepare('SELECT id FROM filament WHERE tenant_id = ? AND manufacturer = ?')
    .get(tenantId, DEMO_MANUFACTURER) as { id: string } | undefined;
  return row?.id;
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
  const stockHere = present(SOFT_DEMO_LOCATION);

  const filament = randomUUID();
  db.exec('BEGIN');
  try {
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, 'PLA', 'Demo', 'disposable')",
    ).run(tenantId, filament, DEMO_MANUFACTURER);
    let n = 0;
    for (const [location, count] of usable) {
      for (let i = 0; i < count; i += 1) {
        n += 1;
        db.prepare(
          "INSERT INTO clip (tenant_id, id, tag_id, filament_id, location_id, state) VALUES (?, ?, ?, ?, ?, 'on_spool')",
        ).run(tenantId, randomUUID(), clipTag(n), filament, location);
      }
    }
    let spools = 0;
    if (stockHere) {
      db.prepare(
        "UPDATE location SET capacity = ? WHERE tenant_id = ? AND id = ? AND capacity IS NULL",
      ).run(SOFT_DEMO_CAPACITY, tenantId, SOFT_DEMO_LOCATION);
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

/** Removes only what fillDemo added, and puts the closet shelf's capacity back to "not set". */
export function removeDemo(db: DatabaseSync, tenantId: string): number {
  const filament = demoFilament(db, tenantId);
  if (filament === undefined) return 0;
  db.exec('BEGIN');
  try {
    const clips = db
      .prepare('DELETE FROM clip WHERE tenant_id = ? AND filament_id = ?')
      .run(tenantId, filament);
    db.prepare('DELETE FROM stock_line WHERE tenant_id = ? AND filament_id = ?').run(
      tenantId,
      filament,
    );
    db.prepare('DELETE FROM filament WHERE tenant_id = ? AND id = ?').run(tenantId, filament);
    db.prepare(
      'UPDATE location SET capacity = NULL WHERE tenant_id = ? AND id = ? AND capacity = ?',
    ).run(tenantId, SOFT_DEMO_LOCATION, SOFT_DEMO_CAPACITY);
    db.exec('COMMIT');
    return Number(clips.changes);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
