# app

The SpoolSpot application (TypeScript, Hono, SQLite; see the decisions index).

- `src/` server, data layer, migrations runner and seed importer; `migrations/` numbered SQL files.
- `public/` the static pages served by the Node entry point and scanned by the accessibility check.

Development: `pnpm db:migrate`, `pnpm seed:import`, `pnpm dev` (set `SPOOLSPOT_DEV_TOKEN`).
