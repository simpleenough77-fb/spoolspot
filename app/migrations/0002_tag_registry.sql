-- SPDX-License-Identifier: AGPL-3.0-or-later
-- One tag registry per tenant (SPOOL-177, ADR-0001). A tag ID can exist once per tenant across every
-- record type: the primary key (tenant_id, tag_id) is what refuses a second use, so a location and a
-- clip can never carry the same ID. The registry is kept in step by triggers, so the existing columns
-- and every writer keep working, and the resolver reads one table. Tag IDs are random and carry no
-- personal data; they are unique per tenant, not globally.
--
-- Rules for writers: the registry follows INSERT, UPDATE and DELETE. Do not use INSERT OR REPLACE or
-- REPLACE INTO on location or clip: SQLite does not run the delete triggers for the row it replaces,
-- so the old registry row would be left behind (a test scans the source for it).
--
-- If this migration stops with "UNIQUE constraint failed: tag.tenant_id, tag.tag_id", the same tag ID
-- is on a location and a clip (or two tenants' rows were merged by hand). Find them with:
--   SELECT l.tenant_id, l.tag_id FROM location l JOIN clip c
--     ON c.tenant_id = l.tenant_id AND c.tag_id = l.tag_id;
-- then give one of the two records a new tag and run the migration again. The runner applies the file
-- in one transaction, so a failed run changes nothing.
CREATE TABLE tag (
  tenant_id TEXT NOT NULL REFERENCES tenant_settings (tenant_id),
  tag_id TEXT NOT NULL CHECK (
    length(tag_id) = 12 AND tag_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('location', 'clip')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 64),
  PRIMARY KEY (tenant_id, tag_id),
  -- A record carries at most one tag.
  UNIQUE (tenant_id, kind, target_id),
  CHECK (instr(CAST(tag_id AS BLOB), x'00') = 0 AND instr(CAST(target_id AS BLOB), x'00') = 0)
) STRICT;

-- Existing tags move over. Within one tenant the old per-table unique indexes already hold, and the
-- location and clip lists are disjoint only if no ID is shared: a shared ID would make this fail and
-- roll the migration back, which is the right outcome for data that breaks the rule.
INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  SELECT tenant_id, tag_id, 'location', id FROM location WHERE tag_id IS NOT NULL;
INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  SELECT tenant_id, tag_id, 'clip', id FROM clip;

CREATE TRIGGER location_tag_insert
AFTER INSERT ON location
WHEN NEW.tag_id IS NOT NULL
BEGIN
  INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  VALUES (NEW.tenant_id, NEW.tag_id, 'location', NEW.id);
END;

CREATE TRIGGER location_tag_update
AFTER UPDATE OF tenant_id, id, tag_id ON location
WHEN OLD.tenant_id IS NOT NEW.tenant_id OR OLD.id IS NOT NEW.id OR OLD.tag_id IS NOT NEW.tag_id
BEGIN
  DELETE FROM tag
   WHERE tenant_id = OLD.tenant_id AND kind = 'location' AND target_id = OLD.id;
  INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  SELECT NEW.tenant_id, NEW.tag_id, 'location', NEW.id WHERE NEW.tag_id IS NOT NULL;
END;

CREATE TRIGGER location_tag_delete
AFTER DELETE ON location
BEGIN
  DELETE FROM tag
   WHERE tenant_id = OLD.tenant_id AND kind = 'location' AND target_id = OLD.id;
END;

CREATE TRIGGER clip_tag_insert
AFTER INSERT ON clip
BEGIN
  INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  VALUES (NEW.tenant_id, NEW.tag_id, 'clip', NEW.id);
END;

CREATE TRIGGER clip_tag_update
AFTER UPDATE OF tenant_id, id, tag_id ON clip
WHEN OLD.tenant_id IS NOT NEW.tenant_id OR OLD.id IS NOT NEW.id OR OLD.tag_id IS NOT NEW.tag_id
BEGIN
  DELETE FROM tag
   WHERE tenant_id = OLD.tenant_id AND kind = 'clip' AND target_id = OLD.id;
  INSERT INTO tag (tenant_id, tag_id, kind, target_id)
  VALUES (NEW.tenant_id, NEW.tag_id, 'clip', NEW.id);
END;

CREATE TRIGGER clip_tag_delete
AFTER DELETE ON clip
BEGIN
  DELETE FROM tag
   WHERE tenant_id = OLD.tenant_id AND kind = 'clip' AND target_id = OLD.id;
END;
