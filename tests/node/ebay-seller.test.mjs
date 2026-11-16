// scripts/ebay-seller.mjs against a fake Browse API: what it asks eBay, how it pages and batches, and the
// CSV it writes.
import { describe, expect, it } from 'vitest';
import { EbayError, sellerCsv, toCsv } from '../../scripts/ebay-seller.mjs';

const ENV = { EBAY_CLIENT_ID: 'fake-id', EBAY_CLIENT_SECRET: 'fake-secret' };

const summary = (n) => ({
  itemId: `v1|${n}|0`,
  legacyItemId: String(n),
  title: `Listing ${n}`,
  price: { value: '1.50', currency: 'USD' },
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

// A fake eBay with `count` listings; records each request.
function fakeEbay(count) {
  const requests = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ path: url.pathname, params: Object.fromEntries(url.searchParams), init });
    if (url.pathname === '/identity/v1/oauth2/token') return Response.json({ access_token: 'token' });
    if (url.pathname === '/buy/browse/v1/item_summary/search') {
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      const end = Math.min(offset + limit, count);
      const itemSummaries = Array.from({ length: Math.max(end - offset, 0) }, (_, i) => summary(offset + i + 1));
      return Response.json({ total: count, itemSummaries, ...(end < count ? { next: 'more' } : {}) });
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
      { category_ids: '38292', filter: 'sellers:{card_shop-1}', limit: '200', offset: '0' },
      { category_ids: '38292', filter: 'sellers:{card_shop-1}', limit: '200', offset: '200' },
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
