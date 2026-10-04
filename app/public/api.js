// SPDX-License-Identifier: AGPL-3.0-or-later
// The one place that talks to the server. The token lives only in this closure for as long as the page
// is open: it is never written to storage, never put in a URL and only sent in an Authorization header.
let token = '';

export function setToken(value) {
  token = value;
}

export function hasToken() {
  return token !== '';
}

export class ApiError extends Error {
  constructor(status) {
    super(`HTTP ${String(status)}`);
    this.status = status;
  }
}

export async function getJson(path) {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json();
}
