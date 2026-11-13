// The pure half of scripts/migrate-from-mtg-manager.mjs: rewriting deck patterns, the SQL for a
// migration, and checking what the server reads back. No Node built-ins, so the workerd tests can run a
// full migrate-and-read-back round trip against D1.
import { parse } from 'csv-parse/sync';
import { loadCollections } from '../../src/storage/collections.mjs';
import { loadAllDecks } from '../../src/storage/decks.mjs';
import { insertStatements, literal } from '../ingest/sql.mjs';

const PROTECTED_FOLDERS = new Set(['precons', 'decks', 'protected']);
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

export const isProtectedPath = (path) =>
  path
    .split('/')
    .slice(0, -1)
    .some((folder) => PROTECTED_FOLDERS.has(folder));

// A collection path or pattern from deck.yaml, without the owner's folder. On the server each person
// has their own collections/ tree, so collections/brad/**/* becomes collections/**/*, matched against
// collection paths stored the same way (collections/binders/Alphabetized.txt). Patterns naming another
// owner's collections can't apply there.
export function relativePattern(pattern, owner) {
  const glob = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  const own = `collections/${owner}`;
  if (glob === own) return { pattern: 'collections' };
  if (glob.startsWith(`${own}/`)) return { pattern: `collections/${glob.slice(own.length + 1)}` };
  const [, first, ...rest] = glob.split('/');
  // collections/**/x: ** spans the owner's folder and any below it, so it stays.
  if (glob.startsWith('collections/') && first === '**') return { pattern: glob };
  // collections/*/x or collections/c*/x: a one-segment glob stands for the owner's folder.
  if (glob.startsWith('collections/') && /[*?[]/.test(first ?? '')) {
    return { pattern: ['collections', ...rest].join('/') };
  }
  return { problem: `${pattern} names collections outside collections/${owner}/` };
}

export function relativeDeck(deck, owner, slug) {
  const problems = [];
  const relativeList = (patterns) =>
    patterns.flatMap((pattern) => {
      const result = relativePattern(pattern, owner);
      if (result.problem) problems.push(`${slug}: ${result.problem}`);
      return result.pattern ? [result.pattern] : [];
    });
  const converted = { ...deck };
  if (deck.collection_source) converted.collection_source = relativeList(deck.collection_source);
  if (deck.collection_destination) {
    const [pattern] = relativeList([deck.collection_destination]);
    if (pattern) converted.collection_destination = pattern;
  }
  return { deck: converted, problems };
}

// ManaBox's other columns for each CSV row, by position, so exports can give them back.
export function sourceRecords(text) {
  const records = parse(text, { bom: true, skip_empty_lines: true, columns: true });
  return records.map((record) =>
    JSON.stringify(Object.fromEntries(Object.entries(record).filter(([column]) => !PARSED_COLUMNS.has(column)))),
  );
}

// Replaces each ? outside a quoted string with the next value as a literal.
export function inlineParams(sql, params) {
  let index = 0;
  let quoted = false;
  let out = '';
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    if (char === '?' && !quoted) {
      if (index >= params.length) throw new Error('Too few parameters for the statement');
      out += literal(params[index]);
      index += 1;
    } else {
      out += char;
    }
  }
  if (index !== params.length) throw new Error('Too many parameters for the statement');
  return out;
}

export function migrationStatements(people, now) {
  const statements = [];
  for (const person of people) {
    if (!person.existing) {
      statements.push(
        ...insertStatements(
          'users',
          ['id', 'email', 'google_sub', 'pending', 'created_at', 'last_login_at'],
          [
            {
              id: person.userId,
              email: person.email,
              google_sub: `pending:${person.userId}`,
              pending: 1,
              created_at: now,
              last_login_at: now,
            },
          ],
        ),
      );
    }
    for (const table of ['collection_entries', 'collections', 'decks']) {
      statements.push(`DELETE FROM ${table} WHERE user_id = ${literal(person.userId)};`);
    }
    const collectionRows = person.collections.map((collection) => ({ ...collection, id: crypto.randomUUID() }));
    statements.push(
      ...insertStatements(
        'collections',
        ['id', 'user_id', 'name', 'path', 'format', 'protected', 'created_at', 'updated_at'],
        collectionRows.map((collection) => ({
          ...collection,
          user_id: person.userId,
          protected: collection.isProtected ? 1 : 0,
          created_at: now,
          updated_at: now,
        })),
      ),
      ...insertStatements(
        'collection_entries',
        [
          'user_id',
          'collection_id',
          'position',
          'name',
          'quantity',
          'scryfall_id',
          'set_code',
          'collector_number',
          'finish',
          'is_proxy',
          'in_deck_binder',
          'source_record',
        ],
        collectionRows.flatMap((collection) =>
          collection.rows.map((row) => ({
            user_id: person.userId,
            collection_id: collection.id,
            position: row.position,
            name: row.name,
            quantity: row.quantity,
            scryfall_id: row.scryfallId ?? null,
            set_code: row.set ?? null,
            collector_number: row.collectorNumber ?? null,
            finish: row.finish,
            is_proxy: row.isProxy ? 1 : 0,
            in_deck_binder: row.inDeckBinder ? 1 : 0,
            source_record: collection.records[row.position] ?? null,
          })),
        ),
      ),
      ...insertStatements(
        'decks',
        ['id', 'user_id', 'slug', 'name', 'format', 'status', 'doc', 'created_at', 'updated_at'],
        person.decks.map(({ slug, deck }) => ({
          id: crypto.randomUUID(),
          user_id: person.userId,
          slug,
          name: deck.name,
          format: deck.format,
          status: deck.status,
          doc: JSON.stringify(deck),
          created_at: now,
          updated_at: now,
        })),
      ),
    );
  }
  return statements;
}

// What the server reads back, in the shape compared against what was written.
// Rows compared field by field: keys sorted, and the text-list location (derived from the position)
// left out.
const canonical = ({ location: _location, ...row }) =>
  JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1))));
const comparable = (rows) => rows.map(canonical).sort();

export async function verify(db, people) {
  const problems = [];
  for (const person of people) {
    const loaded = await loadCollections(db, person.userId);
    for (const collection of person.collections) {
      const source = loaded.sources.find((candidate) => candidate.name === collection.name);
      const expected = comparable(collection.rows.map((row) => ({ ...row, collection: collection.name })));
      if (!source) problems.push(`${person.folder}/${collection.name}: missing`);
      else if (JSON.stringify(comparable(source.rows)) !== JSON.stringify(expected)) {
        problems.push(`${person.folder}/${collection.name}: rows differ`);
      } else if (source.isProtected !== collection.isProtected) {
        problems.push(`${person.folder}/${collection.name}: protection differs`);
      }
    }
    const decks = await loadAllDecks(db, person.userId);
    for (const { slug, deck } of person.decks) {
      const found = decks.find((candidate) => candidate.slug === slug);
      if (!found || JSON.stringify(found.deck) !== JSON.stringify(deck)) {
        problems.push(`${person.folder} deck ${slug}: differs`);
      }
    }
  }
  return problems;
}
