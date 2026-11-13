# Binders overhaul

Terminology mirrors Moxfield, Archidekt and ManaBox:

- **Collection**: every card a person owns. Not stored; it's the union of their binders.
- **Binder**: a named set of cards with a `protected` flag, and a kind: `binder` or `deck` (a deck's physical cards).
- **Deck**: unchanged (`decks` table, `schemas/deck.schema.json`). A built deck's `collection_destination` is its
  deck binder.

Decisions (2026-11-13):

- Hold-back is per binder: only copies in protected binders are held. mtg-manager's "a card in any deck binder
  holds every copy" rule (`holdDeckCards`) stops applying on the server; the core function and its tests stay.
- ManaBox deck binders (Binder Type `deck`) import as protected binders of kind `deck`, linked to a Deck with
  the same name when one exists. No Decks are created.
- ManaBox lists (Binder Type `list`) are skipped on import and reported.
- Replacing the whole collection makes the file the collection: binders in it are replaced, binders missing
  from it are removed, new ones created. Built decks' binders are refused if their cards would change; the
  preview names them.

## PR 1: binders as the model

- Migration 0010 (additive): `collections.kind TEXT NOT NULL DEFAULT 'binder'`. Backfill `deck` for binders
  that are a deck's `collection_destination`. Split each `manabox_csv` collection by its rows' `Binder Name`
  into one row per binder (Brad: "all cards" plus 7 deck binders, which become protected `deck` binders);
  positions renumbered per binder. Paths stay `collections/<name>.<ext>`, so `collection_source` globs
  (`collections/*`, `collections/**`) keep matching. The SQL table keeps its name; only code and tools change.
- `loadCollections`: protection from the flag only; drop the `holdDeckCards` split.
- Binder names: display names up to 60 printable characters (ManaBox has "Turtle Power!"); paths derived.
- Tools: `collection_summary` shows the collection's totals and each binder (kind, protected, copies).
  `add_cards` and `remove_cards` take `binder`. New `update_binder`: rename, protect or unprotect, delete an
  empty binder. `get_download_link` takes a binder, or the whole collection.
- Tests: migration on Brad-shaped data, isolation rows, per-binder hold-back.

## PR 2: imports (binder, deck, collection; merge or replace)

- Collection (upload page, `get_upload_link kind: collection`): ManaBox CSV split by binder per the decisions
  above. Preview lists binders created, replaced and removed, cards changed, decks affected.
- Binder (`import_binder` for pasted text; upload page for files): text list or CSV into one binder, merge or
  replace, created if new.
- Deck (`import_deck`): Archidekt URL or pasted list; `mode: new` (default), `merge` or `replace` into an
  existing draft. Built decks refused (their cards change through `swap_deck`).
- Moxfield and Archidekt collection CSVs: added once there are real sample exports to match (Moxfield:
  Count, Name, Edition, Collector Number, Foil, ...; Archidekt: user-chosen columns, Tags as binders).

## PR 3: draft_deck

- `create_deck` becomes `draft_deck`. Server instructions, playbooks, README, isolation table.

## PR 4: review of tools and playbooks

- Every tool: name, title, description, schema descriptions, annotations, errors, output shape, overlap.
- Every playbook (`src/mcp/workflows/`): matches the tools as they now are, terminology, steps.
- Publish findings, then fix in a follow-up PR.
