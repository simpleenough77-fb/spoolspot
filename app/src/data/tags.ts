// SPDX-License-Identifier: AGPL-3.0-or-later
// Tag IDs (ADR-0001): 12 random characters from the Crockford base32 alphabet, written in uppercase,
// carrying no personal data. Web Standard APIs only, so this runs on Node and on Workers alike.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TAG_LENGTH = 12;
const TAG_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;

/** A fresh random ID from the platform CSPRNG. 32 symbols and 5 bits each, so there is no bias. */
export function newTagId(): string {
  const bytes = new Uint8Array(TAG_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET.charAt(b & 31)).join('');
}

/**
 * The canonical form of text that might be a tag ID, or null. The resolver ignores case (ADR-0001), so
 * lowercase is accepted; anything else, including look-alike letters (I, L, O, U), is not a tag.
 */
export function normalizeTagId(text: string): string | null {
  const upper = text.toUpperCase();
  return TAG_PATTERN.test(upper) ? upper : null;
}

/** True when a write failed because the tag ID is already used in this tenant. */
export function isTagConflict(error: unknown): boolean {
  return (
    error instanceof Error && /UNIQUE constraint failed: (tag|clip|location)\./i.test(error.message)
  );
}

/**
 * Runs `attempt` with a fresh tag ID, and again with another when the ID is already taken. A collision
 * among 32^12 values is very unlikely; this is the handling for when it happens anyway. Other errors
 * are thrown at once. `attempt` must be safe to run again (a failed write stores nothing).
 */
export async function withFreshTag<T>(
  attempt: (tagId: string) => Promise<T>,
  maxAttempts = 5,
  generate: () => string = newTagId,
): Promise<T> {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt(generate());
    } catch (error) {
      if (!isTagConflict(error) || n >= maxAttempts) throw error;
    }
  }
}
