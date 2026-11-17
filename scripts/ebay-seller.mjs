// Lists the Magic: The Gathering singles an eBay seller has for sale, as CSV, through eBay's Browse API
// (eBay's terms forbid scraping its pages). Needs EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env (see
// .env.example), and only reads public listings: no eBay login is involved.
//
//   mise run ebay:seller -- <seller> [--out file.csv] [--game 'Pokémon TCG'] [--no-details]
//
// A store with more than the 10,000 listings one search returns is read in price ranges, each split
// in half until it holds fewer. --no-details skips the per-listing lookups for item specifics (card
// name, set, finish, condition), leaving only titles and prices: one request per 200 listings instead
// of one per 20. A keyset eBay hasn't approved for those lookups gets titles and prices too.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://api.ebay.com';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
// eBay US has one category for every card game's singles (CCG Individual Cards), and records which
// game a listing is for in its Game item specific.
const CCG_SINGLES = '183454';
export const MAGIC = 'Magic: The Gathering';
const PAGE_SIZE = 200;
// Browse search stops at 10,000 results however they're paged.
const SEARCH_CAP = 10_000;
const DETAILS_BATCH = 20;
// Usernames are letters, digits and . _ - *; anything else could break out of the filter expression.
const SELLER = /^[\w.*-]{1,64}$/;
// A game's name goes in an item specifics filter, where braces, pipes and commas have meanings.
const GAME = /^[^{}|,]{1,100}$/;

export const COLUMNS = [
  'card_name',
  'set',
  'collector_number',
  'finish',
  'language',
  'condition',
  'quantity',
  'price',
  'currency',
  'title',
  'url',
  'item_id',
];

export class EbayError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function ebayJson(response, what) {
  if (response.ok) return response.json();
  const body = await response.text();
  let message = body.slice(0, 300);
  try {
    message =
      JSON.parse(body)
        .errors?.map((error) => error.longMessage ?? error.message)
        .join('; ') || message;
  } catch {
    // Not JSON: keep the start of the body.
  }
  throw new EbayError(`${what}: eBay answered ${response.status}: ${message}`, response.status);
}

export async function appToken(env, fetchImpl = fetch) {
  const missing = ['EBAY_CLIENT_ID', 'EBAY_CLIENT_SECRET'].filter((name) => !env[name]?.trim());
  if (missing.length) throw new EbayError(`Fill these in .env first (see .env.example): ${missing.join(', ')}`);
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString('base64');
  const response = await fetchImpl(`${API}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }),
  });
  return (await ebayJson(response, 'Getting an application token')).access_token;
}

function browse(token, fetchImpl) {
  return async (path, params, what) => {
    const url = new URL(`/buy/browse/v1${path}`, API);
    url.search = new URLSearchParams(params);
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
    });
    return ebayJson(response, what);
  };
}

// A price range in cents, as a search filter: [low..high] includes both ends, and no high is no limit.
const dollars = (cents) => (cents / 100).toFixed(2);
export const priceFilter = ({ low, high }) =>
  `price:[${dollars(low)}..${high === undefined ? '' : dollars(high)}],priceCurrency:USD`;

// A range's two halves, which share no price. With no upper limit, the lower half doubles the bottom.
export function splitRange({ low, high }) {
  const mid = high === undefined ? Math.max(low * 2, low + 100) : Math.floor((low + high) / 2);
  return [
    { low, high: mid },
    { low: mid + 1, high },
  ];
}

const rangeLabel = (range) => {
  if (!range) return 'the store';
  return range.high === undefined ? `$${dollars(range.low)} and up` : `$${dollars(range.low)}–$${dollars(range.high)}`;
};

// A range (or the whole store, null) can be halved unless it's down to one price.
const splittable = (range) => !range || range.high === undefined || range.high > range.low;

// Adds a search's listings to `listings`, from its first page on, up to the 10,000 eBay returns.
async function readPages(search, range, first, listings) {
  let page = first;
  for (let offset = PAGE_SIZE; ; offset += PAGE_SIZE) {
    for (const summary of page.itemSummaries ?? []) listings.set(summary.itemId, summary);
    if (!page.next || !page.itemSummaries?.length || offset >= SEARCH_CAP) return;
    page = await search(range, offset);
  }
}

// Every single the seller has for sale for one game, as search summaries: all of them if they fit in
// one search, else price ranges halved until each does. A range down to one price that still doesn't
// fit keeps its first 10,000.
export async function sellerListings(get, seller, game, log = () => {}) {
  if (!SELLER.test(seller)) throw new EbayError(`${seller} doesn't look like an eBay username`);
  if (!GAME.test(game)) throw new EbayError(`${game} doesn't look like a game's name`);
  const search = (range, offset) =>
    get(
      '/item_summary/search',
      {
        category_ids: CCG_SINGLES,
        aspect_filter: `categoryId:${CCG_SINGLES},Game:{${game}}`,
        filter: [`sellers:{${seller}}`, ...(range ? [priceFilter(range)] : [])].join(','),
        limit: PAGE_SIZE,
        offset,
      },
      'Searching listings',
    );
  const listings = new Map();
  const pending = [null];
  while (pending.length) {
    const range = pending.shift();
    const first = await search(range, 0);
    const total = first.total ?? 0;
    if (total > SEARCH_CAP && splittable(range)) {
      log(`${rangeLabel(range)}: ${total} listings, more than one search returns; splitting by price`);
      pending.unshift(...splitRange(range ?? { low: 0 }));
      continue;
    }
    if (total > SEARCH_CAP) {
      log(`${rangeLabel(range)}: ${total} listings at one price; keeping the first ${SEARCH_CAP}`);
    }
    await readPages(search, range, first, listings);
    log(`${rangeLabel(range)}: ${total} listings (${listings.size} found so far)`);
  }
  return [...listings.values()];
}

// Full listings (item specifics, quantity) by item ID, 20 to a request. None, if eBay hasn't approved
// this keyset for the lookup (it's a restricted call).
export async function listingDetails(get, itemIds, log = () => {}) {
  const details = new Map();
  for (let start = 0; start < itemIds.length; start += DETAILS_BATCH) {
    const ids = itemIds.slice(start, start + DETAILS_BATCH);
    let items;
    try {
      ({ items = [] } = await get('/item/', { item_ids: ids.join(',') }, 'Getting item specifics'));
    } catch (error) {
      if (error.status !== 403) throw error;
      log(`${error.message}\nThis keyset can't read item specifics, so the list has titles and prices only`);
      return new Map();
    }
    for (const item of items) details.set(item.itemId, item);
    log(`Read item specifics for ${Math.min(start + DETAILS_BATCH, itemIds.length)} of ${itemIds.length}`);
  }
  return details;
}

const aspect = (item, ...names) => item?.localizedAspects?.find((entry) => names.includes(entry.name))?.value ?? '';

// A single's grade ("Near mint or better") when the listing gives one, else eBay's general condition.
const condition = (summary, item) =>
  item?.conditionDescriptors?.find((entry) => entry.name === 'Card Condition')?.values?.[0]?.content ??
  summary.condition;

const quantity = (item) => item?.estimatedAvailabilities?.[0]?.estimatedAvailableQuantity;

// One CSV row's values from a search summary and, if fetched, the full listing.
export function toRow(summary, item) {
  return {
    card_name: aspect(item, 'Card Name') || summary.title,
    set: aspect(item, 'Set'),
    collector_number: aspect(item, 'Card Number'),
    finish: aspect(item, 'Finish'),
    language: aspect(item, 'Language'),
    condition: condition(summary, item),
    quantity: quantity(item),
    price: summary.price?.value,
    currency: summary.price?.currency,
    title: summary.title,
    url: summary.itemWebUrl,
    item_id: summary.legacyItemId ?? summary.itemId,
  };
}

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export const toCsv = (rows) =>
  [COLUMNS, ...rows.map((row) => COLUMNS.map((column) => row[column]))]
    .map((cells) => cells.map(csvCell).join(','))
    .concat('')
    .join('\n');

export async function sellerCsv(
  seller,
  { env = process.env, fetchImpl = fetch, game = MAGIC, details = true, log = () => {} } = {},
) {
  const get = browse(await appToken(env, fetchImpl), fetchImpl);
  const listings = await sellerListings(get, seller, game, log);
  const full = details
    ? await listingDetails(
        get,
        listings.map((summary) => summary.itemId),
        log,
      )
    : new Map();
  return toCsv(listings.map((summary) => toRow(summary, full.get(summary.itemId))));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      game: { type: 'string', default: MAGIC },
      'no-details': { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) {
    console.error('Usage: mise run ebay:seller -- <seller> [--out file.csv] [--game name] [--no-details]');
    process.exit(2);
  }
  const log = (line) => console.error(line);
  try {
    const csv = await sellerCsv(positionals[0], { game: values.game, details: !values['no-details'], log });
    if (values.out) {
      writeFileSync(values.out, csv);
      log(`Wrote ${values.out}`);
    } else {
      process.stdout.write(csv);
    }
  } catch (error) {
    if (!(error instanceof EbayError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
