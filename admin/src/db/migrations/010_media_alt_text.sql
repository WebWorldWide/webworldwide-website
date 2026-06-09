-- 010_media_alt_text.sql — alt text lives with the asset.
--
-- Markdown remains the source of truth for alt text inside a published
-- post body; this column is the library's default: the editor inserts
-- it when an asset is placed, the media UI edits it, and the backfill
-- script (admin/scripts/backfill-alt-text.js) seeds it from existing
-- post markdown. NULL/empty means "no alt text yet" — the library UI
-- badges images in that state.
ALTER TABLE media ADD COLUMN alt_text TEXT;
