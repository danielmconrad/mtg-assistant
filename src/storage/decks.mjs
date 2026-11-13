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
