# app

The SpoolSpot application (TypeScript, Hono, SQLite; see the decisions index).

- `src/` server, data layer, migrations runner and seed importer; `migrations/` numbered SQL files.
- `public/` the static pages served by the Node entry point and scanned by the accessibility check.

Development: `pnpm db:migrate`, `pnpm seed:import`, `pnpm dev` (set `SPOOLSPOT_DEV_TOKEN`).

## Location tree and placement (development preview)

The page shows Home, containers and leaf locations, collapsible. Each leaf shows used, capacity and free with a hard or soft badge; a leaf with no capacity says "Capacity not set" and is never suggested. Used is derived from what is stored at the location (boxed counts plus clips); nothing is typed in.

- `GET /api/v1/locations/tree`: the nested tree with used, capacity, free and over.
- `GET /api/v1/locations/{id}/placement?count=N`: what would happen if N units went there (`ok`, `notice` over a soft limit, `warning` over a hard limit, `capacity_not_set`). `id` can be a container too (Home, the Storage closet): the answer adds up the room of the places inside that have a capacity (`leaves_counted`) and reports the ones left out (`leaves_without_capacity`); slots are skipped unless the container holds only slots. `fits_in_one_place` says whether a single place holds all of it. Boxed counts, opened spools and clips all count as room. Over the total, the outcome is `notice` when a counted place has a soft limit, else `warning`. Read-only. An unknown id and another tenant's id both answer 404.
- `GET /api/v1/placement-suggestions?count=N[&type=...][&within=<id>]`: leaves with room (inside `within`, if given; unknown or other-tenant ids answer 404), most free first. Active_use slots are left out unless you ask for them with `type=active_use`.

A tree with nothing stored shows 0 used everywhere. To see used and free on your own tree, `pnpm demo:fill` adds clearly marked demo items and `pnpm demo:remove` takes exactly those away again. Container roll-ups add up each leaf's free places, so one full shelf never hides room on another. Several roots or leaves without a parent are allowed by the schema; the app does not create them.

## Tags, sessions and moving a clip (development preview)

A tag is a URL (ADR-0001): `<host>/<6-character instance code><12-character tag ID>`. In this phase the server is the resolver: set `SPOOLSPOT_INSTANCE_CODE` (6 characters, 0-9 and A-Z without I, L, O, U) to turn the tag route on. Tag IDs are random, unique per tenant across locations and clips, and carry no personal data.

- `GET /<code><id>`: serves one page for a tag of this instance, known or not (it carries no data; the page signs in and then asks the API). A wrong code, a malformed path and an unknown tag all give the same neutral 404 page. The route never redirects and is rate limited (60 a minute per connecting address).
- `POST /api/v1/session` (Bearer token) starts a session: an HttpOnly, SameSite=Strict cookie (`__Host-` and Secure over HTTPS; `SPOOLSPOT_SECURE_COOKIES=1` forces that behind a TLS-terminating proxy). `DELETE /api/v1/session` signs out. A cookie-signed change must come from this site (the `Origin` must match the `Host`), or it is refused with 403. Sessions last 12 hours and live in memory, so a restart signs everyone out.
- `GET /api/v1/tags/{id}`: the clip or location a tag stands for. Malformed, unknown and another tenant's tags all answer the same 404.
- `GET /api/v1/locations/{id}/clips`: clips stored at a place (for choosing a clip without NFC).
- `POST /api/v1/clips/{id}/move` with `{"to": "<location id>", "confirm": true|false}`: moves one clip to a place that holds units and records a `move` event, atomically. Past a hard limit it answers 409 `needs_confirmation` until `confirm` is true; a soft limit and an unset capacity go through. A place that changed between the check and the write answers 409 `conflict` and stores nothing. Slots are loaded and unloaded by the load workflow (SPOOL-84), so a move into or out of one answers 422. Which places suit a clip's state is also left to those workflows.

Failed sign-ins are rate limited per connecting address (10 a minute); after that even the right token is refused until the window ends. Behind a reverse proxy every caller shares the proxy's address, so run it only on a trusted network until a trusted-proxy setting exists.

### The tag page and moving a clip by tapping (development preview)

Opening a tag link shows what the tag stands for. First visit: paste the development token once; it is traded for a session cookie and forgotten by the page. A clip tag shows the filament, its state and where it is now, with **Move this clip** (held for ten minutes). A place tag shows used and free, lists the clips there, and offers **Move <held clip> here** when one is held. Every move ends on an on-screen **Move here** tap; past a hard limit the page warns and asks again with **Move anyway**. A soft limit goes through.

Without NFC the same move is on the main page (**Move a clip**): pick the place the clip is in, tap the clip, pick the destination. Unknown, malformed and other-instance tags all show the same neutral message.

For a phone demo: `pnpm demo:fill`, start the server with `SPOOLSPOT_INSTANCE_CODE=<6 characters>`, then `pnpm demo:links http://<your-ip>:8787` prints links for three tagged places and two clips. `pnpm demo:remove` clears the demo items and their tags.
