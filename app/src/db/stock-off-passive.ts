// SPDX-License-Identifier: AGPL-3.0-or-later
// Boxed stock belongs at passive storage only (SPOOL-200, migration 0004). A database from before that
// rule may still hold stock lines at active storage, slots or clip storage; the migration leaves them in
// place. This lists them, per tenant, so the owner can find and clear them. Read only.
import type { DatabaseSync } from 'node:sqlite';

export interface StockOffPassive {
  tenant_id: string;
  location_id: string;
  location_type: string;
  filament: string;
  pack: string;
  count: number;
}

/** Every stock line at a leaf that is not passive storage, by tenant and place. At most 10000 rows. */
export function stockOffPassive(db: DatabaseSync): StockOffPassive[] {
  return db
    .prepare(
      `SELECT s.tenant_id, s.location_id, l.type AS location_type,
              f.manufacturer || ' ' || f.type || ' ' || f.color AS filament, s.pack, s.count
         FROM main.stock_line s
         JOIN main.location l ON l.tenant_id = s.tenant_id AND l.id = s.location_id
         JOIN main.filament f ON f.tenant_id = s.tenant_id AND f.id = s.filament_id
        WHERE l.leaf = 1 AND l.type <> 'passive_storage'
        ORDER BY s.tenant_id, s.location_id, filament, s.pack
        LIMIT 10000`,
    )
    .all() as unknown as StockOffPassive[];
}
