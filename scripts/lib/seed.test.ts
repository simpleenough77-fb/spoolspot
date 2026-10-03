// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateSeed } from './seed.ts';

interface Loc {
  id: string;
  type: string;
  leaf: boolean;
  capacity: number | null;
  parent: string | null;
  tag_id: string | null;
  tag_source: string | null;
  capacity_mode: string | null;
  [key: string]: unknown;
}
interface Seed {
  version: string;
  generated: string;
  locations: Loc[];
}

const schema = JSON.parse(
  readFileSync(new URL('../../schema/locations-seed.schema.json', import.meta.url), 'utf8'),
) as object;
const seedText = readFileSync(new URL('../../seed/locations-seed.json', import.meta.url), 'utf8');

function freshSeed(): Seed {
  return JSON.parse(seedText) as Seed;
}
function loc(seed: Seed, id: string): Loc {
  const found = seed.locations.find((l) => l.id === id);
  if (!found) throw new Error(`fixture location ${id} missing`);
  return found;
}

describe('the committed seed (the real inventory)', () => {
  const seed = freshSeed();
  const leaves = seed.locations.filter((l) => l.leaf);
  const capacity = (type: string) =>
    leaves.filter((l) => l.type === type).reduce((sum, l) => sum + (l.capacity ?? 0), 0);

  it('validates against its schema', () => {
    expect(validateSeed(seed, schema)).toEqual([]);
  });

  it('has the documented shape: 81 records, 54 leaves, 27 containers', () => {
    expect(seed.locations).toHaveLength(81);
    expect(leaves).toHaveLength(54);
    expect(seed.locations.filter((l) => !l.leaf)).toHaveLength(27);
  });

  it('has 30 slots, 9 active shelves with 107 places, 14 passive, 1 clip bin', () => {
    expect(leaves.filter((l) => l.type === 'active_use')).toHaveLength(30);
    expect(leaves.filter((l) => l.type === 'active_storage')).toHaveLength(9);
    expect(capacity('active_storage')).toBe(107);
    expect(leaves.filter((l) => l.type === 'passive_storage')).toHaveLength(14);
    expect(leaves.filter((l) => l.type === 'clip_storage')).toHaveLength(1);
  });

  it('has no tags assigned yet', () => {
    expect(seed.locations.every((l) => l.tag_id === null)).toBe(true);
  });
});

describe('a broken seed fails validation', () => {
  it('rejects an unknown location type', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-1').type = 'shelf';
    expect(validateSeed(seed, schema).length).toBeGreaterThan(0);
  });

  it('rejects a slot whose capacity is not 1', () => {
    const seed = freshSeed();
    loc(seed, 'dreammaker.ams-a.slot-1').capacity = 2;
    expect(validateSeed(seed, schema).length).toBeGreaterThan(0);
  });

  it('rejects a container that carries a capacity', () => {
    const seed = freshSeed();
    loc(seed, 'home').capacity = 5;
    expect(validateSeed(seed, schema).length).toBeGreaterThan(0);
  });

  it('rejects a leaf with no capacity mode', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-1').capacity_mode = null;
    expect(validateSeed(seed, schema).length).toBeGreaterThan(0);
  });

  it('rejects a malformed tag id', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-1').tag_id = 'not-a-tag';
    expect(validateSeed(seed, schema).length).toBeGreaterThan(0);
  });

  it('rejects an extra field (weight is never tracked)', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-1').weight_g = 1000;
    expect(validateSeed(seed, schema).length).toBeGreaterThan(0);
  });

  it('rejects a duplicate id', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-2').id = 'loc1.shelf-1';
    expect(validateSeed(seed, schema).map((i) => i.message)).toContain(
      'duplicate id "loc1.shelf-1"',
    );
  });

  it('rejects a missing parent', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-1').parent = 'nowhere';
    expect(validateSeed(seed, schema).map((i) => i.message)).toContain(
      'parent "nowhere" does not exist',
    );
  });

  it('rejects a leaf used as a parent', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-2').parent = 'loc1.shelf-1';
    const messages = validateSeed(seed, schema).map((i) => i.message);
    expect(messages).toContain('parent "loc1.shelf-1" is a leaf');
  });

  it('rejects two roots', () => {
    const seed = freshSeed();
    loc(seed, 'active').parent = null;
    expect(validateSeed(seed, schema).map((i) => i.message)).toContain(
      'expected exactly one root, found 2',
    );
  });

  it('rejects a cycle', () => {
    const seed = freshSeed();
    loc(seed, 'home').parent = 'loc1';
    const messages = validateSeed(seed, schema).map((i) => i.message);
    expect(messages.some((m) => m.startsWith('cycle through'))).toBe(true);
  });

  it('rejects two locations sharing one tag id', () => {
    const seed = freshSeed();
    loc(seed, 'loc1.shelf-1').tag_id = '0123456789AB';
    loc(seed, 'loc1.shelf-2').tag_id = '0123456789AB';
    expect(validateSeed(seed, schema).map((i) => i.message)).toContain(
      'tag_id is already used by "loc1.shelf-1"',
    );
  });
});
