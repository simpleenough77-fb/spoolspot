// SPDX-License-Identifier: AGPL-3.0-or-later
// Usage: node scripts/demo-links.ts <base-url>   e.g. http://192.168.4.27:8787
// Prints the tag links for the demo items (run "pnpm demo:fill" first). Needs SPOOLSPOT_INSTANCE_CODE.
import { loadConfig } from '../app/src/config.ts';
import { openDatabase } from '../app/src/db/sqlite.ts';

const base = process.argv[2];
const config = loadConfig(process.env);
if (!base || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(base)) {
  console.error('Usage: node scripts/demo-links.ts http://<host>[:port]');
  process.exit(2);
}
if (!config.instanceCode) {
  console.error(
    'Set SPOOLSPOT_INSTANCE_CODE (6 characters) first, the same value the server uses.',
  );
  process.exit(2);
}
const db = openDatabase(config.databasePath);
try {
  const places = db
    .prepare(
      "SELECT name, tag_id FROM location WHERE tenant_id = ? AND tag_id LIKE 'DEM1%' ORDER BY tag_id",
    )
    .all(config.tenantId) as { name: string; tag_id: string }[];
  const clips = db
    .prepare(
      "SELECT c.tag_id FROM clip c JOIN filament f ON f.tenant_id = c.tenant_id AND f.id = c.filament_id WHERE c.tenant_id = ? AND c.tag_id LIKE 'DEM0%' ORDER BY c.tag_id LIMIT 2",
    )
    .all(config.tenantId) as { tag_id: string }[];
  if (places.length === 0) {
    console.error('No demo tags found. Run "pnpm demo:fill" first.');
    process.exit(1);
  }
  for (const p of places)
    console.log(`Place  ${p.name}: ${base}/${config.instanceCode}${p.tag_id}`);
  for (const c of clips)
    console.log(`Clip   (a demo clip): ${base}/${config.instanceCode}${c.tag_id}`);
} finally {
  db.close();
}
