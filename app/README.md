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
- `GET /api/v1/tags/{id}[?held=<clip id>]`: the clip or location a tag stands for. Malformed, unknown and another tenant's tags all answer the same 404. A malformed or repeated `held` answers 400 before the tag is looked up.
- Container tags (SPOOL-191): every leaf carries a tag; a container carries one only when you choose to tag it, and that tag is a row in the tag registry only (the `location` table is unchanged). You give a container a tag with the claim API below. A container tag answers `kind: "container"` (a leaf tag keeps `kind: "location"`) with the container as `location`, plus `inside` (every leaf below it, in tree order, with used, capacity and free) and `suggestion`: the best leaf inside for the held clip, ranked by the intake order (leaves already holding another clip of the same filament, then clip storage whose manufacturer preference matches, then most free; `reason` says which). The held clip's state limits the candidates: a clip on a spool (`on_spool`) is suggested only active storage, and a `free` or `spool_empty` clip only clip storage, so a container with neither answers `suggestion: null`. A manufacturer preference counts on clip storage only, and boxed stock never makes a leaf "the same filament": only clipped spools do. It is never a full leaf, a leaf without a capacity, a slot or the place the clip is already in, and it is only a suggestion: nothing moves until you move the clip. A held clip that sits in a slot gets no suggestion (`suggestion` is null), because a move out of a slot is refused (the load workflow unloads it). `held_clip_used` is false when no `held` was given or the clip is not one of yours, and the ranking is then most free first. `GET /api/v1/placement-suggestions` uses the same ranking, without a clip, so its order is unchanged; each suggestion now carries `reason`.
- `POST /api/v1/tags/{id}/claim` with `{"location_id": "<place>", "replace"?: true}` (write scope, SPOOL-191): gives a place a tag that already exists. While signed in, tap or scan the tag; if it carries a tag ID of this scheme (12 characters, see above), the ID can be assigned to a leaf, or to a container if you choose to tag one. Tags that carry another system's payload never reach this route and cannot be claimed. A leaf's tag is written to its `tag_id` and the tag registry follows; a container's tag is a registry row only, and then resolves as the container view above. Refusals: a malformed ID or body answers 400. An unknown place, or another tenant's place, answers 404. An ID already on a clip or a place of yours answers 409 `tag_in_use`, which never says which one. A place that already has a different tag answers 409 `location_has_tag` until `replace` is true. A place whose tag changed between the check and the write answers 409 `conflict` and stores nothing. Replacing is one atomic statement, and the old ID is released. The same ID in another tenant does not block the claim and is never shown. Tag IDs starting with the reserved demo prefixes (`DEM0`, `DEM1`) answer 400 like any invalid ID and cannot be claimed. Rate limited like the tag lookup. Without signing in, a claimed tag and an unknown tag look exactly the same; signed in, an unclaimed ID is the usual 404 of your own tenant. The claim screen and its non-NFC equivalent come with the tap page UI.
- `GET /api/v1/locations/{id}/clips`: clips stored at a place (for choosing a clip without NFC).
- `POST /api/v1/clips/{id}/move` with `{"to": "<location id>", "confirm": true|false}`: moves one clip to a place that holds units and records a `move` event, atomically. Past a hard limit it answers 409 `needs_confirmation` until `confirm` is true; a soft limit and an unset capacity go through. A place that changed between the check and the write answers 409 `conflict` and stores nothing. Slots are loaded and unloaded by the load workflow (SPOOL-84), so a move into or out of one answers 422. Which places suit a clip's state is also left to those workflows: the move API does not check it (only the container tag's suggestion does).

Failed sign-ins are rate limited per connecting address (10 a minute); after that even the right token is refused until the window ends. Behind a reverse proxy every caller shares the proxy's address, so run it only on a trusted network until a trusted-proxy setting exists.

### The tag page and moving a clip by tapping (development preview)

Opening a tag link shows what the tag stands for. First visit: paste the development token once; it is traded for a session cookie and forgotten by the page. A clip tag shows the filament, its state and where it is now, with **Move this clip** (held for ten minutes). A place tag shows used and free, lists the clips there, and offers **Move <held clip> here** when one is held. Every move ends on an on-screen **Move here** tap; past a hard limit the page warns and asks again with **Move anyway**. A soft limit goes through.

Without NFC the same move is on the main page (**Move a clip**): pick the place the clip is in, tap the clip, pick the destination. Unknown, malformed and other-instance tags all show the same neutral message.

For a phone demo: `pnpm demo:fill`, start the server with `SPOOLSPOT_INSTANCE_CODE=<6 characters>`, then `pnpm demo:links http://<your-ip>:8787` prints links for three tagged places and two clips. `pnpm demo:remove` clears the demo items and their tags.

## Filament catalog and boxed stock (development preview)

The catalog is the list of filaments you can pick from. `pnpm catalog:import [file]` imports one (default `seed/catalog-sample.json`, a sample format until the Filament Clip Studio contract defines `catalog.json`; nothing in the studio is assumed). It is validated against `schema/catalog.schema.json` first and written in one atomic batch. It only adds: a filament that is already there is never overwritten (your reorder level stays yours), and a new id for a manufacturer, type and color that already exist is refused. Importing twice changes nothing.

Boxed stock is a count per filament, place and pack (`spool` or `refill`). Counts change one tap at a time.

- `GET /api/v1/filaments`: the catalog, for choosing by tapping.
- `GET /api/v1/locations/{id}/stock`: every stock line at a place (zero counts included).
- `GET /api/v1/filaments/{id}/stock`: where a filament is held (counts above zero).
- `POST /api/v1/stock/adjust` with `{"filament_id", "location_id", "pack": "spool"|"refill", "delta": 1|-1, "confirm"?}`: +1 creates the line on the first tap. Refused with 422: below zero, a refill pack for a disposable filament, a container, a loaded slot, over 10000. Past a hard limit it answers 409 `needs_confirmation` until `confirm` is true; a soft limit goes through with a notice. A write that another request got to first answers 409 `conflict` and stores nothing. Unknown ids and another tenant's ids answer 404.

Stock counts do not write events yet: intake and the other workflows that log events arrive with SPOOL-84.

### Boxed stock on the page (development preview)

The main page has a **Boxed stock** section. Pick a place (shelves and drawers; loaded slots are left out) to see what is boxed there; tap **+** or **−** to change a count. To add a filament to the place, choose manufacturer, type and color from the imported catalog and a pack; **Refill pack** is offered only for refillable filaments. Past a hard limit the page warns and asks again with **Add anyway**. **Where is it?** lists the places that hold a chosen filament. Nothing is typed.

For a phone demo use a throwaway database so it can be deleted afterwards: `SPOOLSPOT_DB=data/demo.db pnpm db:migrate && pnpm seed:import && pnpm catalog:import`, then start the server with the same `SPOOLSPOT_DB`. Delete `data/demo.db` when done.
