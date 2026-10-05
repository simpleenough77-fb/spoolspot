// SPDX-License-Identifier: AGPL-3.0-or-later
// The one place that talks to the server. A pasted token lives only in this closure while the page is
// open: never in storage, never in a URL, only in an Authorization header. On the tap page the token is
// traded once for an HttpOnly session cookie (signIn); after that the browser sends the cookie and the
// page never holds a secret.
let token = '';

export function setToken(value) {
  token = value;
}

export function hasToken() {
  return token !== '';
}

export class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${String(status)}`);
    this.status = status;
    this.body = body ?? null;
  }
}

const authHeaders = () => (token === '' ? {} : { Authorization: `Bearer ${token}` });

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function getJson(path) {
  const response = await fetch(path, { headers: authHeaders(), cache: 'no-store' });
  if (!response.ok) throw new ApiError(response.status, await readBody(response));
  return response.json();
}

export async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) throw new ApiError(response.status, await readBody(response));
  return response.json();
}

/** Trades the token for a session cookie, then forgets the token. Throws ApiError on a bad token. */
export async function signIn(value) {
  const response = await fetch('/api/v1/session', {
    method: 'POST',
    headers: { Authorization: `Bearer ${value}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new ApiError(response.status, null);
  token = '';
}

export async function signOut() {
  await fetch('/api/v1/session', { method: 'DELETE', cache: 'no-store' });
}
