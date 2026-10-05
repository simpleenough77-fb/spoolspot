// SPDX-License-Identifier: AGPL-3.0-or-later
// Validation of a filament catalog (sample format until the studio contract exists, SPOOL-7).
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule.default;

export interface CatalogIssue {
  path: string;
  message: string;
}

export interface CatalogFilament {
  id: string;
  manufacturer: string;
  type: string;
  color: string;
  spool_kind: 'refillable' | 'disposable';
}

export interface CatalogDocument {
  version: string;
  generated: string;
  filaments: CatalogFilament[];
}

const compiled = new WeakMap<object, ReturnType<Ajv2020['compile']>>();

function compile(schema: object): ReturnType<Ajv2020['compile']> {
  const known = compiled.get(schema);
  if (known) return known;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  compiled.set(schema, validate);
  return validate;
}

/** One key for "the same filament" everywhere: Unicode-normalised and case-folded. */
export function filamentKey(f: { manufacturer: string; type: string; color: string }): string {
  return [f.manufacturer, f.type, f.color]
    .map((x) => x.normalize('NFC').toLowerCase())
    .join('\u0000');
}

// Characters that make two names look the same, or reverse what a person reads: control, format
// (zero-width, bidi), private-use, unassigned, line and paragraph separators, and any space but U+0020.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?!\u0020)\p{Zs}/u;

function textIssue(value: string): string | null {
  if (/\p{Cs}/u.test(value)) return 'contains a lone surrogate';
  if (value !== value.normalize('NFC')) return 'is not Unicode-normalised (NFC)';
  if (UNSAFE.test(value)) return 'contains an invisible, control or direction-changing character';
  return null;
}

/** Schema first, then the rules a schema cannot express (duplicates). Nothing is imported unless this is empty. */
export function validateCatalog(doc: unknown, schema: object): CatalogIssue[] {
  const validate = compile(schema);
  if (!validate(doc)) {
    return (validate.errors ?? []).slice(0, 50).map((e) => ({
      path: e.instancePath || '/',
      message: `${e.message ?? 'invalid'} (${JSON.stringify(e.params)})`,
    }));
  }
  const issues: CatalogIssue[] = [];
  const ids = new Set<string>();
  const names = new Map<string, number>();
  (doc as CatalogDocument).filaments.forEach((f, i) => {
    for (const field of ['manufacturer', 'type', 'color'] as const) {
      const problem = textIssue(f[field]);
      if (problem) issues.push({ path: `/filaments/${String(i)}/${field}`, message: problem });
    }
    if (ids.has(f.id))
      issues.push({ path: `/filaments/${String(i)}/id`, message: `duplicate id "${f.id}"` });
    ids.add(f.id);
    // Case-insensitive: "Black" and "black" from one manufacturer would be one filament to a person.
    const key = filamentKey(f);
    const first = names.get(key);
    if (first !== undefined) {
      issues.push({
        path: `/filaments/${String(i)}`,
        message: `same manufacturer, type and color as /filaments/${String(first)}`,
      });
    } else {
      names.set(key, i);
    }
  });
  return issues.slice(0, 50);
}
