-- An upload fills one binder (target binder, named by collection_name) or replaces or merges the whole
-- collection from a ManaBox export (target collection, one binder per ManaBox binder). base_revisions is
-- every touched binder's revision at preview, as JSON ({ "name": "revision" }, null for a binder the upload
-- creates), so applying refuses if any of them changed.
ALTER TABLE uploads ADD COLUMN target TEXT NOT NULL DEFAULT 'binder' CHECK (target IN ('binder', 'collection'));
ALTER TABLE uploads ADD COLUMN base_revisions TEXT;
