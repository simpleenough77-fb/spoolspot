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
