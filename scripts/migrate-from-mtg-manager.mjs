// One-time load of mtg-manager's collections and decks into D1, one owner folder per person.
//
//   node scripts/migrate-from-mtg-manager.mjs --source ../mtg-manager \
//     --owner conrad=daniel.m.conrad@gmail.com --owner brad=bradleysklenar@gmail.com \
//     [--local | --remote] [--apply]
//
// Without --apply it only prints the plan: each person, their account (existing, or reserved for their
// first sign-in), their collections with row and copy counts and whether each is protected, and their
// decks. With --apply it replaces those people's collections and decks with the files' contents, then
// reads everything back through the server's own loaders and compares it with what it wrote.
//
// - Collections: every .csv (ManaBox) and .txt (text list) under collections/<owner>/, each loaded as one
//   binder named by its path inside that folder. (Migration 0010 later split the ManaBox files already
//   loaded into one binder per ManaBox binder; for anyone new, import a ManaBox export on the upload page.) Anything under a folder named precons, decks or protected is protected:
//   reported, never used by decks. Text-list rows are matched to printings in the target's card data,
//   as mtg-manager matched them against its cache.
// - Decks: builds/<owner>/<slug>/deck.yaml, validated against the schema. collection_source and
//   collection_destination paths are rewritten relative to the owner's own collections.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseCollection, parseTextCollection, resolveTextRows, summarize } from '../src/core/collection.mjs';
import { parseDeck } from '../src/core/deck.mjs';
import { cardIndexFor, loadCardRows } from '../src/storage/cards.mjs';
import { chunkStatements } from './ingest/sql.mjs';
import {
  inlineParams,
  isProtectedPath,
  migrationStatements,
  relativeDeck,
  sourceRecords,
  verify,
} from './migrate/plan.mjs';

const DATABASE = 'mtg-assistant';
const COLLECTION_FILE = /\.(csv|txt)$/i;
const WRANGLER_MAX_VALUES = 400;

// ---------------------------------------------------------------------------------------------
// Reading mtg-manager's files
// ---------------------------------------------------------------------------------------------

async function filesUnder(root, folder) {
  const entries = await readdir(join(root, folder), { recursive: true, withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

async function readOwner(root, owner) {
  const collectionFiles = (await filesUnder(root, `collections/${owner}`)).filter((path) => COLLECTION_FILE.test(path));
  const collections = [];
  for (const file of collectionFiles) {
    // Named as mtg-manager named them, inside the owner's folder; the path keeps collections/ so deck
    // patterns (collections/**/*) match it as they matched files.
    const name = file.slice(`collections/${owner}/`.length).replace(COLLECTION_FILE, '');
    const path = `collections/${file.slice(`collections/${owner}/`.length)}`;
    const text = await readFile(join(root, file), 'utf8');
    const isCsv = file.toLowerCase().endsWith('.csv');
    collections.push({
      name,
      path,
      format: isCsv ? 'manabox_csv' : 'text',
      isProtected: isProtectedPath(path),
      rows: isCsv ? parseCollection(text, name) : parseTextCollection(text, name),
      records: isCsv ? sourceRecords(text) : [],
    });
  }
  const deckFiles = (await filesUnder(root, `builds/${owner}`)).filter((path) => path.endsWith('/deck.yaml'));
  const decks = [];
  const problems = [];
  for (const file of deckFiles) {
    const slug = file.split('/').at(-2);
    const result = relativeDeck(parseDeck(await readFile(join(root, file), 'utf8'), file), owner, slug);
    problems.push(...result.problems);
    decks.push({ slug, deck: result.deck });
  }
  return { collections, decks, problems };
}

// ---------------------------------------------------------------------------------------------
// D1 through wrangler, with the same prepare/bind/all/first/run surface the server's code uses
// ---------------------------------------------------------------------------------------------

export function wranglerDb(target) {
  const execute = (sql) => {
    const output = execFileSync('wrangler', ['d1', 'execute', DATABASE, target, '--json', '--command', sql], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return JSON.parse(output)[0];
  };
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: execute(inlineParams(sql, params)).results }),
    first: async () => execute(inlineParams(sql, params)).results[0] ?? null,
    run: async () => ({ meta: execute(inlineParams(sql, params)).meta }),
  });
  return { prepare: (sql) => statement(sql) };
}

// ---------------------------------------------------------------------------------------------
// The plan and its SQL
// ---------------------------------------------------------------------------------------------

async function resolveRows(db, collections) {
  const textRows = collections
    .filter((collection) => collection.format === 'text')
    .flatMap((collection) => collection.rows);
  if (!textRows.length) return collections;
  const rows = await loadCardRows(
    db,
    {
      names: textRows.filter((row) => !row.set).map((row) => row.name),
      printings: textRows
        .filter((row) => row.set)
        .map((row) => ({ set: row.set, collectorNumber: row.collectorNumber })),
    },
    { maxParams: WRANGLER_MAX_VALUES },
  );
  const { index } = await cardIndexFor(db, rows);
  return collections.map((collection) =>
    collection.format === 'text' ? { ...collection, rows: resolveTextRows(collection.rows, index) } : collection,
  );
}

function printPlan(people) {
  for (const person of people) {
    console.log(
      `\n${person.folder} → ${person.email} (${person.existing ? 'existing account' : 'reserved for first sign-in'})`,
    );
    for (const collection of person.collections) {
      const { rowCount, copies } = summarize(collection.rows);
      const unresolved = collection.rows.filter((row) => !row.scryfallId).length;
      const flags = [
        collection.isProtected ? 'protected' : 'available',
        unresolved ? `${unresolved} unresolved` : '',
      ].filter(Boolean);
      console.log(
        `  ${collection.name.padEnd(48)} ${String(rowCount).padStart(5)} rows ${String(copies).padStart(6)} copies  ${flags.join(', ')}`,
      );
    }
    for (const { slug, deck } of person.decks) {
      console.log(`  deck ${slug.padEnd(43)} ${deck.status.padEnd(9)} ${deck.name}`);
    }
    for (const problem of person.problems) console.log(`  ! ${problem}`);
  }
}

const USAGE = 'Usage: --source DIR --owner FOLDER=EMAIL [--owner ...] --local|--remote [--apply]';

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      owner: { type: 'string', multiple: true },
      local: { type: 'boolean' },
      remote: { type: 'boolean' },
      apply: { type: 'boolean' },
    },
  });
  if (!values.source || !values.owner?.length || values.local === values.remote) throw new Error(USAGE);
  const owners = values.owner.map((value) => {
    const [folder, email] = value.split('=');
    if (!folder || !email?.includes('@')) throw new Error('--owner takes FOLDER=EMAIL');
    return { folder, email: email.trim().toLowerCase() };
  });
  return { source: values.source, owners, apply: Boolean(values.apply), target: values.local ? '--local' : '--remote' };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const db = wranglerDb(options.target);
  const people = [];
  for (const { folder, email } of options.owners) {
    const { collections, decks, problems } = await readOwner(options.source, folder);
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    people.push({
      folder,
      email,
      existing: Boolean(existing),
      userId: existing?.id ?? crypto.randomUUID(),
      collections: await resolveRows(db, collections),
      decks,
      problems,
    });
  }
  printPlan(people);
  if (!options.apply) return console.log('\nPlan only. Re-run with --apply to write it.');

  const directory = await mkdtemp(join(tmpdir(), 'mtg-migrate-'));
  const files = chunkStatements(migrationStatements(people, new Date().toISOString()));
  for (const [index, sql] of files.entries()) {
    const path = join(directory, `migrate-${index + 1}.sql`);
    await writeFile(path, sql);
    execFileSync('wrangler', ['d1', 'execute', DATABASE, options.target, '--yes', '--file', path], {
      stdio: 'inherit',
    });
  }
  const problems = await verify(db, people);
  if (problems.length) {
    console.error(`\nVerification failed:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log('\nVerified: every collection, row and deck reads back as written.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
