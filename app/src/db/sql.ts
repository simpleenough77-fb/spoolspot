// SPDX-License-Identifier: AGPL-3.0-or-later
// The only database surface the data layer uses. It is async and batch-based on purpose: Cloudflare D1
// (hosted tier, ADR-0003) is async and has no interactive transactions, only atomic batches. The Node
// implementation lives in sqlite.ts; a D1 implementation can satisfy the same interface later.

export type SqlParam = string | number | null;

export interface Statement {
  readonly query: string;
  readonly params?: readonly SqlParam[];
}

export interface Sql {
  /**
   * Run one read query (SELECT, or WITH ... SELECT) with bound parameters. Never build `query` from
   * user input. Anything else is refused before it runs (SPOOL-199, statement-guard.ts).
   */
  all<T extends object>(query: string, params?: readonly SqlParam[]): Promise<T[]>;
  /**
   * Run statements atomically: all take effect or none do. Resolves to the number of rows each
   * statement changed, in order (D1 reports the same as meta.changes), so a guarded write can tell
   * whether it actually applied. Only INSERT, UPDATE, DELETE, SELECT and WITH statements are
   * accepted, one per entry; a batch holding anything else is refused and runs nothing.
   */
  batch(statements: readonly Statement[]): Promise<number[]>;
}
