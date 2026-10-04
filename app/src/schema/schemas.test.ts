// SPDX-License-Identifier: AGPL-3.0-or-later
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { memoryDatabase, readJson, readSeed, uuid } from '../testing.ts';

const addFormats = addFormatsModule.default;
const FILES = {
  location: 'schema/location.schema.json',
  filament: 'schema/filament.schema.json',
  'stock-line': 'schema/stock-line.schema.json',
  clip: 'schema/clip.schema.json',
  event: 'schema/event.schema.json',
} as const;
const TABLE: Record<keyof typeof FILES, string> = {
  location: 'location',
  filament: 'filament',
  'stock-line': 'stock_line',
  clip: 'clip',
  event: 'event',
};

function compile(name: keyof typeof FILES) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(readJson(FILES[name]));
}

function propertyNames(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) propertyNames(n, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        out.push(...Object.keys(value as object));
      }
      propertyNames(value, out);
    }
  }
  return out;
}

describe('JSON Schemas', () => {
  for (const name of Object.keys(FILES) as (keyof typeof FILES)[]) {
    it(`${name} compiles in strict mode`, () => {
      expect(() => compile(name)).not.toThrow();
    });

    it(`${name} has the same properties as its table, minus the tenant`, () => {
      const { db } = memoryDatabase();
      const cols = (
        db.prepare(`PRAGMA table_info(${TABLE[name]})`).all() as unknown as { name: string }[]
      )
        .map((c) => c.name)
        .filter((c) => c !== 'tenant_id')
        .sort();
      const schema = readJson(FILES[name]) as { properties: object; required: string[] };
      expect(Object.keys(schema.properties).sort()).toEqual(cols);
      expect([...schema.required].sort()).toEqual(cols);
    });

    it(`${name} has no weight, temperature, cost or per-print usage property`, () => {
      const forbidden =
        /(^|_)(weight|temp|temperature|cost|price|usage|remaining|grams?|mass|spent)(_|$)/;
      const names = propertyNames(readJson(FILES[name]));
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    });

    it(`${name} carries no tenant property`, () => {
      expect(propertyNames(readJson(FILES[name]))).not.toContain('tenant_id');
    });
  }

  it('every location in the seed validates against the location schema', () => {
    const validate = compile('location');
    const failures: string[] = [];
    for (const l of readSeed().locations) {
      const id = l.id;
      if (!validate(l)) failures.push(id);
    }
    expect(failures).toEqual([]);
  });

  it('the location schema refuses what the seed schema refuses', () => {
    const validate = compile('location');
    const base = readSeed().locations.find((l) => l.type === 'active_use');
    expect(base).toBeDefined();
    expect(validate(base)).toBe(true);
    expect(validate({ ...base, capacity: 2 })).toBe(false);
    expect(validate({ ...base, capacity_mode: 'soft' })).toBe(false);
    expect(validate({ ...base, tag_id: 'lower-case-no' })).toBe(false);
    expect(validate({ ...base, weight: 1 })).toBe(false);
    expect(validate({ ...base, parent: 'Bad Slug' })).toBe(false);
  });

  it('accepts a well-formed document and refuses a malformed one for each record type', () => {
    const filament = compile('filament');
    const doc = {
      id: uuid(),
      manufacturer: 'Bambu Lab',
      type: 'PLA Basic',
      color: 'Black',
      spool_kind: 'refillable',
      reorder_level: 'moderate',
      auto_level: false,
    };
    expect(filament(doc)).toBe(true);
    expect(filament({ ...doc, reorder_level: 'extreme' })).toBe(false);
    expect(filament({ ...doc, cost: 20 })).toBe(false);

    const stock = compile('stock-line');
    const line = {
      id: uuid(),
      filament_id: uuid(),
      location_id: 'closet.shelf-1',
      pack: 'spool',
      count: 2,
    };
    expect(stock(line)).toBe(true);
    expect(stock({ ...line, count: -1 })).toBe(false);
    expect(stock({ ...line, pack: 'box' })).toBe(false);

    const clip = compile('clip');
    const c = {
      id: uuid(),
      tag_id: '0123456789AB',
      filament_id: uuid(),
      location_id: null,
      state: 'free',
    };
    expect(clip(c)).toBe(true);
    expect(clip({ ...c, state: 'lost' })).toBe(false);

    const event = compile('event');
    const e = {
      id: uuid(),
      type: 'move',
      clip_id: uuid(),
      filament_id: null,
      from_location_id: null,
      to_location_id: 'closet.shelf-1',
      occurred_at: '2026-10-04T12:00:00.000Z',
    };
    expect(event(e)).toBe(true);
    expect(event({ ...e, type: 'comment' })).toBe(false);
    expect(event({ ...e, note: 'free text' })).toBe(false);
  });
});
