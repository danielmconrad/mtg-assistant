// Changing a person's collections: adding and removing copies, creating text collections, and the
// event log collection_changes reads. A change is planned from the rows as read, then written as one D1
// batch that applies only if every collection it touches is still at the revision it was read at.
// Every statement filters on userId, which callers take from the verified token.
import { parse } from 'csv-parse/sync';
import { isProtectedPath } from './collections.mjs';

// The ManaBox columns parseCollection already turns into row fields; the rest are kept as JSON.
const PARSED_COLUMNS = new Set([
  'Name',
  'Quantity',
  'Scryfall ID',
  'Set code',
  'Collector number',
  'Foil',
  'Proxy',
  'Binder Type',
]);

// ManaBox's other columns for each CSV row, by position, so exports can give them back.
export function sourceRecords(text) {
  const records = parse(text, { bom: true, skip_empty_lines: true, columns: true });
  return records.map((record) =>
    JSON.stringify(Object.fromEntries(Object.entries(record).filter(([column]) => !PARSED_COLUMNS.has(column)))),
  );
}

// A collection name the server may create: folders and a name of letters, digits, spaces, dots,
// underscores and hyphens, as mtg-manager's files were named (binders/Alphabetized).
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
export const isValidCollectionName = (name) =>
  name.length <= 120 && name.split('/').every((segment) => NAME_SEGMENT.test(segment) && !segment.endsWith('.'));

const EXTENSIONS = { text: 'txt', manabox_csv: 'csv' };

// A collection to create, as a text list unless format says ManaBox CSV (an uploaded export).
export function newTextCollection(name, now, format = 'text') {
  const path = `collections/${name}.${EXTENSIONS[format]}`;
  const at = new Date(now).toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    path,
    format,
    protected: isProtectedPath(path) ? 1 : 0,
    created_at: at,
    updated_at: at,
    revision: null,
    isNew: true,
  };
}

// A collection's stored rows in order, each with its card's oracle ID, for planning a change.
export async function entriesFor(db, userId, collectionId) {
  const { results } = await db
    .prepare(
      `SELECT e.*, p.oracle_id FROM collection_entries e LEFT JOIN printings p ON p.id = e.scryfall_id
       WHERE e.user_id = ? AND e.collection_id = ? ORDER BY e.position`,
    )
    .bind(userId, collectionId)
    .all();
  return results;
}

// A row that more copies of the same printing and finish can join: a plain row (not a proxy or in a
// deck binder) with the same printing given the same way. Proxies and deck-binder copies (from an
// uploaded ManaBox export) get rows of their own.
const joins = (entry, copy) =>
  entry.scryfall_id === copy.scryfallId &&
  entry.finish === copy.finish &&
  !entry.is_proxy &&
  !entry.in_deck_binder &&
  !copy.isProxy &&
  !copy.inDeckBinder &&
  (entry.set_code === null) === (copy.set === undefined);

// The row changes that add copies ([{ name, scryfallId, set?, collectorNumber?, finish, quantity,
// isProxy?, inDeckBinder?, sourceRecord? }]) to a collection whose rows are entries: more copies on a
// matching row, or new rows at the end.
export function planAdd(entries, copies) {
  const updates = new Map();
  const inserts = [];
  let next = entries.reduce((last, entry) => Math.max(last, entry.position), -1) + 1;
  for (const copy of copies) {
    const entry = entries.find((candidate) => joins(candidate, copy));
    if (entry) {
      updates.set(entry.id, (updates.get(entry.id) ?? entry.quantity) + copy.quantity);
      continue;
    }
    const pending = inserts.find((candidate) => joins(candidate, copy));
    if (pending) pending.quantity += copy.quantity;
    else {
      inserts.push({
        position: next,
        name: copy.name,
        quantity: copy.quantity,
        scryfall_id: copy.scryfallId,
        set_code: copy.set ?? null,
        collector_number: copy.collectorNumber ?? null,
        finish: copy.finish,
        is_proxy: copy.isProxy ? 1 : 0,
        in_deck_binder: copy.inDeckBinder ? 1 : 0,
        source_record: copy.sourceRecord ?? null,
      });
      next += 1;
    }
  }
  return { updates, inserts, deletes: [] };
}

// The row changes that take copies out: takes is [{ entry, quantity }], each from one row. A row left
// with none is deleted.
export function planRemove(takes) {
  const left = new Map();
  for (const { entry, quantity } of takes) left.set(entry.id, (left.get(entry.id) ?? entry.quantity) - quantity);
  const updates = new Map([...left].filter(([, quantity]) => quantity > 0));
  const deletes = [...left].filter(([, quantity]) => quantity <= 0).map(([id]) => id);
  return { updates, inserts: [], deletes };
}

// The row changes for a collection that both loses copies (takes: [{ entry, quantity }]) and gains them
// (copies, as planAdd takes them), as a physical-deck move may do to one binder. Copies taken first, so
// returned copies can join the rows they left.
export function planChange(entries, { takes = [], copies = [] }) {
  const taken = new Map();
  for (const { entry, quantity } of takes) taken.set(entry.id, (taken.get(entry.id) ?? 0) + quantity);
  const left = entries.map((entry) => ({ ...entry, quantity: entry.quantity - (taken.get(entry.id) ?? 0) }));
  if (left.some((entry) => entry.quantity < 0)) throw new Error('A move takes more copies than a row holds');
  const kept = left.filter((entry) => entry.quantity > 0);
  const added = planAdd(kept, copies);
  const updates = new Map(kept.filter((entry) => taken.has(entry.id)).map((entry) => [entry.id, entry.quantity]));
  for (const [id, quantity] of added.updates) updates.set(id, quantity);
  return {
    updates,
    inserts: added.inserts,
    deletes: left.filter((entry) => entry.quantity <= 0).map((entry) => entry.id),
  };
}

const collectionGuard = (db, userId, collection, revision, at) =>
  collection.isNew
    ? db
        .prepare(
          `INSERT INTO collections (id, user_id, name, path, format, protected, created_at, updated_at, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, name) DO NOTHING`,
        )
        .bind(
          collection.id,
          userId,
          collection.name,
          collection.path,
          collection.format,
          collection.protected,
          at,
          at,
          revision,
        )
    : db
        .prepare(
          `UPDATE collections SET revision = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND COALESCE(revision, '') = ?`,
        )
        .bind(revision, at, collection.id, userId, collection.revision ?? '');

// Rows go to D1 as JSON arrays read with json_each, a chunk per statement, so an upload of thousands of
// rows stays within D1's limits on bound parameters and queries per request.
const CHUNK_ROWS = 500;
const chunks = (items) =>
  Array.from({ length: Math.ceil(items.length / CHUNK_ROWS) }, (_, at) =>
    JSON.stringify(items.slice(at * CHUNK_ROWS, (at + 1) * CHUNK_ROWS)),
  );
const field = (name) => `json_extract(j.value, '$.${name}')`;

// The statements for one collection's row changes and events, each applying only when applies holds.
function rowStatements(db, userId, { collection, plan, events }, { applies, guard, revision, at, source, note }) {
  const updates = [...plan.updates].map(([id, quantity]) => ({ id, quantity }));
  return [
    ...chunks(updates).map((json) =>
      db
        .prepare(
          `UPDATE collection_entries
           SET quantity = (SELECT ${field('quantity')} FROM json_each(?1) j WHERE ${field('id')} = collection_entries.id)
           WHERE user_id = ?2 AND id IN (SELECT ${field('id')} FROM json_each(?1) j) AND ${applies}`,
        )
        .bind(json, userId, ...guard),
    ),
    ...chunks(plan.deletes).map((json) =>
      db
        .prepare(
          `DELETE FROM collection_entries WHERE user_id = ?2 AND id IN (SELECT value FROM json_each(?1)) AND ${applies}`,
        )
        .bind(json, userId, ...guard),
    ),
    ...chunks(plan.inserts).map((json) =>
      db
        .prepare(
          `INSERT INTO collection_entries (user_id, collection_id, position, name, quantity, scryfall_id, set_code,
             collector_number, finish, is_proxy, in_deck_binder, source_record)
           SELECT ?2, ?3, ${['position', 'name', 'quantity', 'scryfall_id', 'set_code', 'collector_number', 'finish', 'is_proxy', 'in_deck_binder', 'source_record'].map(field).join(', ')}
           FROM json_each(?1) j WHERE ${applies}`,
        )
        .bind(json, userId, collection.id, ...guard),
    ),
    ...chunks(
      events.map((event) => ({ ...event, scryfallId: event.scryfallId ?? null, finish: event.finish ?? null })),
    ).map((json) =>
      db
        .prepare(
          `INSERT INTO collection_events (user_id, batch_id, at, source, collection_name, name, scryfall_id, finish,
             change, note)
           SELECT ?2, ?3, ?4, ?5, ?6, ${['name', 'scryfallId', 'finish', 'change'].map(field).join(', ')}, ?7
           FROM json_each(?1) j WHERE ${applies}`,
        )
        .bind(json, userId, revision, at, source, collection.name, note, ...guard),
    ),
  ];
}

// Writes planned changes as one batch. changes is [{ collection, plan, events, remove?, format? }], where
// events are [{ name, scryfallId, finish, change }], remove deletes the collection once its rows are gone
// (a torn-down deck's own list), and format changes an existing collection's (an upload replacing it). deck, when given ({ slug, updatedAt, doc }), is saved in the same batch.
// Returns false, writing nothing, when any collection or the deck changed since it was read (or a new
// collection's name was taken meanwhile).
export async function applyCollectionChanges(db, userId, changes, { source, note = null, now, deck }) {
  const revision = crypto.randomUUID();
  const at = new Date(now).toISOString();
  // Each guard moves a collection (or the deck) to this change's revision only from the one it was read
  // at, changing nothing else; every other statement applies only when all the guards did.
  const guards = changes.map(({ collection }) => collectionGuard(db, userId, collection, revision, at));
  if (deck) {
    guards.push(
      db
        .prepare('UPDATE decks SET revision = ? WHERE user_id = ? AND slug = ? AND updated_at = ?')
        .bind(revision, userId, deck.slug, deck.updatedAt),
    );
  }
  const applies = `(SELECT COUNT(*) FROM collections WHERE user_id = ? AND revision = ?)
    + (SELECT COUNT(*) FROM decks WHERE user_id = ? AND revision = ?) = ?`;
  const guard = [userId, revision, userId, revision, guards.length];
  const context = { applies, guard, revision, at, source, note };
  const statements = changes.flatMap((change) => rowStatements(db, userId, change, context));
  for (const { collection, format } of changes.filter((change) => change.format && !change.collection.isNew)) {
    statements.push(
      db
        .prepare(`UPDATE collections SET format = ? WHERE id = ? AND user_id = ? AND ${applies}`)
        .bind(format, collection.id, userId, ...guard),
    );
  }
  if (deck) {
    // A save in the same millisecond as the last must still change updated_at.
    const savedAt = new Date(Math.max(now, Date.parse(deck.updatedAt) + 1)).toISOString();
    statements.push(
      db
        .prepare(
          `UPDATE decks SET name = ?, format = ?, status = ?, doc = ?, updated_at = ?
           WHERE user_id = ? AND slug = ? AND ${applies}`,
        )
        .bind(
          deck.doc.name,
          deck.doc.format,
          deck.doc.status,
          JSON.stringify(deck.doc),
          savedAt,
          userId,
          deck.slug,
          ...guard,
        ),
    );
  }
  // Deleting a collection lowers the guard count, so these come last.
  for (const { collection } of changes.filter((change) => change.remove)) {
    statements.push(
      db
        .prepare(`DELETE FROM collections WHERE id = ? AND user_id = ? AND ${applies}`)
        .bind(collection.id, userId, ...guard),
    );
  }
  const results = await db.batch([...guards, ...statements]);
  return results.slice(0, guards.length).every(({ meta }) => meta.changes === 1);
}

// Events since a time (ISO), oldest first, optionally for one collection.
export async function collectionEvents(db, userId, { since, collection }) {
  const { results } = await db
    .prepare(
      `SELECT batch_id, at, source, collection_name, name, change, note FROM collection_events
       WHERE user_id = ? AND at >= ? AND (? IS NULL OR collection_name = ?) ORDER BY id`,
    )
    .bind(userId, since, collection ?? null, collection ?? null)
    .all();
  return results;
}
