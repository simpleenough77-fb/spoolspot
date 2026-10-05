// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { isLoopback, loadConfig } from './config.ts';

describe('isLoopback', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
    ' 127.0.0.1 ',
  ])('treats %j as this computer', (host) => {
    expect(isLoopback(host)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '::',
    '192.168.4.27',
    '127.evil.example',
    '127.0.0.1.evil.example',
    'localhost.evil.example',
    '',
  ])('treats %j as reachable from elsewhere', (host) => {
    expect(isLoopback(host)).toBe(false);
  });
});

describe('loadConfig', () => {
  it('defaults to loopback with no LAN opt-in', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.allowLan).toBe(false);
  });

  it('turns the LAN opt-in on only for the exact value 1', () => {
    expect(loadConfig({ SPOOLSPOT_ALLOW_LAN: '1' }).allowLan).toBe(true);
    for (const value of ['0', 'true', 'yes', '', ' 1']) {
      expect(loadConfig({ SPOOLSPOT_ALLOW_LAN: value }).allowLan, value).toBe(false);
    }
  });

  it('rejects a bad port and an empty host list', () => {
    expect(() => loadConfig({ SPOOLSPOT_PORT: '0' })).toThrow(/SPOOLSPOT_PORT/);
    expect(() => loadConfig({ SPOOLSPOT_PORT: 'abc' })).toThrow(/SPOOLSPOT_PORT/);
    expect(() => loadConfig({ SPOOLSPOT_ALLOWED_HOSTS: ' , ' })).toThrow(/ALLOWED_HOSTS/);
  });
});

describe('instance code', () => {
  it('is off unless set, and upper-cases a valid code', () => {
    expect(loadConfig({}).instanceCode).toBeNull();
    expect(loadConfig({ SPOOLSPOT_INSTANCE_CODE: '  ' }).instanceCode).toBeNull();
    expect(loadConfig({ SPOOLSPOT_INSTANCE_CODE: 'ab12cd' }).instanceCode).toBe('AB12CD');
  });

  it('refuses a code that is not 6 characters of the tag alphabet', () => {
    for (const bad of ['AB12C', 'AB12CDE', 'AB12CI', 'AB12CL', 'AB12CO', 'AB12CU', 'AB-2CD']) {
      expect(() => loadConfig({ SPOOLSPOT_INSTANCE_CODE: bad }), bad).toThrow(/INSTANCE_CODE/);
    }
  });
});
