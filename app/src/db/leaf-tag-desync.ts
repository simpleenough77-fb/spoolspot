// SPDX-License-Identifier: AGPL-3.0-or-later
// A container never becomes a leaf (SPOOL-198, migration 0005). A database from before that rule may
// hold a leaf whose tag is in the tag registry but not in its location.tag_id column: a container's tag
// is a registry row only, and the row stayed when the container was changed into a leaf. The migration
// leaves such rows in place. This lists them, per tenant, so the owner can find them. Read only.
import type { DatabaseSync } from 'node:sqlite';

export interface LeafTagDesync {
  tenant_id: string;
  location_id: string;
  /** The tag the registry holds for the place: the one its tag resolves to today. */
  registry_tag: string;
  /** What the place's column holds instead (null for a container turned into a leaf). */
  column_tag: string | null;
}

/** Every leaf whose registry row is not the tag in its column, by tenant and place. At most 10000 rows. */
export function leafTagDesync(db: DatabaseSync): LeafTagDesync[] {
  return db
    .prepare(
      `SELECT t.tenant_id, l.id AS location_id, t.tag_id AS registry_tag, l.tag_id AS column_tag
         FROM main.tag t
         JOIN main.location l ON l.tenant_id = t.tenant_id AND l.id = t.target_id
        WHERE t.kind = 'location' AND l.leaf = 1 AND l.tag_id IS NOT t.tag_id
        ORDER BY t.tenant_id, l.id
        LIMIT 10000`,
    )
    .all() as unknown as LeafTagDesync[];
}
