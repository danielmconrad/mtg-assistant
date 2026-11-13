import { parse } from 'csv-parse/sync';
import { hasName, isBasic, normalizeName } from './card.mjs';

const REQUIRED_HEADERS = ['Name', 'Quantity', 'Scryfall ID', 'Set code', 'Collector number', 'Foil'];
const UUID_PATTERN = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const HEADER_ROWS = 1;

function checkHeaders(headers, source) {
  if (new Set(headers).size !== headers.length) throw new Error(`${source}: duplicate headers`);
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`${source}: missing headers: ${missing.join(', ')}`);
  return headers;
}

function toRow(record, location, position) {
  if (!record.Name.trim()) throw new Error(`${location}: empty card name`);
  if (!POSITIVE_INTEGER.test(record.Quantity) || !Number.isSafeInteger(Number(record.Quantity))) {
    throw new Error(`${location}: Quantity must be a positive integer`);
  }
  if (!UUID_PATTERN.test(record['Scryfall ID'])) throw new Error(`${location}: invalid Scryfall ID`);
  // Binder exports have no Proxy column, and their rows are real cards.
  if (record.Proxy !== undefined && !['true', 'false'].includes(record.Proxy)) {
    throw new Error(`${location}: invalid Proxy flag`);
  }
  if (!record['Set code'] || !record['Collector number'] || !record.Foil) {
    throw new Error(`${location}: incomplete printing information`);
  }
  return {
    name: record.Name.trim(),
    quantity: Number(record.Quantity),
    scryfallId: record['Scryfall ID'].toLowerCase(),
    set: record['Set code'],
    collectorNumber: record['Collector number'],
    finish: record.Foil,
    isProxy: record.Proxy === 'true',
    inDeckBinder: record['Binder Type'] === 'deck',
    position,
  };
}

// Parses a ManaBox CSV export into rows, rejecting anything that would make ownership counts wrong.
// Each row's position is its record's index after the header, which removeCsvCopies relies on.
export function parseCollection(text, source = 'collection') {
  const records = parse(text, {
    bom: true,
    skip_empty_lines: true,
    columns: (headers) => checkHeaders(headers, source),
  });
  if (!records.length) throw new Error(`${source}: no card rows`);
  return records.map((record, index) => toRow(record, `${source}: record ${index + HEADER_ROWS + 1}`, index));
}

// A card line in the plain-text lists Moxfield, Archidekt and MTG Arena export: a quantity (optionally
// with x), the name, optionally the printing as (SET) NUMBER, and *F* for foil or *E* for etched.
// Archidekt's trailing [Category] and ^tag^ annotations are ignored.
const TEXT_LINE = /^(\d+)x?\s+(.+?)(?:\s+\(([a-z\d]+)\)\s+(\S+))?(?:\s+\*([FE])\*)?$/i;
const ANNOTATIONS = /(?:\s+(?:\[[^\]]*\]|\^[^^]*\^))+$/;
// Section headings and comments carry no cards.
const SKIPPED_LINE = /^(?:(?:commander|companion|deck|mainboard|sideboard|maybeboard|considering):?|\/\/.*|#.*)?$/i;
const TEXT_FINISHES = { F: 'foil', E: 'etched' };

// Parses a plain-text list into rows like parseCollection's, without Scryfall IDs: resolveTextRows
// finds each row's printing in the card cache by set and collector number, or by name. Each row's
// position is its line's index, which removeTextCopies relies on.
export function parseTextCollection(text, source = 'collection') {
  const rows = [];
  for (const [index, rawLine] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const line = rawLine.trim().replace(ANNOTATIONS, '');
    if (SKIPPED_LINE.test(line)) continue;
    const location = `${source}: line ${index + 1}`;
    const match = line.match(TEXT_LINE);
    if (!match) throw new Error(`${location}: expected "QUANTITY NAME (SET) NUMBER", got "${rawLine.trim()}"`);
    const [, quantity, name, set, collectorNumber, finish] = match;
    if (!Number.isSafeInteger(Number(quantity)) || Number(quantity) < 1) {
      throw new Error(`${location}: quantity must be a positive integer`);
    }
    rows.push({
      name,
      quantity: Number(quantity),
      ...(set ? { set: set.toLowerCase(), collectorNumber } : {}),
      finish: TEXT_FINISHES[finish?.toUpperCase()] ?? 'normal',
      isProxy: false,
      inDeckBinder: false,
      location,
      position: index,
    });
  }
  if (!rows.length) throw new Error(`${source}: no card lines`);
  return rows;
}

// Moxfield writes split and double-faced names with one slash ("Dusk / Dawn"), and some printings
// carry another name, such as the Turtles' "Aggro Amalgam" for Voracious Hydra.
const namesPrinting = (card, name) =>
  hasName(card, name.replace(/\s+\/\s+/g, ' // ')) ||
  (card.flavorName && normalizeName(card.flavorName) === normalizeName(name));

// Gives text rows the Scryfall ID and name of their cached printing. A row whose printing or name is
// not cached keeps no ID, so it counts as unresolved until scryfall:refresh fetches it. A cached
// printing that doesn't match the row's name is a typo in the list and throws.
export function resolveTextRows(rows, index) {
  return rows.map((row) => {
    if (row.scryfallId) return row;
    if (!row.set) {
      const { card } = index.lookup({ name: row.name });
      if (!card && index.isCached({ name: row.name })) {
        throw new Error(`${row.location}: ${row.name} names more than one card; add (SET) NUMBER`);
      }
      return card ? { ...row, name: card.name, scryfallId: card.id } : row;
    }
    const card = index.printing(row.set, row.collectorNumber);
    if (!card) return row;
    if (!namesPrinting(card, row.name)) {
      const printing = `${row.set.toUpperCase()} ${row.collectorNumber}`;
      throw new Error(`${row.location}: ${printing} is ${card.name}, not ${row.name}`);
    }
    return { ...row, name: card.name, scryfallId: card.id };
  });
}

// Binder exports list built decks as deck binders. A card named in any of them is in use, so every copy
// of it, spares in other binders included, is held back from new decks.
export function holdDeckCards(rows) {
  const inDecks = new Set(rows.filter((row) => row.inDeckBinder).map((row) => row.name));
  return {
    free: rows.filter((row) => !inDecks.has(row.name)),
    held: rows.filter((row) => inDecks.has(row.name)),
  };
}

const sumQuantities = (rows) => rows.reduce((total, row) => total + row.quantity, 0);

export function summarize(rows) {
  return {
    rowCount: rows.length,
    copies: sumQuantities(rows),
    distinctNames: new Set(rows.map((row) => row.name)).size,
    proxyCopies: sumQuantities(rows.filter((row) => row.isProxy)),
  };
}

// Copies per oracle ID, so every printing and finish of a card counts together.
export function ownedCounts(rows, index, { allowProxies = false } = {}) {
  const counts = new Map();
  let unresolvedRows = 0;
  for (const row of rows) {
    if (row.isProxy && !allowProxies) continue;
    const card = index.byId.get(row.scryfallId);
    if (!card) {
      unresolvedRows += 1;
      continue;
    }
    counts.set(card.oracleId, (counts.get(card.oracleId) ?? 0) + row.quantity);
  }
  return { counts, unresolvedRows };
}

// Protected copies per card and collection: oracle ID -> [{ name, copies }], in collection order.
// Rows carry the name of the collection they came from.
export function protectedHoldings(rows, index, { allowProxies = false } = {}) {
  const holdings = new Map();
  for (const row of rows) {
    const card = row.isProxy && !allowProxies ? null : index.byId.get(row.scryfallId);
    if (!card) continue;
    const byCollection = holdings.get(card.oracleId) ?? new Map();
    byCollection.set(row.collection, (byCollection.get(row.collection) ?? 0) + row.quantity);
    holdings.set(card.oracleId, byCollection);
  }
  return new Map(
    [...holdings].map(([oracleId, byCollection]) => [
      oracleId,
      [...byCollection].map(([name, copies]) => ({ name, copies })),
    ]),
  );
}

// e.g. "3 in precons, 1 in Cube".
export const holdingsNote = (holdings = []) => holdings.map(({ name, copies }) => `${copies} in ${name}`).join(', ');

export function availableCopies(owned, card, { unlimitedBasics = false } = {}) {
  if (unlimitedBasics && isBasic(card)) return Infinity;
  return owned.counts.get(card.oracleId) ?? 0;
}
