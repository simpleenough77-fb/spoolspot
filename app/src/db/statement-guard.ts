// SPDX-License-Identifier: AGPL-3.0-or-later
// The statement allow-list of the SQL adapter (SPOOL-199). Application code only ever reads and changes
// rows: `all()` runs reads, `batch()` runs data statements. Schema changes, pragmas, attaching other
// databases and transaction control belong to the migration runner and the adapter itself, which use
// their own path to the database handle and never pass through here.
//
// This is a prefix and shape check, not a SQL parser. It catches mistakes and stray code paths (a
// pragma or a schema statement sent through the adapter by accident); it does not defend against
// anyone who controls SQL text, and an allowed statement can still do harm (a trigger it fires, a
// DELETE without a tenant filter). Queries are never built from user input; that rule still applies.

/** A statement the adapter will not run. Thrown before anything in the call is executed. */
export class StatementNotAllowedError extends Error {
  constructor(reason: string) {
    // The reason names a statement class, never the SQL text, so it is safe for the one-line log.
    super(`statement not allowed: ${reason}`);
    this.name = 'StatementNotAllowedError';
  }
}

/**
 * The statement with comments removed and every string literal and quoted identifier replaced by a
 * blank placeholder, so keywords inside them are not mistaken for code. The contents of every quoted
 * text are returned separately, because a quoted name is still a name: single quotes included, since
 * SQLite reads a single-quoted string as a name where only a name can go. Refuses
 * text whose quote or comment is never closed: such text is malformed, and guessing where it ends
 * could hide a statement.
 */
function codeOf(query: string): { code: string; quotedNames: string[] } {
  const quotedNames: string[] = [];
  let out = '';
  let i = 0;
  const n = query.length;
  while (i < n) {
    const c = query.charAt(i);
    const next = query[i + 1];
    if (c === '-' && next === '-') {
      const end = query.indexOf('\n', i + 2);
      out += ' ';
      i = end === -1 ? n : end + 1;
    } else if (c === '/' && next === '*') {
      const end = query.indexOf('*/', i + 2);
      if (end === -1) throw new StatementNotAllowedError('an unclosed comment');
      out += ' ';
      i = end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        const end = query.indexOf(close, j);
        if (end === -1) throw new StatementNotAllowedError('an unclosed quote');
        // A doubled quote inside a string or identifier is an escaped quote, not the end.
        if (close !== ']' && query[end + 1] === close) {
          j = end + 2;
          continue;
        }
        j = end + 1;
        break;
      }
      quotedNames.push(query.slice(i + 1, j - 1).replaceAll(close + close, close));
      out += ' _ ';
      i = j;
    } else {
      out += c;
      i += 1;
    }
  }
  return { code: out, quotedNames };
}

/**
 * Names that reach SQLite internals from a statement that otherwise looks like data: table-valued
 * pragma functions (pragma_optimize runs ANALYZE), the sqlite_ schema and statistics tables, and the
 * dbstat virtual table. No application statement uses them; startup checks read sqlite_master on
 * their own path.
 */
const INTERNAL_NAME = /^(pragma_|sqlite_)\w*$|^dbstat$/i;

function firstWord(code: string): string {
  return (/^\s*([A-Za-z]+)/.exec(code)?.[1] ?? '').toUpperCase();
}

/** Shape checks shared by every statement: no SQLite internal name, one statement, no REPLACE. */
function shape(query: string): { code: string; first: string } {
  const { code, quotedNames } = codeOf(query);
  const words = code.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  if ([...words, ...quotedNames].some((name) => INTERNAL_NAME.test(name))) {
    throw new StatementNotAllowedError('a SQLite internal name (pragma function or sqlite_ table)');
  }
  // Any semicolon outside a string or comment: a second statement, or a trailing one. None is needed.
  if (code.includes(';')) throw new StatementNotAllowedError('more than one statement');
  // REPLACE removes the conflicting row without firing delete triggers, so it is refused on every
  // table (no caller uses it). The repository scan in tag-registry.test.ts still covers raw paths.
  if (/\b(INSERT|UPDATE)\s+OR\s+REPLACE\b|\bREPLACE\s+INTO\b/i.test(code)) {
    throw new StatementNotAllowedError('a REPLACE write');
  }
  return { code, first: firstWord(code) };
}

/** A WITH statement whose main statement writes (SQLite allows only SELECT inside the CTEs). */
function writesAfterWith(code: string): boolean {
  return /\b(INSERT|UPDATE|DELETE)\b/i.test(code);
}

/** `all()`: one read. SELECT, or WITH followed by a SELECT. */
export function assertRead(query: string): void {
  const { code, first } = shape(query);
  if (first === 'SELECT') return;
  if (first === 'WITH') {
    if (writesAfterWith(code)) throw new StatementNotAllowedError('a write in a read');
    return;
  }
  throw new StatementNotAllowedError('only a read (SELECT or WITH) may run here');
}

const DATA = new Set(['INSERT', 'UPDATE', 'DELETE', 'SELECT', 'WITH']);

/** `batch()`: one data statement. INSERT, UPDATE, DELETE, SELECT or WITH; nothing else. */
export function assertData(query: string): void {
  const { first } = shape(query);
  if (!DATA.has(first)) {
    throw new StatementNotAllowedError(
      'only INSERT, UPDATE, DELETE, SELECT or WITH may run in a batch',
    );
  }
}
