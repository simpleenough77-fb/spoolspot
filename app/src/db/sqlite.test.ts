// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../testing.ts';

describe('sql adapter', () => {
  it('refuses a statement that binds more than 100 parameters (D1 limit)', async () => {
    const { sql } = memoryDatabase();
    const many = Array.from({ length: 101 }, () => 1);
    await expect(sql.all('SELECT 1', many)).rejects.toThrow(/at most 100/);
    await expect(sql.batch([{ query: 'SELECT 1', params: many }])).rejects.toThrow(/at most 100/);
  });

  it('allows exactly 100 parameters', async () => {
    const { sql } = memoryDatabase();
    const hundred = Array.from({ length: 100 }, () => 1);
    const placeholders = hundred.map(() => '?').join(',');
    await expect(sql.all(`SELECT ${placeholders}`, hundred)).resolves.toHaveLength(1);
  });

  it('keeps the original error when a batch fails', async () => {
    const { sql } = memoryDatabase();
    await expect(sql.batch([{ query: 'INSERT INTO nope VALUES (1)' }])).rejects.toThrow(/nope/);
  });
});
