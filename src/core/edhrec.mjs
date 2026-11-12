// EDHREC's commander pages: which cards decks with each commander play. Ported from mtg-manager; the
// file cache is gone (pages will be cached in D1), and fetching uses Web APIs only.
import { isBasic } from './card.mjs';
import { sleep, withRetries } from './retries.mjs';

// The JSON EDHREC's own site loads. It isn't a documented API, so requests are spaced out, pages are
// cached, and an unexpected shape fails loudly instead of being guessed at.
const PAGE_URL = 'https://json.edhrec.com/pages/commanders';
const REQUEST_GAP_MS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS = { 'User-Agent': 'CollectionFirstDeckBuilder/1.0', Accept: 'application/json' };
// A commander without a page gets 403 or 404 from EDHREC's storage rather than an error body.
const NOT_FOUND_STATUSES = [403, 404];
export const EDHREC_CACHE_VERSION = 1;
export const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;
const TOP_OWNED_COUNT = 10;

// EDHREC's page name for a commander: its front face, without accents or punctuation, hyphenated, e.g.
// "Y'shtola, Night's Blessed" -> "yshtola-nights-blessed".
export const edhrecSlug = (name) =>
  name
    .split(' // ')[0]
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-');

// The parts of a page the tools use: how many decks EDHREC has seen, and each card they play with
// the decks playing it, the decks that could, and EDHREC's synergy (how much more often it's played
// with this commander than in other decks of its colors).
export function parsePage(body, slug, fetchedAt) {
  const page = body?.container?.json_dict;
  const lists = page?.cardlists;
  if (!Array.isArray(lists) || typeof page.card?.num_decks !== 'number') {
    throw new Error(`Unexpected EDHREC response for ${slug}; cache was not changed for it`);
  }
  const cards = new Map();
  for (const view of lists.flatMap((list) => list.cardviews ?? [])) {
    if (view?.name && !cards.has(view.name)) cards.set(view.name, listing(view));
  }
  return { slug, fetchedAt, decks: page.card.num_decks, cards: [...cards.values()] };
}

// A card a commander page lists; a card appears in several of its lists with the same numbers.
const listing = (view) => ({
  name: view.name,
  decks: view.num_decks ?? 0,
  potential: view.potential_decks ?? 0,
  synergy: view.synergy ?? 0,
});

// One commander's page, or { slug, fetchedAt, missing: true } when EDHREC has none.
export async function fetchPage(name, { fetchFn = fetch, pause = sleep, now = Date.now() } = {}) {
  const slug = edhrecSlug(name);
  const response = await withRetries(
    () => fetchFn(`${PAGE_URL}/${slug}.json`, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    pause,
    'EDHREC',
  );
  const fetchedAt = new Date(now).toISOString();
  if (NOT_FOUND_STATUSES.includes(response.status)) return { slug, fetchedAt, missing: true };
  if (!response.ok) throw new Error(`EDHREC returned HTTP ${response.status} for ${slug}. Retry later.`);
  return parsePage(await response.json(), slug, fetchedAt);
}

// Fetches pages one at a time, a second apart, calling onPage with each so a failure part way keeps
// the pages already fetched.
export async function fetchPages(names, { fetchFn, pause = sleep, now, onPage = () => {} } = {}) {
  for (const [position, name] of names.entries()) {
    if (position) await pause(REQUEST_GAP_MS);
    onPage(name, await fetchPage(name, { fetchFn, pause, now }), position + 1);
  }
}

export const isStale = (page, now, maxAgeDays = DEFAULT_MAX_AGE_DAYS) =>
  !page || (now - Date.parse(page.fetchedAt)) / DAY_MS > maxAgeDays;

const share = (part, whole) => (whole ? part / whole : null);

// How much of a commander's EDHREC page the available collections hold: the listed cards owned, the
// share of its positive synergy they carry (its signature cards), and the share of an average deck's
// listed cards they make up (staples included). Basics and names the cache lacks are left out.
export function edhrecFit(page, index, owned) {
  if (page.missing) return { missing: true, fetchedAt: page.fetchedAt };
  const listed = page.cards.flatMap((listing) => {
    const { card } = index.lookup({ name: listing.name });
    return card && !isBasic(card) ? [{ ...listing, card, owned: owned.counts.has(card.oracleId) }] : [];
  });
  const inclusion = ({ decks, potential }) => share(decks, potential) ?? 0;
  const positiveSynergy = ({ synergy }) => Math.max(synergy, 0);
  const total = (list, value) => list.reduce((sum, listing) => sum + value(listing), 0);
  const ownedListings = listed.filter((listing) => listing.owned);
  return {
    missing: false,
    fetchedAt: page.fetchedAt,
    decks: page.decks,
    listed: listed.length,
    owned: ownedListings.length,
    synergyShare: share(total(ownedListings, positiveSynergy), total(listed, positiveSynergy)),
    deckShare: share(total(ownedListings, inclusion), total(listed, inclusion)),
    topOwned: ownedListings
      .toSorted((first, second) => second.synergy - first.synergy)
      .slice(0, TOP_OWNED_COUNT)
      .map(({ card, synergy }) => ({ name: card.name, synergy })),
  };
}

export const emptyEdhrecCache = () => ({ version: EDHREC_CACHE_VERSION, commanders: {} });
