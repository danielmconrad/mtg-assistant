// A person's collections, read from D1 into the model mtg-manager's workspace built from files
// ({ sources, available, protected, availableNames, ... }), so src/core runs unchanged. Every query
// filters on userId, which callers take from the verified token, never from tool arguments.
import { holdDeckCards } from '../core/collection.mjs';
import { pathMatches } from '../core/glob.mjs';

// One stored row as mtg-manager's collection row.
function toRow(entry, collection) {
  return {
    name: entry.name,
    quantity: entry.quantity,
    ...(entry.scryfall_id ? { scryfallId: entry.scryfall_id } : {}),
    ...(entry.set_code ? { set: entry.set_code, collectorNumber: entry.collector_number } : {}),
    finish: entry.finish,
    isProxy: entry.is_proxy === 1,
    inDeckBinder: entry.in_deck_binder === 1,
    ...(collection.format === 'text' ? { location: `${collection.name}: line ${entry.position + 1}` } : {}),
    position: entry.position,
    collection: collection.name,
  };
}

export async function listCollections(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT c.id, c.name, c.path, c.format, c.protected, c.updated_at,
              COUNT(e.id) AS row_count, COALESCE(SUM(e.quantity), 0) AS copies,
              COALESCE(SUM(CASE WHEN e.scryfall_id IS NULL THEN 1 ELSE 0 END), 0) AS unresolved_rows
       FROM collections c LEFT JOIN collection_entries e ON e.collection_id = c.id AND e.user_id = c.user_id
       WHERE c.user_id = ?
       GROUP BY c.id ORDER BY c.name`,
    )
    .bind(userId)
    .all();
  return results;
}

async function entriesOf(db, userId, collectionIds) {
  const byCollection = new Map(collectionIds.map((id) => [id, []]));
  if (!collectionIds.length) return byCollection;
  const { results } = await db
    .prepare('SELECT * FROM collection_entries WHERE user_id = ? ORDER BY collection_id, position')
    .bind(userId)
    .all();
  for (const entry of results) byCollection.get(entry.collection_id)?.push(entry);
  return byCollection;
}

// The collections a request reads, as mtg-manager's loadCollections returned them. only holds path
// patterns (a deck's collection_source), matched as mtg-manager matched them; own is a built deck's
// collection_destination, always read and never protected.
export async function loadCollections(db, userId, { only = [], own } = {}) {
  const all = await listCollections(db, userId);
  const isOwn = (collection) => own !== undefined && (collection.path === own || collection.name === own);
  const selected = all.filter(
    (collection) => isOwn(collection) || !only.length || only.some((pattern) => pathMatches(collection.path, pattern)),
  );
  const entries = await entriesOf(
    db,
    userId,
    selected.map((collection) => collection.id),
  );
  const sources = selected.map((collection) => ({
    name: collection.name,
    path: collection.path,
    isProtected: collection.protected === 1 && !isOwn(collection),
    rows: entries.get(collection.id).map((entry) => toRow(entry, collection)),
  }));
  const split = sources.map((source) => {
    if (source.isProtected) return { free: [], held: source.rows };
    const { free, held } = holdDeckCards(source.rows);
    return { free, held: held.map((row) => ({ ...row, collection: `${source.name} decks` })) };
  });
  const matchesNothing = (pattern) => !all.some((collection) => pathMatches(collection.path, pattern));
  return {
    sources,
    available: split.flatMap(({ free }) => free),
    protected: split.flatMap(({ held }) => held),
    availableNames: sources.filter((source) => !source.isProtected).map((source) => source.name),
    unknownProtected: [],
    unknownOnly: only.filter(matchesNothing),
    missingOwn: own !== undefined && !all.some(isOwn) ? own : undefined,
  };
}

// Every Scryfall ID a set of collections names, for loading their cards.
export const printingIdsOf = (collections) => [
  ...new Set(collections.sources.flatMap((source) => source.rows.map((row) => row.scryfallId)).filter(Boolean)),
];
