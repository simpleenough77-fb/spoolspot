// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { TEST_TOKEN } from '../testing.ts';
import {
  checkDevToken,
  createDevTokenProvider,
  equalBytes,
  MIN_TOKEN_LENGTH,
} from './dev-token.ts';
import { Scope } from './principal.ts';

const provider = createDevTokenProvider({ token: TEST_TOKEN, tenantId: 'tenant-a' });
const request = (authorization?: string): Request =>
  new Request(
    'http://localhost/api/v1/x',
    authorization === undefined ? {} : { headers: { authorization } },
  );

describe('dev token provider', () => {
  it('maps the right token to one fixed tenant with read scope only', async () => {
    const principal = await provider.authenticate(request(`Bearer ${TEST_TOKEN}`));
    expect(principal).toMatchObject({ subject: 'dev-token', tenantId: 'tenant-a' });
    expect([...(principal?.scopes ?? [])]).toEqual([Scope.LocationsRead]);
  });

  it('accepts the scheme in any letter case', async () => {
    expect(await provider.authenticate(request(`bearer ${TEST_TOKEN}`))).not.toBeNull();
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['the wrong token', `Bearer ${TEST_TOKEN}x`],
    ['a prefix of the token', `Bearer ${TEST_TOKEN.slice(0, -1)}`],
    ['another scheme', `Basic ${TEST_TOKEN}`],
    ['no scheme', TEST_TOKEN],
    ['extra words', `Bearer ${TEST_TOKEN} extra`],
    ['a token split by a space', `Bearer ${TEST_TOKEN.slice(0, 10)} ${TEST_TOKEN.slice(10)}`],
  ])('refuses %s', async (_label, header) => {
    expect(await provider.authenticate(request(header))).toBeNull();
  });

  it('refuses to start with a weak token', () => {
    expect(() => createDevTokenProvider({ token: '', tenantId: 't' })).toThrow(/at least 32/);
    expect(() =>
      createDevTokenProvider({ token: 'a'.repeat(MIN_TOKEN_LENGTH - 1) + 'b', tenantId: 't' }),
    ).toThrow(/repetitive/);
    expect(() => createDevTokenProvider({ token: 'abcdefgh'.repeat(3), tenantId: 't' })).toThrow(
      /at least 32/,
    );
    expect(() =>
      createDevTokenProvider({ token: `${TEST_TOKEN} with space`, tenantId: 't' }),
    ).toThrow(/printable ASCII/);
  });

  it('never repeats the token in an error message', () => {
    for (const token of ['short', 'a'.repeat(40), `${TEST_TOKEN} x`]) {
      const message = checkDevToken(token) ?? '';
      expect(message).not.toContain(token);
    }
  });

  it('compares bytes exactly', () => {
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});
