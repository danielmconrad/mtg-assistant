// Writes an ingest's changes as SQL statements for `wrangler d1 execute --file`. Values come from
// Scryfall, so every one goes through literal(); nothing else builds SQL from data. D1 refuses
// statements over 100 KB and explicit transactions, so inserts are batched under a byte budget and no
// BEGIN/COMMIT is emitted. Web APIs only, so the workerd tests can load it too.

export const MAX_STATEMENT_BYTES = 90_000;

export const TABLES = {
  cards: {
    key: 'oracle_id',
    columns: [
      'oracle_id',
      'name',
      'name_key',
      'front_name',
      'front_name_key',
      'mana_cost',
      'mana_value',
      'type_line',
      'front_type',
      'oracle_text',
      'keywords',
      'color_identity',
      'produced_mana',
      'legalities',
      'legal_commander',
      'playable',
      'game_changer',
      'edhrec_rank',
      'hash',
    ],
  },
  printings: {
    key: 'id',
    columns: [
      'id',
      'oracle_id',
      'name',
      'set_code',
      'collector_number',
      'rarity',
      'border_color',
      'set_type',
      'flavor_name',
      'is_default',
      'overrides',
      'printing_legalities',
      'hash',
    ],
  },
  prices: { key: 'printing_id', columns: ['printing_id', 'usd', 'usd_foil', 'usd_etched', 'eur', 'hash'] },
  commander_pool: {
    key: 'oracle_id',
    columns: ['oracle_id', 'identity', 'themes', 'tribes', 'is_land', 'can_command', 'hash'],
  },
};

const bytes = (text) => new TextEncoder().encode(text).length;

// A SQL literal for a string, number, boolean or null. Anything else, and strings holding NUL, are refused.
export function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Refusing non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\0')) throw new Error('Refusing a string with a NUL character');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new Error(`Refusing a ${typeof value} value`);
}

// Groups items into statements of at most MAX_STATEMENT_BYTES: head + parts joined by ", " + tail.
function batched(items, toPart, head, tail = '') {
  const statements = [];
  let parts = [];
  let size = bytes(head) + bytes(tail);
  for (const item of items) {
    const part = toPart(item);
    const partSize = bytes(part) + 2;
    if (bytes(head) + bytes(tail) + partSize > MAX_STATEMENT_BYTES) {
      throw new Error('A single row is over the statement limit');
    }
    if (parts.length && size + partSize > MAX_STATEMENT_BYTES) {
      statements.push(`${head}${parts.join(', ')}${tail};`);
      parts = [];
      size = bytes(head) + bytes(tail);
    }
    parts.push(part);
    size += partSize;
  }
  if (parts.length) statements.push(`${head}${parts.join(', ')}${tail};`);
  return statements;
}

// Plain multi-row INSERTs for any table and columns, batched under the statement limit.
export const insertStatements = (table, columns, rows, tail = '') =>
  batched(
    rows,
    (row) => `(${columns.map((column) => literal(row[column])).join(', ')})`,
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES `,
    tail,
  );

export function upsertStatements(table, rows) {
  const { key, columns } = TABLES[table];
  const updates = columns.filter((column) => column !== key).map((column) => `${column} = excluded.${column}`);
  return insertStatements(table, columns, rows, ` ON CONFLICT (${key}) DO UPDATE SET ${updates.join(', ')}`);
}

export function deleteStatements(table, keys) {
  const { key } = TABLES[table];
  return batched(keys, literal, `DELETE FROM ${table} WHERE ${key} IN (`, ')');
}

// cards_fts rows share their card's rowid, so they're found through cards: delete before a card row
// goes, and (re)insert after it's written. An upsert keeps an existing card's rowid.
export const ftsDeleteStatements = (oracleIds) =>
  batched(
    oracleIds,
    literal,
    'DELETE FROM cards_fts WHERE rowid IN (SELECT rowid FROM cards WHERE oracle_id IN (',
    '))',
  );

export const ftsInsertStatements = (oracleIds) =>
  batched(
    oracleIds,
    literal,
    'INSERT INTO cards_fts (rowid, name, type_line, oracle_text) SELECT rowid, name, type_line, oracle_text FROM cards WHERE oracle_id IN (',
    ')',
  );

export function metaStatements(meta) {
  const entries = Object.entries(meta).map(([key, value]) => ({ key, value: String(value) }));
  return batched(
    entries,
    (entry) => `(${literal(entry.key)}, ${literal(entry.value)})`,
    'INSERT INTO card_data_meta (key, value) VALUES ',
    ' ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  );
}

// Every statement for one ingest, in a safe order: removed cards leave the search index before their
// rows go, written cards are re-indexed after they're written, and meta is written last.
export function ingestStatements(diff, meta) {
  const written = diff.cards.upserts.map((row) => row.oracle_id);
  return [
    ...ftsDeleteStatements(diff.cards.deletes),
    ...deleteStatements('cards', diff.cards.deletes),
    ...deleteStatements('printings', diff.printings.deletes),
    ...deleteStatements('prices', diff.prices.deletes),
    ...upsertStatements('cards', diff.cards.upserts),
    ...ftsDeleteStatements(written),
    ...ftsInsertStatements(written),
    ...upsertStatements('printings', diff.printings.upserts),
    ...upsertStatements('prices', diff.prices.upserts),
    ...deleteStatements('commander_pool', diff.commander_pool.deletes),
    ...upsertStatements('commander_pool', diff.commander_pool.upserts),
    ...metaStatements(meta),
  ];
}

// Splits statements into files of at most maxBytes each.
export function chunkStatements(statements, maxBytes = 20_000_000) {
  const files = [];
  let current = [];
  let size = 0;
  for (const statement of statements) {
    const statementSize = bytes(statement) + 1;
    if (current.length && size + statementSize > maxBytes) {
      files.push(`${current.join('\n')}\n`);
      current = [];
      size = 0;
    }
    current.push(statement);
    size += statementSize;
  }
  if (current.length) files.push(`${current.join('\n')}\n`);
  return files;
}
