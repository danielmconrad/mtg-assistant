// /download: a person's collections as files, from a signed link get_download_link made. The link alone
// isn't enough: Cloudflare Access guards the route, and the Access identity must be the link's user. The
// file is built when the link is opened; nothing is stored or served publicly.
import { verifyAccess } from './auth/access.mjs';
import { logAuthEvent } from './auth/users.mjs';
import { errorPage } from './http.mjs';
import { LinkKeyMissing, useLink, verifyLink } from './links.mjs';
import { collectionsForExport } from './storage/collections.mjs';
import { zipFiles } from './zip.mjs';

export const DOWNLOAD_PURPOSE = 'download';
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
// Browsers and link previews may fetch a link before the person does, so it works a few times.
export const MAX_DOWNLOAD_USES = 3;
export const DOWNLOAD_FORMATS = ['manabox_csv', 'moxfield_csv', 'text'];
// The collection value that downloads every collection, as a zip or (combine) as one file.
export const ALL_COLLECTIONS = 'all';

// ManaBox's export columns in its order. Columns a migrated file had beyond these follow them.
const MANABOX_COLUMNS = [
  'Binder Name',
  'Binder Type',
  'Name',
  'Set code',
  'Set name',
  'Collector number',
  'Foil',
  'Rarity',
  'Quantity',
  'ManaBox ID',
  'Scryfall ID',
  'Purchase price',
  'Misprint',
  'Altered',
  'Condition',
  'Language',
  'Purchase price currency',
  'Proxy',
];
const MOXFIELD_FINISHES = { foil: 'foil', etched: 'etched' };
const TEXT_FINISHES = { foil: ' *F*', etched: ' *E*' };
const EXTENSIONS = { manabox_csv: 'csv', moxfield_csv: 'csv', text: 'txt' };
const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8', zip: 'application/zip' };

const isPriceColumn = (column) => /purchase price/i.test(column);

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csv = (columns, records) =>
  `${[columns, ...records.map((record) => columns.map((column) => record[column]))]
    .map((cells) => cells.map(csvCell).join(','))
    .join('\n')}\n`;

// A ManaBox CSV that mtg-manager's parseCollection reads back. Rows with no printing can't be written
// as ManaBox rows, so they're left out and counted. A combined file names each row's collection as its
// binder, unless the row came from a ManaBox binder of its own.
function manaboxCsv(entries, { prices }) {
  const records = entries
    .filter((entry) => entry.scryfall_id)
    .map((entry) => ({
      ...(entry.binder ? { 'Binder Name': entry.binder } : {}),
      ...JSON.parse(entry.source_record ?? '{}'),
      'Binder Type': entry.in_deck_binder ? 'deck' : 'binder',
      Name: entry.name,
      'Set code': (entry.set_code ?? '').toUpperCase(),
      'Collector number': entry.collector_number ?? '',
      Foil: entry.finish,
      Quantity: entry.quantity,
      'Scryfall ID': entry.scryfall_id,
      Proxy: entry.is_proxy ? 'true' : 'false',
    }));
  const present = new Set(records.flatMap((record) => Object.keys(record)));
  const columns = [
    ...MANABOX_COLUMNS.filter((column) => present.has(column)),
    ...[...present].filter((column) => !MANABOX_COLUMNS.includes(column)),
  ].filter((column) => prices || !isPriceColumn(column));
  return { text: csv(columns, records), leftOut: entries.length - records.length };
}

// Moxfield's collection import. Condition and language don't map cleanly from ManaBox's values, so
// they're only in the ManaBox format.
function moxfieldCsv(entries, { prices }) {
  const columns = ['Count', 'Name', 'Edition', 'Collector Number', 'Foil', 'Proxy'];
  if (prices) columns.push('Purchase Price');
  const records = entries.map((entry) => ({
    Count: entry.quantity,
    Name: entry.name,
    Edition: (entry.set_code ?? '').toLowerCase(),
    'Collector Number': entry.collector_number ?? '',
    Foil: MOXFIELD_FINISHES[entry.finish] ?? '',
    Proxy: entry.is_proxy ? 'True' : 'False',
    'Purchase Price': JSON.parse(entry.source_record ?? '{}')['Purchase price'] ?? '',
  }));
  return { text: csv(columns, records), leftOut: 0 };
}

// The text list mtg-manager's parseTextCollection reads: QUANTITY NAME (SET) NUMBER *F*.
function textList(entries) {
  const lines = entries.map((entry) => {
    const printing = entry.set_code ? ` (${entry.set_code.toUpperCase()}) ${entry.collector_number}` : '';
    return `${entry.quantity} ${entry.name}${printing}${TEXT_FINISHES[entry.finish] ?? ''}`;
  });
  return { text: `${lines.join('\n')}\n`, leftOut: 0 };
}

export function collectionFile(entries, format, { prices = false } = {}) {
  if (format === 'manabox_csv') return manaboxCsv(entries, { prices });
  if (format === 'moxfield_csv') return moxfieldCsv(entries, { prices });
  return textList(entries);
}

// A collection name (binders/Alphabetized) as a safe path inside the zip, or as one file name.
const safeSegment = (segment) => segment.replace(/[^A-Za-z0-9 ._-]/g, '_').replace(/^\.+/, '_') || '_';
const zipPath = (name) => name.split('/').filter(Boolean).map(safeSegment).join('/');
const fileName = (name) => safeSegment(name.replace(/\//g, '-'));

// The file for a link's claims: one collection, every collection in one file (combine), or every
// collection zipped with a manifest. Returns null when a named collection no longer exists.
export async function buildDownload(db, claims, now) {
  const extension = EXTENSIONS[claims.format];
  const all = claims.collection === ALL_COLLECTIONS;
  const collections = await collectionsForExport(db, claims.user, all ? undefined : [claims.collection]);
  const date = new Date(now);
  if (all && claims.combine) {
    const entries = collections.flatMap((collection) =>
      collection.entries.map((entry) => ({ ...entry, binder: collection.name })),
    );
    const { text } = collectionFile(entries, claims.format, { prices: claims.prices });
    return {
      body: text,
      name: `mtg-collections-${date.toISOString().slice(0, 10)}.${extension}`,
      type: CONTENT_TYPES[extension],
    };
  }
  if (!all) {
    if (!collections.length) return null;
    const [collection] = collections;
    const { text } = collectionFile(collection.entries, claims.format, { prices: claims.prices });
    return { body: text, name: `${fileName(collection.name)}.${extension}`, type: CONTENT_TYPES[extension] };
  }
  const files = [];
  const manifest = [];
  const used = new Set();
  for (const collection of collections) {
    const { text, leftOut } = collectionFile(collection.entries, claims.format, { prices: claims.prices });
    let path = `${zipPath(collection.name)}.${extension}`;
    for (let n = 2; used.has(path); n += 1) path = `${zipPath(collection.name)}-${n}.${extension}`;
    used.add(path);
    files.push({ path, text });
    manifest.push({
      name: collection.name,
      file: path,
      protected: collection.protected === 1,
      rows: collection.entries.length,
      copies: collection.entries.reduce((sum, entry) => sum + entry.quantity, 0),
      rows_left_out: leftOut,
    });
  }
  files.push({
    path: 'manifest.json',
    text: `${JSON.stringify({ generated_at: date.toISOString(), format: claims.format, include_prices: claims.prices, collections: manifest }, null, 2)}\n`,
  });
  return {
    body: await zipFiles(files, date),
    name: `mtg-collections-${date.toISOString().slice(0, 10)}.zip`,
    type: CONTENT_TYPES.zip,
  };
}

const refused = () => errorPage(403, 'This download link is invalid, expired or used up. Ask Claude for a new one.');

export async function handleDownload(request, env, config) {
  const now = Date.now();
  const refuse = async (reason, email = null) => {
    await logAuthEvent(env.DB, request, 'download_refused', { email, detail: { reason } });
    return refused();
  };
  const access = await verifyAccess(request, config);
  if (!access.email) return refuse(access.problem);
  let verified;
  try {
    verified = await verifyLink(
      env.DOWNLOAD_SIGNING_KEY,
      DOWNLOAD_PURPOSE,
      new URL(request.url).searchParams.get('token'),
      now,
    );
  } catch (error) {
    if (!(error instanceof LinkKeyMissing)) throw error;
    return errorPage(503, 'Downloads are not set up on this server yet.');
  }
  if (verified.problem) return refuse(verified.problem, access.email);
  const { claims } = verified;
  const user = await env.DB.prepare('SELECT id, email, disabled, pending FROM users WHERE id = ?')
    .bind(claims.user)
    .first();
  // The person opening the link must be the person it was made for.
  if (!user || user.disabled || user.pending || user.email !== access.email) {
    return refuse('signed-in person is not the link’s user', access.email);
  }
  if (!(await useLink(env.DB, claims, MAX_DOWNLOAD_USES, now))) return refuse('used up', access.email);
  const file = await buildDownload(env.DB, claims, now);
  if (!file) return refuse('collection no longer exists', access.email);
  await logAuthEvent(env.DB, request, 'download_served', {
    email: access.email,
    detail: {
      format: claims.format,
      all: claims.collection === ALL_COLLECTIONS,
      combine: Boolean(claims.combine),
      prices: claims.prices,
    },
  });
  return new Response(file.body, {
    headers: {
      'Content-Type': file.type,
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
