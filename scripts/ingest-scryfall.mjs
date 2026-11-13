// Loads every card on Scryfall into D1, writing only what changed since the last run.
//
//   node scripts/ingest-scryfall.mjs --local            # the local dev database (mise run ingest:local)
//   node scripts/ingest-scryfall.mjs --remote           # production; the nightly GitHub Action runs this
//   ... --dry-run                                       # download, diff and write SQL, but apply nothing
//   ... --allow-mass-delete                             # see MAX_DELETE_SHARE
//
// 1. Streams Scryfall's two bulk files (about 107 MB gzipped), the same ones mtg-manager used: Oracle
//    Cards marks each card's default printing, Default Cards has every printing.
// 2. Reads the hash of every row already in D1 and diffs against it, so an unchanged card, printing or
//    price is never rewritten (D1 bills per row written).
// 3. Writes the changes as SQL files and applies them with `wrangler d1 execute --file`.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toCard } from '../src/core/scryfall.mjs';
import { buildRows, diffRows } from './ingest/rows.mjs';
import { TABLES, chunkStatements, ingestStatements, literal } from './ingest/sql.mjs';

const DATABASE = 'mtg-assistant';
const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const HEADERS = {
  'User-Agent': 'mtg-assistant/0.1 (+https://github.com/danielmconrad/mtg-assistant)',
  Accept: 'application/json',
};
const RETRY_PAUSES_MS = [2_000, 5_000, 15_000];
const HASH_PAGE = 20_000;
// A run that would delete more than this share of a table's rows stops instead: a sign of a bad
// download, not of Scryfall really removing that many cards.
export const MAX_DELETE_SHARE = 0.02;

const log = (message) => console.log(message);

async function fetchWithRetries(url, init) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      if (attempt === RETRY_PAUSES_MS.length) return response;
    } catch (error) {
      if (attempt === RETRY_PAUSES_MS.length) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSES_MS[attempt]));
  }
}

// Splits a stream of text chunks into non-empty lines.
export async function* textLines(chunks) {
  let buffer = '';
  for await (const chunk of chunks) {
    const lines = (buffer + chunk).split('\n');
    buffer = lines.pop();
    yield* lines.filter((line) => line.trim());
  }
  if (buffer.trim()) yield buffer;
}

// Streams one bulk file (gzipped JSON Lines, a card per line) through onCard; returns its build time.
async function readBulkFile(type, onCard) {
  const listing = await fetchWithRetries(`${BULK_DATA_URL}/${type}`, { headers: HEADERS });
  if (!listing.ok) throw new Error(`Scryfall bulk-data listing returned HTTP ${listing.status}`);
  const { jsonl_download_uri: uri, updated_at: updatedAt } = await listing.json();
  if (!uri || Number.isNaN(Date.parse(updatedAt))) throw new Error('Unexpected Scryfall bulk-data listing');
  const download = await fetchWithRetries(uri, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
  if (!download.ok) throw new Error(`Scryfall bulk download returned HTTP ${download.status}`);
  const builtAt = new Date(updatedAt).toISOString();
  const text = download.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());
  let read = 0;
  for await (const line of textLines(text)) {
    onCard(JSON.parse(line), builtAt);
    read += 1;
    if (read % 25_000 === 0) log(`  ${type}: ${read} read`);
  }
  if (!read) throw new Error(`Scryfall bulk file ${type} was empty`);
  log(`  ${type}: ${read} read, built ${builtAt}`);
  return builtAt;
}

async function downloadPrintings() {
  const printings = [];
  await readBulkFile('oracle_cards', (object, at) => printings.push(toCard(object, at, { defaultPrinting: true })));
  const builtAt = await readBulkFile('default_cards', (object, at) => printings.push(toCard(object, at)));
  return { printings, builtAt };
}

function wrangler(args) {
  return execFileSync('wrangler', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// { key: hash } for every row of a table, read a page at a time.
async function currentHashes(table, target) {
  const { key } = TABLES[table];
  const hashes = new Map();
  let after = '';
  for (;;) {
    const sql = `SELECT ${key} AS k, hash AS h FROM ${table} WHERE ${key} > ${literal(after)} ORDER BY ${key} LIMIT ${HASH_PAGE}`;
    const output = wrangler(['d1', 'execute', DATABASE, target, '--json', '--command', sql]);
    const rows = JSON.parse(output)[0]?.results ?? [];
    for (const row of rows) hashes.set(row.k, row.h);
    if (rows.length < HASH_PAGE) return hashes;
    after = rows.at(-1).k;
  }
}

// Refuses a diff that would delete a suspicious share of any table.
export function checkDeletes(diff, current, allowMassDelete = false) {
  if (allowMassDelete) return;
  for (const [table, { deletes }] of Object.entries(diff)) {
    const existing = current[table].size;
    if (existing && deletes.length / existing > MAX_DELETE_SHARE) {
      throw new Error(
        `Refusing to delete ${deletes.length} of ${existing} ${table} rows; check the download, or re-run with --allow-mass-delete`,
      );
    }
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const targets = ['--local', '--remote'].filter((flag) => args.has(flag));
  if (targets.length !== 1) throw new Error('Choose one of --local or --remote');
  const [target] = targets;

  log('Downloading Scryfall bulk data');
  const { printings, builtAt } = await downloadPrintings();
  const rows = await buildRows(printings);
  log(`Built ${rows.cards.length} cards, ${rows.printings.length} printings`);

  log(`Reading current hashes (${target.slice(2)})`);
  const current = {};
  for (const table of Object.keys(TABLES)) current[table] = await currentHashes(table, target);
  const diff = {
    cards: diffRows(rows.cards, TABLES.cards.key, current.cards),
    printings: diffRows(rows.printings, TABLES.printings.key, current.printings),
    prices: diffRows(rows.prices, TABLES.prices.key, current.prices),
  };
  for (const [table, { upserts, deletes }] of Object.entries(diff)) {
    log(`  ${table}: ${upserts.length} to write, ${deletes.length} to delete`);
  }
  checkDeletes(diff, current, args.has('--allow-mass-delete'));

  const meta = {
    bulk_built_at: builtAt,
    ingested_at: new Date().toISOString(),
    card_count: rows.cards.length,
    printing_count: rows.printings.length,
    formats: JSON.stringify(rows.formats),
  };
  const files = chunkStatements(ingestStatements(diff, meta));
  const directory = await mkdtemp(join(tmpdir(), 'mtg-ingest-'));
  const paths = [];
  for (const [index, sql] of files.entries()) {
    const path = join(directory, `ingest-${String(index + 1).padStart(3, '0')}.sql`);
    await writeFile(path, sql);
    paths.push(path);
  }
  log(`Wrote ${paths.length} SQL file(s) to ${directory}`);
  if (args.has('--dry-run')) return log('Dry run: nothing applied');

  for (const path of paths) {
    log(`Applying ${path}`);
    wrangler(['d1', 'execute', DATABASE, target, '--yes', '--file', path]);
  }
  log('Ingest complete');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Ingest failed: ${error.message}`);
    process.exitCode = 1;
  });
}
