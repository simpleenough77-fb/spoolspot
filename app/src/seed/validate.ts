// SPDX-License-Identifier: AGPL-3.0-or-later
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS; under NodeNext the callable is exposed as `.default`.
const addFormats = addFormatsModule.default;

export interface Issue {
  path: string;
  message: string;
}

export type LocationType =
  | 'container'
  | 'passive_storage'
  | 'active_storage'
  | 'active_use'
  | 'clip_storage';

export interface SeedLocation {
  id: string;
  name: string;
  type: LocationType;
  parent: string | null;
  leaf: boolean;
  capacity: number | null;
  capacity_mode: 'hard' | 'soft' | null;
  prefers_manufacturer: string | null;
  tag_id: string | null;
  tag_source: 'sticker' | 'holder_post' | null;
}

export interface SeedDocument {
  version: string;
  generated: string;
  locations: SeedLocation[];
}

/** Validate a seed document against its JSON Schema, then against referential rules. */
export function validateSeed(seed: unknown, schema: object): Issue[] {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(seed)) {
    return (validate.errors ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: `${e.message ?? 'invalid'} (${JSON.stringify(e.params)})`,
    }));
  }
  return referentialIssues(seed as SeedDocument);
}

/** Rules JSON Schema cannot express. Assumes the document already passed the schema. */
export function referentialIssues(doc: Pick<SeedDocument, 'locations'>): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, SeedLocation>();
  doc.locations.forEach((loc, i) => {
    if (byId.has(loc.id)) {
      issues.push({ path: `/locations/${String(i)}/id`, message: `duplicate id "${loc.id}"` });
    }
    byId.set(loc.id, loc);
  });

  const childCount = new Map<string, number>();
  const seenTags = new Map<string, string>();
  let roots = 0;
  doc.locations.forEach((loc, i) => {
    const at = `/locations/${String(i)}`;
    if (loc.parent === null) {
      roots += 1;
    } else {
      const parent = byId.get(loc.parent);
      if (!parent) {
        issues.push({ path: `${at}/parent`, message: `parent "${loc.parent}" does not exist` });
      } else if (parent.leaf) {
        issues.push({ path: `${at}/parent`, message: `parent "${loc.parent}" is a leaf` });
      }
      childCount.set(loc.parent, (childCount.get(loc.parent) ?? 0) + 1);
    }
    if (loc.tag_id !== null) {
      const first = seenTags.get(loc.tag_id);
      if (first !== undefined) {
        issues.push({
          path: `${at}/tag_id`,
          message: `tag_id is already used by "${first}"`,
        });
      }
      seenTags.set(loc.tag_id, loc.id);
    }
  });
  if (roots !== 1) {
    issues.push({
      path: '/locations',
      message: `expected exactly one root, found ${String(roots)}`,
    });
  }

  // A leaf must have no children; a cycle means a location is its own ancestor.
  for (const loc of doc.locations) {
    if (loc.leaf && (childCount.get(loc.id) ?? 0) > 0) {
      issues.push({ path: '/locations', message: `leaf "${loc.id}" has children` });
    }
    const seen = new Set<string>([loc.id]);
    let cursor = loc.parent;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        issues.push({ path: '/locations', message: `cycle through "${loc.id}"` });
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.parent ?? null;
    }
  }
  return issues;
}
