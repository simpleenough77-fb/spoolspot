-- SPDX-License-Identifier: AGPL-3.0-or-later
-- SPOOL-201, owner decisions 2026-11-12: a tag ID that stops being the tag of its place or clip is
-- retired for good in its tenant, and a leaf that becomes a container keeps its tag.
--
-- 1. Retired IDs. tag_retired holds, per tenant, every tag ID that has left the registry. The rule is
-- kept on the registry itself, so it covers every writer: the 0002 and 0005 triggers on location and
-- clip, the claim path (which writes the registry directly for containers) and any direct write.
--   * A registry row deleted retires its ID: a leaf's tag_id cleared or changed, a clip's tag_id
--     changed, a location or clip deleted (its tag may still exist in the world), a tenant_id change
--     of a location or clip (retired in the old tenant), and a direct DELETE on tag.
--   * A registry row whose tag_id or tenant_id changes retires the old ID in the old tenant: replacing
--     a container's tag through the claim path, or a direct UPDATE on tag.
--   * A retired ID is refused on every way into the registry (INSERT, and UPDATE of tag_id or
--     tenant_id), so it can never be claimed for a place or container, set on a leaf, or given to a
--     clip again in that tenant. Writes to location.tag_id and clip.tag_id reach the registry through
--     the 0002/0005 triggers, so they are refused the same way and the whole statement rolls back.
--   * Following the place (owner decision D3) is not retiring: a move changes no tag, a rename
--     re-points the registry row (below), and the ID stays in use by the same record.
--   * Exempt: the fixed public demo IDs (DEM0 or DEM1 followed by eight digits; app/src/seed/demo.ts).
--     The claim path never accepts them for a real record (isReservedTagId), and demo removal followed
--     by a fresh fill must be able to put them back, so they are never retired.
--   * Per tenant, like the registry: tag IDs are unique per tenant (0001 and 0002), not globally, so
--     another tenant could always hold the same ID, and a tenant's retired IDs neither block nor show
--     in any other tenant. Every statement below is bound to the row's own tenant.
--   * A retired row is never changed, and is removed only once its tenant holds no place, clip or
--     registry row: that is tenant deletion (app/src/data/tenant-delete.ts), which removes everything
--     of the tenant. A tenant recreated under the same id afterwards starts with no retired IDs.
--
-- 2. A leaf that becomes a container keeps its tag (owner decision D4). 0001 makes a container's
-- tag_id NULL, so the change clears the column; until now 0002's trigger (kept by 0005) then dropped
-- the registry row and freed the ID. location_tag_update is recreated below, same name, so that the
-- row stays as the container's registry-only tag. The ID is not retired: the same place still has it.
--
-- What changed in location_tag_update (0005's body otherwise; same name, columns and WHEN):
--   * The re-point now keeps the place's registry row, re-pointed to NEW.id, whenever the tenant is
--     unchanged and either the row already holds NEW.tag_id (a leaf renamed with its tag, or a leaf
--     left out of step by an older database whose registry-only tag is claimed into its column), or
--     tag_id is NULL before and after (0005's case), or the leaf becomes a container (D4).
--   * The delete removes the row only when it was not kept. In 0005 it ran unconditionally after the
--     re-point (safe there because 0005 re-pointed only on an id change); here the id may be unchanged.
--   * The insert adds a row from NEW.tag_id only when the kept row does not already hold it. In 0002 a
--     leaf rename deleted and re-inserted the same ID; with retirement that would retire it and then
--     refuse it, so the row is re-pointed instead. The end state is the same as before.
-- clip_tag_update (0002) is recreated the same way: a clip whose id changes keeps its registry row
-- re-pointed (no application path changes a clip's id); a tag_id change or a tenant change drops the
-- old row, which retires the old ID, and adds the new one. Its end state is as in 0002.
-- Each recreated trigger keeps every statement in one body, so the order is explicit and does not
-- depend on which of several triggers SQLite runs first. The insert, delete and refusal triggers of
-- 0002 on location and clip are unchanged.
--
-- Conflict clauses. A trigger body inherits the outer statement's OR IGNORE / OR REPLACE clause for
-- constraint conflicts, but RAISE(ABORT) is not a constraint conflict: under either clause a retired ID
-- is still refused and the statement rolls back. The retiring inserts below cannot meet a constraint
-- (the ID came from the registry with the same CHECK, and an existing retired row is skipped by NOT
-- EXISTS), so OR IGNORE cannot skip them either. OR IGNORE can still skip 0005's re-point on a rename
-- (0005 says renames with it are not supported); here the row is then deleted and its ID retired, not
-- freed. Not covered: a REPLACE write (the REPLACE statement or the OR REPLACE clause) on location,
-- clip or tag removes the conflicting row without running delete triggers while recursive_triggers is
-- off (the SQLite default), so that row's ID is neither retired nor kept. The SQL adapter refuses every
-- REPLACE write (SPOOL-199), and a database-level guard is separate work (SPOOL-206).
--
-- Existing data: additive only. No existing row is changed or deleted; tag_retired starts empty. IDs
-- dropped before this migration ran are unknown (nothing recorded them) and cannot be retired
-- retroactively; they stay free. Tagged places, containers and leaves left out of step by an older
-- database keep their rows and are handled by the triggers from now on.
-- Do not edit this file after it has been applied anywhere: add a new numbered migration.

CREATE TABLE tag_retired (
  tenant_id TEXT NOT NULL REFERENCES tenant_settings (tenant_id),
  tag_id TEXT NOT NULL CHECK (
    length(tag_id) = 12 AND tag_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  PRIMARY KEY (tenant_id, tag_id),
  CHECK (instr(CAST(tag_id AS BLOB), x'00') = 0)
) STRICT;

-- 1a. A retired ID never enters the registry again, in its own tenant.
CREATE TRIGGER tag_retired_refused_insert
BEFORE INSERT ON tag
BEGIN
  SELECT RAISE(ABORT, 'tag id retired')
  WHERE EXISTS (
    SELECT 1 FROM tag_retired r WHERE r.tenant_id = NEW.tenant_id AND r.tag_id = NEW.tag_id
  );
END;

CREATE TRIGGER tag_retired_refused_update
BEFORE UPDATE OF tenant_id, tag_id ON tag
BEGIN
  SELECT RAISE(ABORT, 'tag id retired')
  WHERE EXISTS (
    SELECT 1 FROM tag_retired r WHERE r.tenant_id = NEW.tenant_id AND r.tag_id = NEW.tag_id
  );
END;

-- 1b. An ID that leaves the registry is retired in the tenant it left.
CREATE TRIGGER tag_retire_on_delete
AFTER DELETE ON tag
WHEN OLD.tag_id NOT GLOB 'DEM[01][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  INSERT INTO tag_retired (tenant_id, tag_id)
  SELECT OLD.tenant_id, OLD.tag_id
   WHERE NOT EXISTS (
     SELECT 1 FROM tag_retired r WHERE r.tenant_id = OLD.tenant_id AND r.tag_id = OLD.tag_id
   );
END;

CREATE TRIGGER tag_retire_on_update
AFTER UPDATE OF tenant_id, tag_id ON tag
WHEN (OLD.tenant_id IS NOT NEW.tenant_id OR OLD.tag_id IS NOT NEW.tag_id)
  AND OLD.tag_id NOT GLOB 'DEM[01][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
BEGIN
  INSERT INTO tag_retired (tenant_id, tag_id)
  SELECT OLD.tenant_id, OLD.tag_id
   WHERE NOT EXISTS (
     SELECT 1 FROM tag_retired r WHERE r.tenant_id = OLD.tenant_id AND r.tag_id = OLD.tag_id
   );
END;

-- 1c. A retired row is never changed, and goes only with its whole tenant.
CREATE TRIGGER tag_retired_is_not_updated
BEFORE UPDATE ON tag_retired
BEGIN
  SELECT RAISE(ABORT, 'retired tag ids cannot be changed');
END;

CREATE TRIGGER tag_retired_kept_while_tenant_has_data
BEFORE DELETE ON tag_retired
BEGIN
  SELECT RAISE(ABORT, 'retired tag ids are removed only with their tenant')
  WHERE EXISTS (SELECT 1 FROM location l WHERE l.tenant_id = OLD.tenant_id)
     OR EXISTS (SELECT 1 FROM clip k WHERE k.tenant_id = OLD.tenant_id)
     OR EXISTS (SELECT 1 FROM tag t WHERE t.tenant_id = OLD.tenant_id);
END;

-- 2. The registry follows the place (0005's trigger, same name; changes listed above).
DROP TRIGGER location_tag_update;

CREATE TRIGGER location_tag_update
AFTER UPDATE OF tenant_id, id, tag_id ON location
WHEN OLD.tenant_id IS NOT NEW.tenant_id OR OLD.id IS NOT NEW.id OR OLD.tag_id IS NOT NEW.tag_id
BEGIN
  UPDATE tag SET target_id = NEW.id
   WHERE tenant_id = OLD.tenant_id AND kind = 'location' AND target_id = OLD.id
     AND OLD.tenant_id IS NEW.tenant_id
     AND (tag_id IS NEW.tag_id
          OR (NEW.tag_id IS NULL AND (OLD.tag_id IS NULL OR (OLD.leaf = 1 AND NEW.leaf = 0))));
  DELETE FROM tag
   WHERE tenant_id = OLD.tenant_id AND kind = 'location' AND target_id = OLD.id
     AND NOT (
       OLD.tenant_id IS NEW.tenant_id
       AND (tag_id IS NEW.tag_id
            OR (NEW.tag_id IS NULL AND (OLD.tag_id IS NULL OR (OLD.leaf = 1 AND NEW.leaf = 0))))
     );
  INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  SELECT NEW.tenant_id, NEW.tag_id, 'location', NEW.id
   WHERE NEW.tag_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM tag t
        WHERE t.tenant_id = NEW.tenant_id AND t.kind = 'location' AND t.target_id = NEW.id
          AND t.tag_id = NEW.tag_id
     );
END;

DROP TRIGGER clip_tag_update;

CREATE TRIGGER clip_tag_update
AFTER UPDATE OF tenant_id, id, tag_id ON clip
WHEN OLD.tenant_id IS NOT NEW.tenant_id OR OLD.id IS NOT NEW.id OR OLD.tag_id IS NOT NEW.tag_id
BEGIN
  UPDATE tag SET target_id = NEW.id
   WHERE tenant_id = OLD.tenant_id AND kind = 'clip' AND target_id = OLD.id
     AND OLD.tenant_id IS NEW.tenant_id AND tag_id IS NEW.tag_id;
  DELETE FROM tag
   WHERE tenant_id = OLD.tenant_id AND kind = 'clip' AND target_id = OLD.id
     AND NOT (OLD.tenant_id IS NEW.tenant_id AND tag_id IS NEW.tag_id);
  INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  SELECT NEW.tenant_id, NEW.tag_id, 'clip', NEW.id
   WHERE NOT EXISTS (
     SELECT 1 FROM tag t
      WHERE t.tenant_id = NEW.tenant_id AND t.kind = 'clip' AND t.target_id = NEW.id
        AND t.tag_id = NEW.tag_id
   );
END;
