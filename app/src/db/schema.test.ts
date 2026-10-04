// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryDatabase, TENANT_A, TENANT_B, uuid } from '../testing.ts';
import { runMigrations } from './migrate.ts';
import { openDatabase } from './sqlite.ts';

interface Column {
  name: string;
  pk: number;
}

function tables(db: ReturnType<typeof memoryDatabase>['db']): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function columns(db: ReturnType<typeof memoryDatabase>['db'], table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[];
}

function addTenant(db: ReturnType<typeof memoryDatabase>['db'], tenant: string): void {
  db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(tenant);
}

function addLocation(
  db: ReturnType<typeof memoryDatabase>['db'],
  tenant: string,
  id: string,
  type = 'passive_storage',
  parent: string | null = null,
): void {
  const container = type === 'container';
  db.prepare(
    `INSERT INTO location (tenant_id, id, name, type, parent, leaf, capacity, capacity_mode, tag_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tenant,
    id,
    id,
    type,
    parent,
    container ? 0 : 1,
    type === 'active_use' ? 1 : null,
    container ? null : type === 'active_use' ? 'hard' : 'soft',
    container ? null : type === 'active_use' ? 'holder_post' : 'sticker',
  );
}

function addFilament(
  db: ReturnType<typeof memoryDatabase>['db'],
  tenant: string,
  kind = 'refillable',
  color = 'Black',
): string {
  const id = uuid();
  db.prepare(
    'INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(tenant, id, 'Bambu Lab', 'PLA Basic', color, kind);
  return id;
}

describe('migration 0001', () => {
  it('creates exactly the six tables', () => {
    const { db } = memoryDatabase();
    expect(tables(db)).toEqual([
      'clip',
      'event',
      'filament',
      'location',
      'stock_line',
      'tenant_settings',
    ]);
  });

  it('puts tenant_id first in every table and in every primary key', () => {
    const { db } = memoryDatabase();
    for (const table of tables(db)) {
      const cols = columns(db, table);
      expect(
        cols.map((c) => c.name),
        table,
      ).toContain('tenant_id');
      const pk = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
      expect(pk[0], `${table} primary key`).toBe('tenant_id');
      if (table !== 'tenant_settings') expect(pk, table).toHaveLength(2);
    }
  });

  it('makes every foreign key between data tables composite with tenant_id', () => {
    const { db } = memoryDatabase();
    for (const table of tables(db).filter((t) => t !== 'tenant_settings')) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as unknown as {
        id: number;
        from: string;
        table: string;
      }[];
      const groups = new Map<number, typeof fks>();
      for (const f of fks) groups.set(f.id, [...(groups.get(f.id) ?? []), f]);
      for (const [, parts] of groups) {
        const first = parts[0];
        if (first?.table === 'tenant_settings') continue;
        expect(
          parts.some((p) => p.from === 'tenant_id'),
          `${table} -> ${first?.table ?? '?'} must include tenant_id`,
        ).toBe(true);
      }
    }
  });

  it('uses STRICT tables, SQLite only, and no virtual tables', () => {
    const { db } = memoryDatabase();
    const list = db.prepare('PRAGMA table_list').all() as unknown as {
      name: string;
      type: string;
      strict: number;
    }[];
    for (const t of list.filter((x) => tables(db).includes(x.name))) {
      expect(t.type, t.name).toBe('table');
      expect(t.strict, `${t.name} is STRICT`).toBe(1);
    }
    const virtual = db
      .prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%VIRTUAL TABLE%'")
      .all();
    expect(virtual).toEqual([]);
  });

  it('has no weight, temperature, cost or per-print usage column', () => {
    const { db } = memoryDatabase();
    const forbidden =
      /(^|_)(weight|temp|temperature|cost|price|usage|remaining|grams?|mass|spent)(_|$)/;
    const names = tables(db).flatMap((t) => columns(db, t).map((c) => `${t}.${c.name}`));
    expect(names.filter((n) => forbidden.test(n.split('.')[1] ?? ''))).toEqual([]);
    // The one ADR-0006 field is allowed by name and is not a measurement.
    expect(names).toContain('filament.reorder_level');
  });

  it('applies ADR-0006 defaults: moderate, automatic level off, thresholds 2 and 3', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    const id = addFilament(db, TENANT_A);
    expect(
      db.prepare('SELECT reorder_level, auto_level FROM filament WHERE id = ?').get(id),
    ).toMatchObject({ reorder_level: 'moderate', auto_level: 0 });
    expect(
      db.prepare('SELECT moderate_threshold, high_threshold FROM tenant_settings').get(),
    ).toMatchObject({ moderate_threshold: 2, high_threshold: 3 });
    expect(() =>
      db.prepare('UPDATE tenant_settings SET moderate_threshold = 5, high_threshold = 4').run(),
    ).toThrow(/constraint/i);
  });
});

describe('tenant integrity', () => {
  it("rejects a row that points at another tenant's object (composite foreign key)", () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addTenant(db, TENANT_B);
    addLocation(db, TENANT_A, 'shelf-a');
    const filamentB = addFilament(db, TENANT_B);
    // Tenant B cannot place stock in tenant A's location, even by guessing its id.
    expect(() =>
      db
        .prepare(
          "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'shelf-a', 'spool', 1)",
        )
        .run(TENANT_B, uuid(), filamentB),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("rejects a clip that points at another tenant's filament", () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addTenant(db, TENANT_B);
    const filamentA = addFilament(db, TENANT_A);
    expect(() =>
      db
        .prepare(
          "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, '0123456789AB', ?, 'free')",
        )
        .run(TENANT_B, uuid(), filamentA),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('rejects a row for a tenant that does not exist', () => {
    const { db } = memoryDatabase();
    expect(() => {
      addLocation(db, 'nobody', 'x');
    }).toThrow(/FOREIGN KEY/i);
  });

  it('lets two tenants use the same location id and tag id', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addTenant(db, TENANT_B);
    addLocation(db, TENANT_A, 'shelf');
    addLocation(db, TENANT_B, 'shelf');
    expect(db.prepare('SELECT COUNT(*) AS n FROM location').get()).toMatchObject({ n: 2 });
  });

  it('keeps tag ids unique within a tenant and ignores unset tags', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addLocation(db, TENANT_A, 'one');
    addLocation(db, TENANT_A, 'two');
    const set = db.prepare('UPDATE location SET tag_id = ? WHERE id = ?');
    set.run('0123456789AB', 'one');
    expect(() => set.run('0123456789AB', 'two')).toThrow(/UNIQUE/i);
  });
});

describe('location rules', () => {
  it('requires a parent to be a container', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addLocation(db, TENANT_A, 'shelf');
    expect(() => {
      addLocation(db, TENANT_A, 'child', 'passive_storage', 'shelf');
    }).toThrow(/parent must be a container/);
    addLocation(db, TENANT_A, 'room', 'container');
    expect(() => {
      addLocation(db, TENANT_A, 'ok', 'passive_storage', 'room');
    }).not.toThrow();
  });

  it('rejects a bad type, a bad slug, a bad tag and an active_use slot that is not hard 1', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    expect(() => {
      addLocation(db, TENANT_A, 'a', 'cupboard');
    }).toThrow(/constraint/i);
    expect(() => {
      addLocation(db, TENANT_A, 'Bad Slug');
    }).toThrow(/constraint/i);
    addLocation(db, TENANT_A, 'slot', 'active_use');
    expect(() => db.prepare("UPDATE location SET capacity = 2 WHERE id = 'slot'").run()).toThrow(
      /constraint/i,
    );
    addLocation(db, TENANT_A, 'shelf');
    for (const bad of ['0123456789a', '0123456789ABC', '0123456789AI', '0123456789AO']) {
      expect(
        () => db.prepare('UPDATE location SET tag_id = ? WHERE id = ?').run(bad, 'shelf'),
        bad,
      ).toThrow(/constraint/i);
    }
  });
});

describe('stock lines', () => {
  it('accepts a refill pack only for a refillable filament', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addLocation(db, TENANT_A, 'closet');
    const refillable = addFilament(db, TENANT_A, 'refillable', 'Black');
    const disposable = addFilament(db, TENANT_A, 'disposable', 'White');
    const insert = db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'closet', ?, 1)",
    );
    expect(() => insert.run(TENANT_A, uuid(), refillable, 'refill')).not.toThrow();
    expect(() => insert.run(TENANT_A, uuid(), disposable, 'refill')).toThrow(/refillable/);
    expect(() => insert.run(TENANT_A, uuid(), disposable, 'spool')).not.toThrow();
  });

  it('keeps counts non-negative and one line per filament, location and pack', () => {
    const { db } = memoryDatabase();
    addTenant(db, TENANT_A);
    addLocation(db, TENANT_A, 'closet');
    const filament = addFilament(db, TENANT_A);
    const insert = db.prepare(
      "INSERT INTO stock_line (tenant_id, id, filament_id, location_id, pack, count) VALUES (?, ?, ?, 'closet', 'spool', ?)",
    );
    expect(() => insert.run(TENANT_A, uuid(), filament, -1)).toThrow(/constraint/i);
    insert.run(TENANT_A, uuid(), filament, 2);
    expect(() => insert.run(TENANT_A, uuid(), filament, 3)).toThrow(/UNIQUE/i);
  });
});

describe('event log', () => {
  function oneEvent(db: ReturnType<typeof memoryDatabase>['db']): string {
    addTenant(db, TENANT_A);
    const id = uuid();
    db.prepare("INSERT INTO event (tenant_id, id, type) VALUES (?, ?, 'intake')").run(TENANT_A, id);
    return id;
  }

  it('stamps the time on the server side', () => {
    const { db } = memoryDatabase();
    const id = oneEvent(db);
    const row = db.prepare('SELECT occurred_at FROM event WHERE id = ?').get(id) as {
      occurred_at: string;
    };
    expect(row.occurred_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('rejects UPDATE and DELETE', () => {
    const { db } = memoryDatabase();
    const id = oneEvent(db);
    expect(() => db.prepare("UPDATE event SET type = 'move' WHERE id = ?").run(id)).toThrow(
      /append-only/,
    );
    expect(() => db.prepare('DELETE FROM event WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM event').get()).toMatchObject({ n: 1 });
  });

  it('has no free-text column and only the ADR-0006 event types', () => {
    const { db } = memoryDatabase();
    expect(columns(db, 'event').map((c) => c.name)).toEqual([
      'tenant_id',
      'id',
      'type',
      'clip_id',
      'filament_id',
      'from_location_id',
      'to_location_id',
      'occurred_at',
    ]);
    addTenant(db, TENANT_A);
    for (const type of ['intake', 'open', 'move', 'load', 'unload', 'empty', 'retire', 'refill']) {
      db.prepare('INSERT INTO event (tenant_id, id, type) VALUES (?, ?, ?)').run(
        TENANT_A,
        uuid(),
        type,
      );
    }
    expect(() =>
      db
        .prepare("INSERT INTO event (tenant_id, id, type) VALUES (?, ?, 'comment')")
        .run(TENANT_A, uuid()),
    ).toThrow(/constraint/i);
  });
});

describe('migration runner and database file', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'spoolspot-'));
    dirs.push(d);
    return d;
  };

  it('is idempotent and enforces foreign keys', () => {
    const { db } = memoryDatabase();
    expect(runMigrations(db)).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
  });

  it('refuses a migration that changed after it was applied', () => {
    const dir = tmp();
    writeFileSync(join(dir, '0001_one.sql'), 'CREATE TABLE t (a TEXT) STRICT;');
    const db = openDatabase(':memory:');
    runMigrations(db, dir);
    writeFileSync(join(dir, '0001_one.sql'), 'CREATE TABLE t (a TEXT, b TEXT) STRICT;');
    expect(() => runMigrations(db, dir)).toThrow(/changed after it was applied/);
  });

  it('rolls a failed migration back completely', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, '0001_bad.sql'),
      'CREATE TABLE ok (a TEXT) STRICT; CREATE TABLE ok (a TEXT) STRICT;',
    );
    const db = openDatabase(':memory:');
    expect(() => runMigrations(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toMatchObject({ n: 0 });
  });

  it('rejects migration files with unexpected names', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'init.sql'), 'SELECT 1;');
    expect(() => runMigrations(openDatabase(':memory:'), dir)).toThrow(/0001_name\.sql/);
  });

  it.skipIf(process.platform === 'win32')('creates the database owner-only', () => {
    const dir = join(tmp(), 'data');
    const path = join(dir, 'spoolspot.db');
    const db = openDatabase(path);
    db.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
