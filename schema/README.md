# schema

JSON Schemas (draft 2020-12) for SpoolSpot data. CC0-1.0.

- `locations-seed.schema.json` validates `seed/locations-seed.json`, including the capacity and tag rules; `app/src/seed/validate.ts` adds the referential checks (parents, cycles, duplicates).
- `location`, `filament`, `stock-line`, `clip` and `event` describe the records the API and the export carry. A document never contains the tenant: the tenant is the caller's, and the database adds it to every row. The tests keep each schema's properties identical to its table's columns (minus the tenant).
- No schema has a weight, temperature, cost or per-print usage property. The tests enforce this.
