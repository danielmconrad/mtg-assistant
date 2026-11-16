// Lists the Magic: The Gathering singles an eBay seller has for sale, as CSV, through eBay's Browse API
// (eBay's terms forbid scraping its pages). Needs EBAY_CLIENT_ID and EBAY_CLIENT_SECRET in .env (see
// .env.example), and only reads public listings: no eBay login is involved.
//
//   mise run ebay:seller -- <seller> [--out file.csv] [--category 38292] [--no-details]
//
// --no-details skips the per-listing lookups for item specifics (card name, set, finish, condition),
// leaving only titles and prices: one request per 200 listings instead of one per 20.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const API = 'https://api.ebay.com';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
// eBay US's "Magic: The Gathering Individual Cards" category.
export const MTG_SINGLES = '38292';
const PAGE_SIZE = 200;
// Browse search stops at 10,000 results however they're paged.
const SEARCH_CAP = 10_000;
const DETAILS_BATCH = 20;
// Usernames are letters, digits and . _ - *; anything else could break out of the filter expression.
const SELLER = /^[\w.*-]{1,64}$/;

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

export class EbayError extends Error {}

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
  throw new EbayError(`${what}: eBay answered ${response.status}: ${message}`);
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

// Every listing the seller has in the category, as search summaries.
export async function sellerListings(get, seller, category, log = () => {}) {
  if (!SELLER.test(seller)) throw new EbayError(`${seller} doesn't look like an eBay username`);
  const listings = [];
  for (let offset = 0; offset < SEARCH_CAP; offset += PAGE_SIZE) {
    const page = await get(
      '/item_summary/search',
      { category_ids: category, filter: `sellers:{${seller}}`, limit: PAGE_SIZE, offset },
      'Searching listings',
    );
    listings.push(...(page.itemSummaries ?? []));
    log(`Found ${listings.length} of ${page.total ?? listings.length} listings`);
    if (!page.next || !page.itemSummaries?.length) break;
  }
  return listings;
}

// Full listings (item specifics, quantity) by item ID, 20 to a request.
export async function listingDetails(get, itemIds, log = () => {}) {
  const details = new Map();
  for (let start = 0; start < itemIds.length; start += DETAILS_BATCH) {
    const ids = itemIds.slice(start, start + DETAILS_BATCH);
    const { items = [] } = await get('/item/', { item_ids: ids.join(',') }, 'Getting item specifics');
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
  { env = process.env, fetchImpl = fetch, category = MTG_SINGLES, details = true, log = () => {} } = {},
) {
  const get = browse(await appToken(env, fetchImpl), fetchImpl);
  const listings = await sellerListings(get, seller, category, log);
  if (listings.length >= SEARCH_CAP) {
    log(`eBay returns at most ${SEARCH_CAP} listings per search, so this list stops there`);
  }
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
      category: { type: 'string', default: MTG_SINGLES },
      'no-details': { type: 'boolean', default: false },
    },
  });
  if (positionals.length !== 1) {
    console.error('Usage: mise run ebay:seller -- <seller> [--out file.csv] [--category id] [--no-details]');
    process.exit(2);
  }
  const log = (line) => console.error(line);
  try {
    const csv = await sellerCsv(positionals[0], { category: values.category, details: !values['no-details'], log });
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
