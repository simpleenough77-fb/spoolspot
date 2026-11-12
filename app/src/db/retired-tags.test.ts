// SPDX-License-Identifier: AGPL-3.0-or-later
// SPOOL-201, migration 0006: a tag ID that stops being the tag of its place or clip is retired for good
// in its tenant, enforced by the database; a leaf that becomes a container keeps its tag (D4).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteTenant } from '../data/tenant-delete.ts';
import { fillDemo, removeDemo } from '../seed/demo.ts';
import { importSeed } from '../seed/import.ts';
import {
  memoryDatabase,
  memoryDatabaseUpTo,
  migrateUpTo,
  readJson,
  readSeed,
  SEED_SCHEMA_PATH,
  TENANT_A,
  TENANT_B,
  uuid,
} from '../testing.ts';
import { DatabaseIntegrityError, TAG_RETIREMENT_TRIGGERS, verifyDatabase } from './integrity.ts';
import { MIGRATIONS_DIR, runMigrations } from './migrate.ts';

type Db = ReturnType<typeof memoryDatabase>['db'];

const X = 'RET1RED00001';
const Y = 'RET1RED00002';
const Z = 'RET1RED00003';
const W = 'RET1RED00004';
const RETIRED = /tag id retired/;

function tenant(db: Db, t: string): void {
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(t);
}

function shelf(
  db: Db,
  t: string,
  id: string,
  tag: string | null = null,
  parent: string | null = null,
) {
  db.prepare(
    `INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_id, tag_source)
     VALUES (?, ?, ?, 'passive_storage', ?, 1, 5, 'soft', ?, 'sticker')`,
  ).run(t, id, id, parent, tag);
}

function container(db: Db, t: string, id: string, parent: string | null = null): void {
  db.prepare(
    "INSERT INTO location (tenant_id, id, name, type, parent, leaf) VALUES (?, ?, ?, 'container', ?, 0)",
  ).run(t, id, id, parent);
}

/** A container's tag: a registry row only (SPOOL-191 decision 2). */
function containerTag(db: Db, t: string, id: string, tag: string): void {
  db.prepare(
    "INSERT INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', ?)",
  ).run(t, tag, id);
}

function filament(db: Db, t: string): string {
  const id = uuid();
  db.prepare(
    "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'M', 'PLA', ?, 'disposable')",
  ).run(t, id, id);
  return id;
}

function clip(db: Db, t: string, tag: string, f = filament(db, t)): string {
  const id = uuid();
  db.prepare(
    "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
  ).run(t, id, tag, f);
  return id;
}

const retired = (db: Db, t: string): string[] =>
  (
    db.prepare('SELECT tag_id FROM tag_retired WHERE tenant_id = ? ORDER BY tag_id').all(t) as {
      tag_id: string;
    }[]
  ).map((r) => r.tag_id);

const registry = (db: Db, t: string) =>
  db.prepare('SELECT tag_id, kind, target_id FROM tag WHERE tenant_id = ? ORDER BY tag_id').all(t);

const setLeafTag = (db: Db, t: string, id: string, tag: string | null) =>
  db.prepare('UPDATE location SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(tag, t, id);

/** Every way back in for an ID: each must be refused while the ID is retired in `t`. */
function expectRefusedEverywhere(db: Db, t: string, tag: string, spare: string): void {
  shelf(db, t, 'probe-leaf');
  container(db, t, 'probe-box');
  const probeClip = clip(db, t, spare);
  const attempts: [string, () => unknown][] = [
    ['leaf tag_id set', () => setLeafTag(db, t, 'probe-leaf', tag)],
    [
      'new tagged leaf',
      () => {
        shelf(db, t, 'probe-new', tag);
      },
    ],
    [
      'container registry row',
      () => {
        containerTag(db, t, 'probe-box', tag);
      },
    ],
    ['new clip', () => clip(db, t, tag)],
    [
      'clip tag_id changed',
      () =>
        db
          .prepare('UPDATE clip SET tag_id = ? WHERE tenant_id = ? AND id = ?')
          .run(tag, t, probeClip),
    ],
    [
      'registry row updated to it',
      () =>
        db
          .prepare(
            "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'clip' AND target_id = ?",
          )
          .run(tag, t, probeClip),
    ],
  ];
  for (const [name, attempt] of attempts) expect(attempt, name).toThrow(RETIRED);
  // Nothing of the refused writes was stored.
  expect(registry(db, t).some((r) => (r as { tag_id: string }).tag_id === tag)).toBe(false);
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM location WHERE tenant_id = ? AND id = 'probe-new'")
      .get(t),
  ).toEqual({ n: 0 });
}

describe('migration 0006: every path that drops a registry row retires the ID', () => {
  it("a leaf's tag cleared, or changed, retires the old ID; the new one is in use", () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', Y);
    expect(retired(db, TENANT_A)).toEqual([X]);
    setLeafTag(db, TENANT_A, 'one', null);
    expect(retired(db, TENANT_A)).toEqual([X, Y]);
    expect(registry(db, TENANT_A)).toEqual([]);
    // The place whose tag was dropped can take a new one.
    setLeafTag(db, TENANT_A, 'one', Z);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: Z, kind: 'location', target_id: 'one' }]);
  });

  it('deleting a tagged leaf, a tagged container or a clip retires its ID', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', Y);
    const c = clip(db, TENANT_A, Z);
    db.prepare('DELETE FROM location WHERE tenant_id = ? AND id IN (?, ?)').run(
      TENANT_A,
      'one',
      'box',
    );
    db.prepare('DELETE FROM clip WHERE tenant_id = ? AND id = ?').run(TENANT_A, c);
    expect(retired(db, TENANT_A)).toEqual([X, Y, Z]);
  });

  it("a clip's tag changed retires the old ID; a clip id change keeps its tag (re-pointed)", () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    const c = clip(db, TENANT_A, X);
    db.prepare('UPDATE clip SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(Y, TENANT_A, c);
    expect(retired(db, TENANT_A)).toEqual([X]);
    const renamed = uuid();
    db.prepare('UPDATE clip SET id = ? WHERE tenant_id = ? AND id = ?').run(renamed, TENANT_A, c);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: Y, kind: 'clip', target_id: renamed }]);
    expect(retired(db, TENANT_A)).toEqual([X]);
  });

  it("replacing a container's registry row (the claim path's UPDATE tag) and direct registry writes retire", () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', X);
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'box'",
    ).run(Y, TENANT_A);
    expect(retired(db, TENANT_A)).toEqual([X]);
    db.prepare('DELETE FROM tag WHERE tenant_id = ? AND tag_id = ?').run(TENANT_A, Y);
    expect(retired(db, TENANT_A)).toEqual([X, Y]);
  });

  it('clearing a leaf tag first and then making it a container retires (two steps are not D4)', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', null);
    db.prepare(
      `UPDATE location SET type = 'container', leaf = 0, capacity = NULL, capacity_mode = NULL,
              tag_source = NULL WHERE tenant_id = ? AND id = 'one'`,
    ).run(TENANT_A);
    expect(retired(db, TENANT_A)).toEqual([X]);
    expect(registry(db, TENANT_A)).toEqual([]);
  });

  it('a location or clip moved to another tenant (not an application path) retires the ID in the old tenant only', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    tenant(db, TENANT_B);
    shelf(db, TENANT_A, 'one', X);
    db.prepare("UPDATE location SET tenant_id = ? WHERE tenant_id = ? AND id = 'one'").run(
      TENANT_B,
      TENANT_A,
    );
    expect(retired(db, TENANT_A)).toEqual([X]);
    expect(retired(db, TENANT_B)).toEqual([]);
    expect(registry(db, TENANT_B)).toEqual([{ tag_id: X, kind: 'location', target_id: 'one' }]);
    // A clip moved to B with its tag (its filament moved first, as the foreign key needs).
    const f = filament(db, TENANT_A);
    const c = clip(db, TENANT_A, Y, f);
    db.prepare(
      'INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(TENANT_B, f, 'M', 'PLA', f, 'disposable');
    db.prepare('UPDATE clip SET tenant_id = ? WHERE tenant_id = ? AND id = ?').run(
      TENANT_B,
      TENANT_A,
      c,
    );
    expect(retired(db, TENANT_A)).toEqual([X, Y]);
    expect(retired(db, TENANT_B)).toEqual([]);
    expect(registry(db, TENANT_A)).toEqual([]);
    expect(registry(db, TENANT_B)).toContainEqual({ tag_id: Y, kind: 'clip', target_id: c });
  });

  it('a retired ID is refused on every way back in: leaf column, new leaf, container row, clip, registry update', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', null);
    expectRefusedEverywhere(db, TENANT_A, X, W);
    // And the place that lost it is unchanged by the refusals.
    expect(
      db.prepare("SELECT tag_id FROM location WHERE tenant_id = ? AND id = 'one'").get(TENANT_A),
    ).toEqual({ tag_id: null });
  });

  it('the seed import cannot bring a retired ID back either: the whole batch is refused', async () => {
    const { db, sql } = memoryDatabase();
    tenant(db, TENANT_A);
    const seed = readSeed();
    const first = seed.locations.find((l) => l.leaf && l.type !== 'active_use');
    if (!first) throw new Error('seed has no leaf');
    const tagged = {
      ...seed,
      locations: seed.locations.map((l) => (l === first ? { ...l, tag_id: X } : l)),
    };
    // X was used and dropped by an earlier place of this tenant.
    shelf(db, TENANT_A, 'old', X);
    db.prepare("DELETE FROM location WHERE tenant_id = ? AND id = 'old'").run(TENANT_A);
    await expect(importSeed(sql, TENANT_A, tagged, readJson(SEED_SCHEMA_PATH))).rejects.toThrow(
      RETIRED,
    );
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM location WHERE tenant_id = ?').get(TENANT_A),
    ).toEqual({ n: 0 });
  });
});

describe('migration 0006: following the place is not retiring (D3, D4)', () => {
  it('a move, a leaf rename and a container rename keep the ID and retire nothing', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    container(db, TENANT_A, 'room');
    container(db, TENANT_A, 'box', 'room');
    containerTag(db, TENANT_A, 'box', X);
    shelf(db, TENANT_A, 'one', Y, 'box');
    db.prepare("UPDATE location SET parent = NULL WHERE tenant_id = ? AND id = 'box'").run(
      TENANT_A,
    );
    db.prepare(
      "UPDATE location SET id = 'uno', parent = NULL WHERE tenant_id = ? AND id = 'one'",
    ).run(TENANT_A);
    db.prepare("UPDATE location SET id = 'crate' WHERE tenant_id = ? AND id = 'room'").run(
      TENANT_A,
    );
    expect(registry(db, TENANT_A)).toEqual([
      { tag_id: X, kind: 'location', target_id: 'box' },
      { tag_id: Y, kind: 'location', target_id: 'uno' },
    ]);
    expect(retired(db, TENANT_A)).toEqual([]);
  });

  it('D4: a leaf that becomes a container keeps its tag as a registry row, column NULL, not retired', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    db.prepare(
      `UPDATE location SET type = 'container', leaf = 0, capacity = NULL, capacity_mode = NULL,
              tag_id = NULL, tag_source = NULL WHERE tenant_id = ? AND id = 'one'`,
    ).run(TENANT_A);
    expect(
      db
        .prepare("SELECT tag_id, leaf FROM location WHERE tenant_id = ? AND id = 'one'")
        .get(TENANT_A),
    ).toEqual({ tag_id: null, leaf: 0 });
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: X, kind: 'location', target_id: 'one' }]);
    expect(retired(db, TENANT_A)).toEqual([]);
    // Still in use by the same place: nothing else can take it.
    shelf(db, TENANT_A, 'two');
    expect(() => setLeafTag(db, TENANT_A, 'two', X)).toThrow(/UNIQUE/);
    // D4 in one statement with a rename too: the tag follows to the new id.
    shelf(db, TENANT_A, 'three', Y);
    db.prepare(
      `UPDATE location SET id = 'drei', type = 'container', leaf = 0, capacity = NULL,
              capacity_mode = NULL, tag_id = NULL, tag_source = NULL WHERE tenant_id = ? AND id = 'three'`,
    ).run(TENANT_A);
    expect(registry(db, TENANT_A)).toContainEqual({
      tag_id: Y,
      kind: 'location',
      target_id: 'drei',
    });
    expect(retired(db, TENANT_A)).toEqual([]);
  });

  it('D4 never touches another tenant with the same place id and tag', () => {
    const { db } = memoryDatabase();
    for (const t of [TENANT_A, TENANT_B]) {
      tenant(db, t);
      shelf(db, t, 'one', X);
    }
    db.prepare(
      `UPDATE location SET type = 'container', leaf = 0, capacity = NULL, capacity_mode = NULL,
              tag_id = NULL, tag_source = NULL WHERE tenant_id = ? AND id = 'one'`,
    ).run(TENANT_A);
    expect(registry(db, TENANT_B)).toEqual([{ tag_id: X, kind: 'location', target_id: 'one' }]);
    expect(
      db.prepare("SELECT tag_id FROM location WHERE tenant_id = ? AND id = 'one'").get(TENANT_B),
    ).toEqual({ tag_id: X });
    expect(retired(db, TENANT_B)).toEqual([]);
  });
});

describe('migration 0006: tenant isolation', () => {
  it("tenant A retiring X does not stop tenant B using X, and B's registry and retired list are untouched", () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    tenant(db, TENANT_B);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', null);
    expect(retired(db, TENANT_A)).toEqual([X]);
    // B may use X every way the schema allows (tag IDs are unique per tenant, 0001 and 0002).
    shelf(db, TENANT_B, 'one', X);
    container(db, TENANT_B, 'box');
    containerTag(db, TENANT_B, 'box', Y);
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'box'",
    ).run(Z, TENANT_B);
    setLeafTag(db, TENANT_A, 'one', Y);
    clip(db, TENANT_A, Z);
    expect(retired(db, TENANT_B)).toEqual([Y]);
    expect(retired(db, TENANT_A)).toEqual([X]);
    // The A-side registry update reaching the retired-row check also uses A's tenant.
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'one'",
    ).run(W, TENANT_A);
    expect(retired(db, TENANT_A)).toEqual([X, Y]);
  });

  it('an ID already retired in another tenant is still retired here when it leaves here', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    tenant(db, TENANT_B);
    shelf(db, TENANT_B, 'one', X);
    container(db, TENANT_B, 'box');
    containerTag(db, TENANT_B, 'box', Y);
    db.prepare('DELETE FROM location WHERE tenant_id = ?').run(TENANT_B);
    expect(retired(db, TENANT_B)).toEqual([X, Y]);
    // Now A uses and drops both, by a delete and by a registry update.
    shelf(db, TENANT_A, 'one', X);
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', Y);
    setLeafTag(db, TENANT_A, 'one', null);
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'box'",
    ).run(Z, TENANT_A);
    expect(retired(db, TENANT_A)).toEqual([X, Y]);
    expect(() => setLeafTag(db, TENANT_A, 'one', X)).toThrow(RETIRED);
  });

  it("a rename or a tag set in A never reads or moves B's same-target registry row", () => {
    const { db } = memoryDatabase();
    for (const t of [TENANT_A, TENANT_B]) {
      tenant(db, t);
      shelf(db, t, 'one', X);
    }
    db.prepare("UPDATE location SET id = 'uno' WHERE tenant_id = ? AND id = 'one'").run(TENANT_A);
    expect(registry(db, TENANT_B)).toEqual([{ tag_id: X, kind: 'location', target_id: 'one' }]);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: X, kind: 'location', target_id: 'uno' }]);
    // A tagged leaf in A whose id and tag B also has gets its own registry row.
    shelf(db, TENANT_A, 'two');
    shelf(db, TENANT_B, 'two', Y);
    setLeafTag(db, TENANT_A, 'two', Y);
    expect(registry(db, TENANT_A)).toContainEqual({
      tag_id: Y,
      kind: 'location',
      target_id: 'two',
    });
    // And clips: an id change in A leaves B's same-id, same-tag clip row alone.
    const id = uuid();
    for (const t of [TENANT_A, TENANT_B]) {
      db.prepare(
        "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
      ).run(t, id, Z, filament(db, t));
    }
    const renamed = uuid();
    db.prepare('UPDATE clip SET id = ? WHERE tenant_id = ? AND id = ?').run(renamed, TENANT_A, id);
    expect(registry(db, TENANT_B)).toContainEqual({ tag_id: Z, kind: 'clip', target_id: id });
    expect(registry(db, TENANT_A)).toContainEqual({ tag_id: Z, kind: 'clip', target_id: renamed });
    // A clip given a tag in A that B's same-id clip also has gets A's own registry row.
    db.prepare('UPDATE clip SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(W, TENANT_B, id);
    db.prepare('UPDATE clip SET id = ?, tag_id = ? WHERE tenant_id = ? AND id = ?').run(
      id,
      W,
      TENANT_A,
      renamed,
    );
    expect(registry(db, TENANT_A)).toContainEqual({ tag_id: W, kind: 'clip', target_id: id });
    expect(retired(db, TENANT_B)).toEqual([Z]);
    expect(retired(db, TENANT_A)).toEqual([Z]);
  });
  it("B may move a container's registry row onto an ID A retired, and A's clip tag change leaves B's same-id clip alone", () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    tenant(db, TENANT_B);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', null);
    container(db, TENANT_B, 'box');
    containerTag(db, TENANT_B, 'box', Y);
    // The claim path's container replace, in B, to the ID A retired.
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'box'",
    ).run(X, TENANT_B);
    expect(registry(db, TENANT_B)).toEqual([{ tag_id: X, kind: 'location', target_id: 'box' }]);
    // Same clip id in both tenants; A changes its clip's tag only.
    const id = uuid();
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
    ).run(TENANT_A, id, Z, filament(db, TENANT_A));
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
    ).run(TENANT_B, id, Z, filament(db, TENANT_B));
    db.prepare('UPDATE clip SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(W, TENANT_A, id);
    expect(registry(db, TENANT_B)).toContainEqual({ tag_id: Z, kind: 'clip', target_id: id });
    expect(retired(db, TENANT_B)).toEqual([Y]);
  });
});

describe('migration 0006: the retired list itself', () => {
  it('is never changed, and is not deleted while the tenant still has data', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', null);
    expect(() =>
      db.prepare('UPDATE tag_retired SET tag_id = ? WHERE tenant_id = ?').run(Y, TENANT_A),
    ).toThrow(/cannot be changed/);
    expect(() => db.prepare('DELETE FROM tag_retired WHERE tenant_id = ?').run(TENANT_A)).toThrow(
      /only with their tenant/,
    );
    expect(retired(db, TENANT_A)).toEqual([X]);
  });

  it('refuses a malformed ID and an unknown tenant', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    const add = db.prepare('INSERT INTO tag_retired (tenant_id, tag_id) VALUES (?, ?)');
    for (const bad of ['short', 'ret1red00001', 'RET1RED0000I', `${X}\u0000`]) {
      expect(() => add.run(TENANT_A, bad), bad).toThrow();
    }
    expect(() => add.run('nobody', X)).toThrow(/FOREIGN KEY/);
  });

  it("goes with its tenant (deleteTenant), and only that tenant's; B's retired IDs stay", async () => {
    const { db, sql } = memoryDatabase();
    for (const t of [TENANT_A, TENANT_B]) {
      tenant(db, t);
      shelf(db, t, 'one', X);
      setLeafTag(db, t, 'one', Y);
      clip(db, t, Z);
    }
    const result = await deleteTenant(sql, TENANT_A);
    // X retired before, Y (on the place) and Z (on the clip) retired by the deletion itself.
    expect(result).toMatchObject({ retiredTags: 3, tenant: 1 });
    expect(retired(db, TENANT_A)).toEqual([]);
    expect(retired(db, TENANT_B)).toEqual([X]);
    // A tenant recreated under the same id starts with no retired IDs (the deleted tenant's are gone).
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: X, kind: 'location', target_id: 'one' }]);
  });
});

describe('migration 0006: conflict clauses', () => {
  it('OR IGNORE does not let a retired ID back in, on location, clip or the registry', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    setLeafTag(db, TENANT_A, 'one', null);
    const f = filament(db, TENANT_A);
    for (const [name, q, params] of [
      [
        'update location',
        "UPDATE OR IGNORE location SET tag_id = ? WHERE tenant_id = ? AND id = 'one'",
        [X, TENANT_A],
      ],
      [
        'insert location',
        `INSERT OR IGNORE INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_id, tag_source)
         VALUES (?, 'two', 'two', 'passive_storage', 1, 5, 'soft', ?, 'sticker')`,
        [TENANT_A, X],
      ],
      [
        'insert clip',
        "INSERT OR IGNORE INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
        [TENANT_A, uuid(), X, f],
      ],
      [
        'insert registry',
        "INSERT OR IGNORE INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'one')",
        [TENANT_A, X],
      ],
    ] as const) {
      expect(() => db.prepare(q).run(...params), name).toThrow(RETIRED);
    }
    expect(registry(db, TENANT_A)).toEqual([]);
  });

  it('OR IGNORE does not skip retirement: clearing, changing or deleting still retires', () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    shelf(db, TENANT_A, 'one', X);
    shelf(db, TENANT_A, 'two', Y);
    const c = clip(db, TENANT_A, Z);
    db.prepare(
      "UPDATE OR IGNORE location SET tag_id = NULL WHERE tenant_id = ? AND id = 'one'",
    ).run(TENANT_A);
    db.prepare("DELETE FROM location WHERE tenant_id = ? AND id = 'two'").run(TENANT_A);
    db.prepare('UPDATE OR IGNORE clip SET tag_id = ? WHERE tenant_id = ? AND id = ?').run(
      W,
      TENANT_A,
      c,
    );
    expect(retired(db, TENANT_A)).toEqual([X, Y, Z]);
  });

  it('records the known gap: a REPLACE write can drop a registry row without retiring it (SPOOL-206)', () => {
    // The adapter refuses REPLACE (statement-guard.ts); this documents the database-level behaviour.
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', X);
    db.prepare(
      "INSERT OR REPLACE INTO tag (tenant_id, tag_id, kind, target_id) VALUES (?, ?, 'location', 'box')",
    ).run(TENANT_A, Y);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: Y, kind: 'location', target_id: 'box' }]);
    expect(retired(db, TENANT_A)).toEqual([]);
  });
});

describe('migration 0006: demo IDs and existing databases', () => {
  it('demo IDs are exempt: fill, remove and fill again work, and no demo ID is retired', async () => {
    const { db, sql } = memoryDatabase();
    await importSeed(sql, TENANT_A, readSeed(), readJson(SEED_SCHEMA_PATH));
    for (let i = 0; i < 2; i += 1) {
      expect(fillDemo(db, TENANT_A)).toMatchObject({ alreadyThere: false, clips: 27 });
      expect(removeDemo(db, TENANT_A)).toBe(27);
    }
    expect(retired(db, TENANT_A)).toEqual([]);
    // The exemption is the exact demo form only: a non-demo ID with a DEM prefix is retired.
    shelf(db, TENANT_A, 'odd', 'DEM1ABCDEFGH');
    setLeafTag(db, TENANT_A, 'odd', null);
    expect(retired(db, TENANT_A)).toEqual(['DEM1ABCDEFGH']);
  });

  it('applies to a database at 0005 with tagged places, containers and out-of-step leaves, changing no row', () => {
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    for (const t of [TENANT_A, TENANT_B]) {
      tenant(db, t);
      container(db, t, 'box');
      containerTag(db, t, 'box', X);
      shelf(db, t, 'one', Y, 'box');
      container(db, t, 'legacy');
      containerTag(db, t, 'legacy', Z);
    }
    // Before 0005 a tagged container could become a leaf, leaving its tag out of step.
    db.prepare(
      `UPDATE location SET type = 'passive_storage', leaf = 1, capacity = 5, capacity_mode = 'soft',
              tag_source = 'sticker' WHERE tenant_id = ? AND id = 'legacy'`,
    ).run(TENANT_A);
    migrateUpTo(db, '0005_container_stays_container.sql');
    // An ID dropped at 0005, before 0006: nothing recorded it.
    shelf(db, TENANT_A, 'gone', W);
    db.prepare("DELETE FROM location WHERE tenant_id = ? AND id = 'gone'").run(TENANT_A);
    const snapshot = () => ({
      location: db.prepare('SELECT * FROM location ORDER BY tenant_id, id').all(),
      tag: db.prepare('SELECT * FROM tag ORDER BY tenant_id, tag_id').all(),
    });
    const before = snapshot();
    expect(runMigrations(db)).toEqual(['0006_retired_tag_ids.sql']);
    expect(snapshot()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tag_retired').get()).toEqual({ n: 0 });
    // Not retroactive: the ID dropped before 0006 is still free.
    shelf(db, TENANT_A, 'new', W);
    // The out-of-step leaf claims its own registry-only tag into its column without retiring it.
    setLeafTag(db, TENANT_A, 'legacy', Z);
    expect(registry(db, TENANT_A)).toContainEqual({
      tag_id: Z,
      kind: 'location',
      target_id: 'legacy',
    });
    expect(retired(db, TENANT_A)).toEqual([]);
    // From now on, dropping a tag retires it.
    setLeafTag(db, TENANT_A, 'one', null);
    expect(retired(db, TENANT_A)).toEqual([Y]);
    expect(retired(db, TENANT_B)).toEqual([]);
  });

  it('an out-of-step leaf given another tag (replace) retires the registry-only tag', () => {
    const { db } = memoryDatabaseUpTo('0004_stock_passive_only.sql');
    tenant(db, TENANT_A);
    container(db, TENANT_A, 'legacy');
    containerTag(db, TENANT_A, 'legacy', Z);
    db.prepare(
      `UPDATE location SET type = 'passive_storage', leaf = 1, capacity = 5, capacity_mode = 'soft',
              tag_source = 'sticker' WHERE tenant_id = ? AND id = 'legacy'`,
    ).run(TENANT_A);
    runMigrations(db);
    setLeafTag(db, TENANT_A, 'legacy', X);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: X, kind: 'location', target_id: 'legacy' }]);
    expect(retired(db, TENANT_A)).toEqual([Z]);
  });
});

describe('migration 0006: review round 1 (each test pins one trigger detail)', () => {
  const twoTenants = () => {
    const { db } = memoryDatabase();
    tenant(db, TENANT_A);
    tenant(db, TENANT_B);
    return db;
  };
  const moveTagRow = (db: Db, tag: string) =>
    db
      .prepare('UPDATE tag SET tenant_id = ? WHERE tenant_id = ? AND tag_id = ?')
      .run(TENANT_B, TENANT_A, tag);

  it('a registry row moved to another tenant is refused when the ID is retired there (tenant_id, not only tag_id)', () => {
    const db = twoTenants();
    shelf(db, TENANT_B, 'one', X);
    setLeafTag(db, TENANT_B, 'one', null);
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', X);
    expect(() => moveTagRow(db, X)).toThrow(RETIRED);
    expect(registry(db, TENANT_A)).toEqual([{ tag_id: X, kind: 'location', target_id: 'box' }]);
  });

  it('a registry row moved to another tenant retires the ID in the old tenant, not the new', () => {
    const db = twoTenants();
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', X);
    moveTagRow(db, X);
    expect(retired(db, TENANT_A)).toEqual([X]);
    expect(retired(db, TENANT_B)).toEqual([]);
    expect(registry(db, TENANT_B)).toEqual([{ tag_id: X, kind: 'location', target_id: 'box' }]);
  });

  it('retired rows stay while the tenant has clips but no places or registry rows', () => {
    const db = twoTenants();
    clip(db, TENANT_A, X);
    // A direct registry delete retires X and leaves the clip without a registry row.
    db.prepare('DELETE FROM tag WHERE tenant_id = ?').run(TENANT_A);
    expect(retired(db, TENANT_A)).toEqual([X]);
    expect(() => db.prepare('DELETE FROM tag_retired WHERE tenant_id = ?').run(TENANT_A)).toThrow(
      /only with their tenant/,
    );
  });

  it('retired rows stay while the tenant has registry rows but no places or clips', () => {
    const db = twoTenants();
    containerTag(db, TENANT_A, 'nowhere', X);
    containerTag(db, TENANT_A, 'gone', Y);
    db.prepare('DELETE FROM tag WHERE tenant_id = ? AND tag_id = ?').run(TENANT_A, Y);
    expect(retired(db, TENANT_A)).toEqual([Y]);
    expect(() => db.prepare('DELETE FROM tag_retired WHERE tenant_id = ?').run(TENANT_A)).toThrow(
      /only with their tenant/,
    );
  });

  it('a clip or place whose tenant and id change in one statement leaves no row in the old tenant', () => {
    const db = twoTenants();
    const f = filament(db, TENANT_A);
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'M', 'PLA', ?, 'disposable')",
    ).run(TENANT_B, f, f);
    const c = clip(db, TENANT_A, X, f);
    const moved = uuid();
    db.prepare('UPDATE clip SET tenant_id = ?, id = ? WHERE tenant_id = ? AND id = ?').run(
      TENANT_B,
      moved,
      TENANT_A,
      c,
    );
    shelf(db, TENANT_A, 'one', Y);
    db.prepare(
      "UPDATE location SET tenant_id = ?, id = 'uno' WHERE tenant_id = ? AND id = 'one'",
    ).run(TENANT_B, TENANT_A);
    expect(registry(db, TENANT_A)).toEqual([]);
    expect(retired(db, TENANT_A)).toEqual([X, Y]);
    expect(registry(db, TENANT_B)).toEqual([
      { tag_id: X, kind: 'clip', target_id: moved },
      { tag_id: Y, kind: 'location', target_id: 'uno' },
    ]);
  });

  it("replacing a container's demo tag does not retire it", () => {
    const db = twoTenants();
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', 'DEM100000009');
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'box'",
    ).run(X, TENANT_A);
    expect(retired(db, TENANT_A)).toEqual([]);
  });

  it('only DEM0 and DEM1 are exempt: DEM2 and eight digits is retired, on delete and on update', () => {
    const db = twoTenants();
    shelf(db, TENANT_A, 'one', 'DEM200000001');
    setLeafTag(db, TENANT_A, 'one', null);
    container(db, TENANT_A, 'box');
    containerTag(db, TENANT_A, 'box', 'DEM200000002');
    db.prepare(
      "UPDATE tag SET tag_id = ? WHERE tenant_id = ? AND kind = 'location' AND target_id = 'box'",
    ).run(X, TENANT_A);
    expect(retired(db, TENANT_A)).toEqual(['DEM200000001', 'DEM200000002']);
  });
});

describe('verifyDatabase: the retirement triggers are checked at startup', () => {
  /** The triggers 0006 creates, read from the migration itself, so the list cannot check itself. */
  const fromMigration = [
    ...readFileSync(join(MIGRATIONS_DIR, '0006_retired_tag_ids.sql'), 'utf8').matchAll(
      /^CREATE TRIGGER (\w+)$/gm,
    ),
  ].map((m) => m[1] ?? '');

  it('names every trigger 0006 creates or recreates', () => {
    expect(fromMigration).toHaveLength(8);
    expect(new Set(fromMigration)).toEqual(new Set(TAG_RETIREMENT_TRIGGERS));
  });

  it('refuses a database missing any of them', () => {
    for (const trigger of fromMigration) {
      const { db } = memoryDatabase();
      db.exec(`DROP TRIGGER ${trigger}`);
      expect(() => {
        verifyDatabase(db);
      }, trigger).toThrow(DatabaseIntegrityError);
    }
  });
});
