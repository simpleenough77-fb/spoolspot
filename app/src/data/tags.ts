// SPDX-License-Identifier: AGPL-3.0-or-later
// Tag IDs (ADR-0001): 12 random characters from the Crockford base32 alphabet, written in uppercase,
// carrying no personal data. Web Standard APIs only, so this runs on Node and on Workers alike.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TAG_LENGTH = 12;
const TAG_INPUT = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{12}$/;

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
  // Checked as typed, before any case change: toUpperCase() folds some non-ASCII letters into the
  // alphabet (U+017F becomes S, U+00DF becomes SS), which would give one tag many spellings.
  return TAG_INPUT.test(text) ? text.toUpperCase() : null;
}

/**
 * True when a write failed because the tag ID is already used in this tenant: the unique index on
 * (tenant_id, tag_id) of the registry, or of the clip or location column. A clash on a record's own ID
 * is not a tag clash and is not retried. SQLite and D1 both report the failing columns in the message
 * (D1 adds a prefix, which the pattern allows).
 */
export function isTagConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed: (tag|clip|location)\.tenant_id, \1\.tag_id\b/.test(error.message)
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
