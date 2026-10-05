// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createScopedData } from './scoped.ts';
import { isTagConflict, newTagId, normalizeTagId, withFreshTag } from './tags.ts';
import { ForbiddenError, Scope, type Principal } from '../auth/principal.ts';
import { memoryDatabase, TENANT_A, TENANT_B, uuid } from '../testing.ts';

const TAG = '0123456789AB';

function principal(tenantId: string): Principal {
  return { subject: 'test', tenantId, scopes: new Set([Scope.LocationsRead]) };
}

describe('newTagId', () => {
  it('makes 12 uppercase Crockford base32 characters, with no repeats in a large sample', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      const id = newTagId();
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });
});

describe('normalizeTagId', () => {
  it('ignores case and rejects anything that is not a tag', () => {
    expect(normalizeTagId(TAG.toLowerCase())).toBe(TAG);
    for (const bad of [
      '',
      'short',
      `${TAG}A`,
      '0123456789AI',
      '0123456789AO',
      ' 0123456789AB',
      '0123456789Aé',
    ]) {
      expect(normalizeTagId(bad), bad).toBeNull();
    }
  });
});

describe('withFreshTag', () => {
  it('retries with a new ID when the ID is taken, and stops at the limit', async () => {
    const conflict = new Error('UNIQUE constraint failed: tag.tenant_id, tag.tag_id');
    const ids = ['A'.repeat(12), 'B'.repeat(12), 'C'.repeat(12)];
    const used: string[] = [];
    const result = await withFreshTag(
      (id) => {
        used.push(id);
        return used.length < 3 ? Promise.reject(conflict) : Promise.resolve(id);
      },
      5,
      () => ids[used.length] ?? 'Z'.repeat(12),
    );
    expect(result).toBe('C'.repeat(12));
    expect(used).toEqual(ids);

    let tries = 0;
    await expect(
      withFreshTag(() => {
        tries += 1;
        return Promise.reject(conflict);
      }, 3),
    ).rejects.toBe(conflict);
    expect(tries).toBe(3);
  });

  it('does not retry other errors', async () => {
    let tries = 0;
    await expect(
      withFreshTag(() => {
        tries += 1;
        return Promise.reject(new Error('disk is full'));
      }),
    ).rejects.toThrow('disk is full');
    expect(tries).toBe(1);
    expect(isTagConflict(new Error('UNIQUE constraint failed: clip.tenant_id, clip.tag_id'))).toBe(
      true,
    );
    expect(isTagConflict('UNIQUE')).toBe(false);
  });

  it('recovers from a real collision in the database', async () => {
    const { db, sql } = memoryDatabase();
    db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(TENANT_A);
    const f = uuid();
    db.prepare(
      "INSERT INTO filament (tenant_id, id, manufacturer, type, color, spool_kind) VALUES (?, ?, 'M', 'PLA', 'Red', 'refillable')",
    ).run(TENANT_A, f);
    db.prepare(
      "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
    ).run(TENANT_A, uuid(), TAG, f);
    const queue = [TAG, TAG, 'CDEFGHJKMNPQ'];
    const id = uuid();
    const used = await withFreshTag(
      async (tagId) => {
        await sql.batch([
          {
            query:
              "INSERT INTO clip (tenant_id, id, tag_id, filament_id, state) VALUES (?, ?, ?, ?, 'free')",
            params: [TENANT_A, id, tagId, f],
          },
        ]);
        return tagId;
      },
      5,
      () => queue.shift() ?? newTagId(),
    );
    expect(used).toBe('CDEFGHJKMNPQ');
  });
});

describe('resolveTag', () => {
  function setup() {
    const { db, sql } = memoryDatabase();
    for (const t of [TENANT_A, TENANT_B]) {
      db.prepare('INSERT INTO tenant_settings (tenant_id) VALUES (?)').run(t);
    }
    db.prepare(
      `INSERT INTO location (tenant_id, id, name, type, leaf, capacity, capacity_mode, tag_id, tag_source)
       VALUES (?, 'shelf', 'Shelf', 'passive_storage', 1, 5, 'soft', ?, 'sticker')`,
    ).run(TENANT_A, TAG);
    return sql;
  }

  it('finds a tag in its own tenant, in either case', async () => {
    const sql = setup();
    const data = createScopedData(sql, principal(TENANT_A));
    expect(await data.resolveTag(TAG)).toEqual({ kind: 'location', target_id: 'shelf' });
    expect(await data.resolveTag(TAG.toLowerCase())).toEqual({
      kind: 'location',
      target_id: 'shelf',
    });
  });

  it('answers null alike for an unknown tag, a malformed tag and another tenant’s tag', async () => {
    const sql = setup();
    const other = createScopedData(sql, principal(TENANT_B));
    const mine = createScopedData(sql, principal(TENANT_A));
    expect(await other.resolveTag(TAG)).toBeNull();
    expect(await mine.resolveTag('CDEFGHJKMNPQ')).toBeNull();
    expect(await mine.resolveTag("'; DROP TABLE tag; --")).toBeNull();
    expect(await mine.resolveTag('')).toBeNull();
  });

  it('needs the read scope', async () => {
    const sql = setup();
    const none: Principal = { subject: 'x', tenantId: TENANT_A, scopes: new Set() };
    await expect(createScopedData(sql, none).resolveTag(TAG)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
