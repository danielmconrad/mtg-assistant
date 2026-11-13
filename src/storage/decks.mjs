// A person's decks, stored as JSON valid against schemas/deck.schema.json. Every query filters on
// userId, which callers take from the verified token, never from tool arguments.
import { validateDeck } from '../core/deck.mjs';

export async function listDecks(db, userId) {
  const { results } = await db
    .prepare('SELECT slug, name, format, status, updated_at FROM decks WHERE user_id = ? ORDER BY slug')
    .bind(userId)
    .all();
  return results;
}

// The deck, validated, or null when this user has no deck with that slug.
export async function loadDeck(db, userId, slug) {
  const row = await db.prepare('SELECT doc FROM decks WHERE user_id = ? AND slug = ?').bind(userId, slug).first();
  return row ? validateDeck(JSON.parse(row.doc), slug) : null;
}

export async function loadAllDecks(db, userId) {
  const { results } = await db
    .prepare('SELECT slug, doc FROM decks WHERE user_id = ? ORDER BY slug')
    .bind(userId)
    .all();
  return results.map(({ slug, doc }) => ({ slug, deck: validateDeck(JSON.parse(doc), slug) }));
}

// The deck with the time it was last saved, which saveDeck checks to refuse a stale write.
export async function loadDeckForUpdate(db, userId, slug) {
  const row = await db
    .prepare('SELECT doc, updated_at FROM decks WHERE user_id = ? AND slug = ?')
    .bind(userId, slug)
    .first();
  return row ? { deck: validateDeck(JSON.parse(row.doc), slug), updatedAt: row.updated_at } : null;
}

// Adds a deck; false when this user already has one with that slug.
export async function insertDeck(db, userId, slug, deck, now) {
  const at = new Date(now).toISOString();
  const { meta } = await db
    .prepare(
      `INSERT INTO decks (id, user_id, slug, name, format, status, doc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, slug) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      slug,
      deck.name,
      deck.format,
      deck.status,
      JSON.stringify(validateDeck(deck, slug)),
      at,
      at,
    )
    .run();
  return meta.changes === 1;
}

// Saves a deck only if it hasn't been saved since it was read (updatedAt from loadDeckForUpdate), so
// two edits at once can't silently overwrite each other. Returns false when it has.
export async function saveDeck(db, userId, slug, deck, { updatedAt, now }) {
  // A save in the same millisecond as the last must still change updated_at.
  const at = new Date(Math.max(now, Date.parse(updatedAt) + 1)).toISOString();
  const { meta } = await db
    .prepare(
      `UPDATE decks SET name = ?, format = ?, status = ?, doc = ?, updated_at = ?
       WHERE user_id = ? AND slug = ? AND updated_at = ?`,
    )
    .bind(deck.name, deck.format, deck.status, JSON.stringify(validateDeck(deck, slug)), at, userId, slug, updatedAt)
    .run();
  return meta.changes === 1;
}
