// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings come from the environment. Secrets are read here and never logged.
import { isIPv4 } from 'node:net';

/** Self-hosting is single tenant: every record belongs to this fixed tenant (ADR-0004). */
export const SELF_HOST_TENANT_ID = '3b1c0d1e-5a1e-4c63-9a0e-5b2a6f0c7d11';

export interface Config {
  readonly databasePath: string;
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly devToken: string;
  readonly tenantId: string;
  /** Explicit opt-in to listen beyond this computer (SPOOLSPOT_ALLOW_LAN=1). */
  readonly allowLan: boolean;
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopback(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1') return true;
  return isIPv4(h) && h.startsWith('127.');
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const portText = env.SPOOLSPOT_PORT ?? '8787';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SPOOLSPOT_PORT must be a whole number from 1 to 65535');
  }
  const allowedHosts = (env.SPOOLSPOT_ALLOWED_HOSTS ?? LOOPBACK.join(','))
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  if (allowedHosts.length === 0) {
    throw new Error('SPOOLSPOT_ALLOWED_HOSTS must list at least one host name');
  }
  return {
    databasePath: env.SPOOLSPOT_DB ?? 'data/spoolspot.db',
    host: env.SPOOLSPOT_HOST ?? '127.0.0.1',
    port,
    allowedHosts,
    devToken: env.SPOOLSPOT_DEV_TOKEN ?? '',
    tenantId: SELF_HOST_TENANT_ID,
    allowLan: env.SPOOLSPOT_ALLOW_LAN === '1',
  };
}
