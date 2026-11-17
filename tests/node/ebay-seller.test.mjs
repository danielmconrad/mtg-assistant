// scripts/ebay-seller.mjs against a fake Browse API: what it asks eBay, how it pages and batches, and the
// CSV it writes.
import { describe, expect, it } from 'vitest';
import { EbayError, priceFilter, sellerCsv, splitRange, toCsv } from '../../scripts/ebay-seller.mjs';

const ENV = { EBAY_CLIENT_ID: 'fake-id', EBAY_CLIENT_SECRET: 'fake-secret' };
const MAGIC_SINGLES = {
  category_ids: '183454',
  aspect_filter: 'categoryId:183454,Game:{Magic: The Gathering}',
};

const summary = (n, cents) => ({
  itemId: `v1|${n}|0`,
  legacyItemId: String(n),
  title: `Listing ${n}`,
  price: { value: (cents / 100).toFixed(2), currency: 'USD' },
  condition: 'Ungraded',
  itemWebUrl: `https://www.ebay.com/itm/${n}`,
});

const SOL_RING = {
  itemId: 'v1|1|0',
  localizedAspects: [
    { name: 'Card Name', value: 'Sol Ring' },
    { name: 'Set', value: 'Commander Masters' },
    { name: 'Card Number', value: '1, "foil"' },
    { name: 'Finish', value: 'Foil' },
  ],
  conditionDescriptors: [{ name: 'Card Condition', values: [{ content: 'Near mint or better' }] }],
  estimatedAvailabilities: [{ estimatedAvailableQuantity: 3 }],
};

// The listings a search filter's price range keeps, as eBay reads it: both ends included, in dollars.
function inPriceRange(filter, cents) {
  const match = filter.match(/price:\[([\d.]+)\.\.([\d.]*)\]/);
  if (!match) return true;
  const [low, high] = [match[1], match[2]].map((text) => (text ? Math.round(Number(text) * 100) : Infinity));
  return cents >= low && cents <= high;
}

// A fake eBay with `count` listings, listing n priced priceOf(n) cents; records each request.
function fakeEbay(count, { priceOf = () => 150, refuseDetails = false } = {}) {
  const requests = [];
  const all = Array.from({ length: count }, (_, i) => summary(i + 1, priceOf(i + 1)));
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), init });
    if (url.pathname === '/identity/v1/oauth2/token') return Response.json({ access_token: 'token' });
    if (url.pathname === '/buy/browse/v1/item_summary/search') {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const filter = url.searchParams.get('filter');
      const matching = all.filter((listing) => inPriceRange(filter, Math.round(Number(listing.price.value) * 100)));
      const itemSummaries = matching.slice(offset, offset + limit);
      const more = offset + limit < Math.min(matching.length, 10_000);
      return Response.json({ total: matching.length, itemSummaries, ...(more ? { next: 'more' } : {}) });
    }
    if (url.pathname === '/buy/browse/v1/item/' && refuseDetails) {
      return new Response('{"errors":[{"longMessage":"Insufficient permissions to fulfill the request."}]}', {
        status: 403,
      });
    }
    if (url.pathname === '/buy/browse/v1/item/') {
      const ids = url.searchParams.get('item_ids').split(',');
      return Response.json({ items: ids.map((itemId) => (itemId === SOL_RING.itemId ? SOL_RING : { itemId })) });
    }
    return new Response('{"errors":[{"longMessage":"Not found"}]}', { status: 404 });
  };
  return { fetchImpl, requests };
}

describe('ebay-seller', () => {
  it('pages through a seller’s singles, reads item specifics 20 at a time, and writes CSV', async () => {
    const { fetchImpl, requests } = fakeEbay(205);
    const csv = await sellerCsv('card_shop-1', { env: ENV, fetchImpl });
    const searches = requests.filter((request) => request.path.endsWith('/item_summary/search'));
    expect(searches.map((request) => request.params)).toEqual([
      { ...MAGIC_SINGLES, filter: 'sellers:{card_shop-1}', limit: '200', offset: '0' },
      { ...MAGIC_SINGLES, filter: 'sellers:{card_shop-1}', limit: '200', offset: '200' },
    ]);
    expect(requests.filter((request) => request.path === '/buy/browse/v1/item/')).toHaveLength(11);
    expect(requests[0].init.headers.Authorization).toBe(`Basic ${btoa('fake-id:fake-secret')}`);
    expect(searches[0].init.headers).toEqual({ Authorization: 'Bearer token', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' });

    const lines = csv.trimEnd().split('\n');
    expect(lines).toHaveLength(206);
    expect(lines[0]).toBe(
      'card_name,set,collector_number,finish,language,condition,quantity,price,currency,title,url,item_id',
    );
    expect(lines[1]).toBe(
      'Sol Ring,Commander Masters,"1, ""foil""",Foil,,Near mint or better,3,1.50,USD,Listing 1,https://www.ebay.com/itm/1,1',
    );
    // Without item specifics, the title stands in for the card name.
    expect(lines[2]).toBe('Listing 2,,,,,Ungraded,,1.50,USD,Listing 2,https://www.ebay.com/itm/2,2');
  });

  it('reads a store too big for one search in price ranges, halved until each fits', async () => {
    // 10,050 listings at 1¢ to $100.50: the whole store is over the cap, $0.00–$1.00 and $1.01 and up aren't.
    const { fetchImpl, requests } = fakeEbay(10_050, { priceOf: (n) => n });
    const lines = (await sellerCsv('shop', { env: ENV, fetchImpl, details: false })).trimEnd().split('\n');
    expect(lines).toHaveLength(10_051);
    expect(new Set(lines).size).toBe(10_051);
    const filters = new Set(
      requests.filter((request) => request.path.endsWith('/search')).map((request) => request.params.filter),
    );
    expect(filters).toEqual(
      new Set([
        'sellers:{shop}',
        'sellers:{shop},price:[0.00..1.00],priceCurrency:USD',
        'sellers:{shop},price:[1.01..],priceCurrency:USD',
      ]),
    );
  });

  it('keeps the first 10,000 of a range that can’t be split any further', async () => {
    const { fetchImpl } = fakeEbay(10_001, { priceOf: () => 500 });
    const logged = [];
    const csv = await sellerCsv('shop', { env: ENV, fetchImpl, details: false, log: (line) => logged.push(line) });
    expect(csv.trimEnd().split('\n')).toHaveLength(10_001);
    expect(logged).toContain('$5.00–$5.00: 10001 listings at one price; keeping the first 10000');
  });

  it('halves price ranges without overlap', () => {
    expect(splitRange({ low: 0 })).toEqual([{ low: 0, high: 100 }, { low: 101 }]);
    expect(splitRange({ low: 300 })).toEqual([{ low: 300, high: 600 }, { low: 601 }]);
    expect(splitRange({ low: 101, high: 200 })).toEqual([
      { low: 101, high: 150 },
      { low: 151, high: 200 },
    ]);
    expect(priceFilter({ low: 151, high: 200 })).toBe('price:[1.51..2.00],priceCurrency:USD');
  });

  it('writes titles and prices when eBay won’t give this keyset item specifics', async () => {
    const { fetchImpl } = fakeEbay(2, { refuseDetails: true });
    const logged = [];
    const csv = await sellerCsv('shop', { env: ENV, fetchImpl, log: (line) => logged.push(line) });
    expect(csv.split('\n')[1]).toBe('Listing 1,,,,,Ungraded,,1.50,USD,Listing 1,https://www.ebay.com/itm/1,1');
    expect(logged.at(-1)).toContain("This keyset can't read item specifics");
  });

  it('skips item specifics with details off', async () => {
    const { fetchImpl, requests } = fakeEbay(3);
    await sellerCsv('shop', { env: ENV, fetchImpl, details: false });
    expect(requests.map((request) => request.path)).toEqual([
      '/identity/v1/oauth2/token',
      '/buy/browse/v1/item_summary/search',
    ]);
  });

  it('refuses missing keys, odd usernames and eBay errors before going further', async () => {
    const { fetchImpl, requests } = fakeEbay(1);
    await expect(sellerCsv('shop', { env: {}, fetchImpl })).rejects.toThrow(
      'Fill these in .env first (see .env.example): EBAY_CLIENT_ID, EBAY_CLIENT_SECRET',
    );
    expect(requests).toEqual([]);
    await expect(sellerCsv('shop},other:{x', { env: ENV, fetchImpl })).rejects.toThrow(EbayError);
    await expect(sellerCsv('shop', { env: ENV, fetchImpl, game: 'Magic},Set:{x' })).rejects.toThrow(EbayError);
    const refusing = async () => new Response('{"errors":[{"longMessage":"Invalid client"}]}', { status: 401 });
    await expect(sellerCsv('shop', { env: ENV, fetchImpl: refusing })).rejects.toThrow(
      'Getting an application token: eBay answered 401: Invalid client',
    );
  });

  it('quotes cells only when they need it', () => {
    expect(toCsv([{ card_name: 'Fire // Ice', title: 'Line\nbreak' }]).split('\n')[1]).toBe(
      'Fire // Ice,,,,,,,,,"Line',
    );
  });
});
