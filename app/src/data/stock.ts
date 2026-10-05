// SPDX-License-Identifier: AGPL-3.0-or-later
// Boxed stock (SPOOL-63): counts per filament, location and pack type. Counts only, changed one tap at a
// time (+1 or -1). The database already refuses a refill pack for a disposable filament, a count below
// zero or above 10000, and a stock line at a container; this layer checks first so the person gets a
// plain answer, and the writes carry guards of their own so a second request cannot slip past a check.
import type { Sql } from '../db/sql.ts';
import { checkPlacement, type LocationNode, type PlacementCheck } from './tree.ts';

export type SpoolKind = 'refillable' | 'disposable';
export type StockPack = 'spool' | 'refill';

export interface FilamentSummary {
  id: string;
  manufacturer: string;
  type: string;
  color: string;
  spool_kind: SpoolKind;
}

export interface StockLine {
  id: string;
  filament: FilamentSummary;
  location_id: string;
  pack: StockPack;
  count: number;
}

export type StockRefusal =
  | 'filament_not_found'
  | 'location_not_found'
  | 'not_a_leaf'
  | 'slot_not_supported'
  | 'refill_not_allowed'
  | 'below_zero'
  | 'at_maximum'
  | 'needs_confirmation'
  /** The guard in the write stopped it (another request got there first); nothing was stored. */
  | 'conflict';

export type StockResult =
  | { ok: true; line: StockLine; check: PlacementCheck }
  | { ok: false; refusal: StockRefusal; check?: PlacementCheck };

export interface StockOps {
  /** The catalog as imported, for choosing a filament by tapping. At most 5000. */
  filaments(): Promise<FilamentSummary[]>;
  /** Every stock line at one place (zero counts included), or null when the place does not exist. */
  stockAt(locationId: string): Promise<StockLine[] | null>;
  /** Where a filament is held (counts above zero), or null when the filament does not exist. */
  stockOf(filamentId: string): Promise<StockLine[] | null>;
  /** One tap: +1 or -1 on a line, created on the first +1. */
  adjustStock(
    filamentId: string,
    locationId: string,
    pack: StockPack,
    delta: 1 | -1,
    confirm: boolean,
  ): Promise<StockResult>;
}

export const MAX_COUNT = 10000;

interface Deps {
  sql: Sql;
  tenantId: string;
  requireRead: () => void;
  requireWrite: () => void;
  findNode: (id: string) => Promise<LocationNode | undefined>;
}

interface LineRow {
  id: string;
  filament_id: string;
  location_id: string;
  pack: StockPack;
  count: number;
  manufacturer: string;
  type: string;
  color: string;
  spool_kind: SpoolKind;
}

const LINE_SELECT = `SELECT s.id, s.filament_id, s.location_id, s.pack, s.count,
         f.manufacturer, f.type, f.color, f.spool_kind
    FROM stock_line s
    JOIN filament f ON f.tenant_id = s.tenant_id AND f.id = s.filament_id`;

const toLine = (r: LineRow): StockLine => ({
  id: r.id,
  filament: {
    id: r.filament_id,
    manufacturer: r.manufacturer,
    type: r.type,
    color: r.color,
    spool_kind: r.spool_kind,
  },
  location_id: r.location_id,
  pack: r.pack,
  count: r.count,
});

export function createStockOps(deps: Deps): StockOps {
  const { sql, tenantId } = deps;
  const filamentById = async (id: string): Promise<FilamentSummary | null> => {
    const rows = await sql.all<FilamentSummary>(
      'SELECT id, manufacturer, type, color, spool_kind FROM filament WHERE tenant_id = ? AND id = ?',
      [tenantId, id],
    );
    return rows[0] ?? null;
  };
  const lineOf = async (
    filamentId: string,
    locationId: string,
    pack: StockPack,
  ): Promise<StockLine | null> => {
    const rows = await sql.all<LineRow>(
      `${LINE_SELECT} WHERE s.tenant_id = ? AND s.filament_id = ? AND s.location_id = ? AND s.pack = ?`,
      [tenantId, filamentId, locationId, pack],
    );
    const row = rows[0];
    return row ? toLine(row) : null;
  };

  return {
    async filaments() {
      deps.requireRead();
      return sql.all<FilamentSummary>(
        `SELECT id, manufacturer, type, color, spool_kind FROM filament
          WHERE tenant_id = ? ORDER BY manufacturer, type, color LIMIT 5000`,
        [tenantId],
      );
    },
    async stockAt(locationId) {
      deps.requireRead();
      if (!(await deps.findNode(locationId))) return null;
      const rows = await sql.all<LineRow>(
        `${LINE_SELECT} WHERE s.tenant_id = ? AND s.location_id = ?
          ORDER BY f.manufacturer, f.type, f.color, s.pack LIMIT 500`,
        [tenantId, locationId],
      );
      return rows.map(toLine);
    },
    async stockOf(filamentId) {
      deps.requireRead();
      if (!(await filamentById(filamentId))) return null;
      const rows = await sql.all<LineRow>(
        `${LINE_SELECT} WHERE s.tenant_id = ? AND s.filament_id = ? AND s.count > 0
          ORDER BY s.location_id, s.pack LIMIT 500`,
        [tenantId, filamentId],
      );
      return rows.map(toLine);
    },
    async adjustStock(filamentId, locationId, pack, delta, confirm) {
      deps.requireRead();
      deps.requireWrite();
      const filament = await filamentById(filamentId);
      if (!filament) return { ok: false, refusal: 'filament_not_found' };
      const node = await deps.findNode(locationId);
      if (!node) return { ok: false, refusal: 'location_not_found' };
      if (!node.leaf) return { ok: false, refusal: 'not_a_leaf' };
      // A slot holds one loaded spool, tracked through its clip (SPOOL-84), not a boxed count.
      if (node.type === 'active_use') return { ok: false, refusal: 'slot_not_supported' };
      if (pack === 'refill' && filament.spool_kind !== 'refillable') {
        return { ok: false, refusal: 'refill_not_allowed' };
      }
      const before = await lineOf(filamentId, locationId, pack);
      const was = before?.count ?? 0;
      if (delta === -1 && was <= 0) return { ok: false, refusal: 'below_zero' };
      if (delta === 1 && was >= MAX_COUNT) return { ok: false, refusal: 'at_maximum' };
      const check = checkPlacement(node, delta === 1 ? 1 : 0);
      if (delta === 1 && check.outcome === 'warning' && !confirm) {
        return { ok: false, refusal: 'needs_confirmation', check };
      }
      // The write reports whether it applied (rows changed). The count we read before is not used to
      // decide that: another request may have changed the line in between.
      let changed: number;
      if (delta === 1) {
        // The same guard sits on the insert and on the update: a hard limit must still have room unless
        // the person confirmed. A new line is created by the first tap; later taps add to it.
        const roomLeft = `(? = 1 OR NOT EXISTS (
            SELECT 1 FROM location d
             WHERE d.tenant_id = ? AND d.id = ?
               AND d.capacity_mode = 'hard' AND d.capacity IS NOT NULL
               AND COALESCE((SELECT SUM(s2.count) FROM stock_line s2
                              WHERE s2.tenant_id = d.tenant_id AND s2.location_id = d.id), 0)
                   + (SELECT COUNT(*) FROM clip k
                       WHERE k.tenant_id = d.tenant_id AND k.location_id = d.id) >= d.capacity))`;
        const guardParams = [confirm ? 1 : 0, tenantId, locationId];
        const [n] = await sql.batch([
          {
            query: `INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count)
                    SELECT ?, ?, ?, ?, ?, 1 WHERE ${roomLeft}
                    ON CONFLICT (tenant_id, filament_id, location_id, pack)
                    DO UPDATE SET count = count + 1 WHERE count < ${String(MAX_COUNT)} AND ${roomLeft}`,
            params: [
              tenantId,
              crypto.randomUUID(),
              filamentId,
              locationId,
              pack,
              ...guardParams,
              ...guardParams,
            ],
          },
        ]);
        changed = n ?? 0;
      } else {
        const [n] = await sql.batch([
          {
            query: `UPDATE stock_line SET count = count - 1
                     WHERE tenant_id = ? AND filament_id = ? AND location_id = ? AND pack = ? AND count > 0`,
            params: [tenantId, filamentId, locationId, pack],
          },
        ]);
        changed = n ?? 0;
      }
      // A guard that stopped the write changed nothing: say so rather than pretend. A -1 that finds
      // the line already at zero (another tap got there first) is the same answer as below zero.
      if (changed === 0) {
        return { ok: false, refusal: delta === -1 ? 'below_zero' : 'conflict', check };
      }
      const after = await lineOf(filamentId, locationId, pack);
      if (!after) return { ok: false, refusal: 'conflict', check };
      return { ok: true, line: after, check };
    },
  };
}
