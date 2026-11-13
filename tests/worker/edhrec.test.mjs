// refresh_edhrec and rank_commanders' EDHREC view on the shared fixture, with EDHREC mocked, and the
// outbound allowlist every such request goes through.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundRefused, boundedJson, outboundFetch } from '../../src/outbound.mjs';
import { callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner } = await seedPeople());
  await env.DB.prepare('DELETE FROM edhrec_pages').run();
});

const PAGE = {
  container: {
    json_dict: {
      card: { num_decks: 7672 },
      cardlists: [
        {
          cardviews: [
            { name: 'Llanowar Elves', num_decks: 4000, potential_decks: 7000, synergy: 0.2 },
            { name: 'Bearded Bear', num_decks: 3000, potential_decks: 7000, synergy: 0.6 },
          ],
        },
      ],
    },
  },
};

function mockEdhrec(pages) {
  const urls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    const slug = url.match(/commanders\/(.+)\.json$/)?.[1];
    if (slug && pages[slug]) return Response.json(pages[slug]);
    if (slug) return new Response('Forbidden', { status: 403 });
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
  return urls;
}

describe('refresh_edhrec', () => {
  it('fetches named commanders once, then keeps them for max_age_days', async () => {
    const urls = mockEdhrec({ 'ayula-queen-among-bears': PAGE });
    const first = await callTool(owner, 'refresh_edhrec', { commanders: ['ayula, queen among bears', 'Sol Ring'] });
    expect(first.text.split('\n')).toEqual([
      'Fetched Ayula, Queen Among Bears (7672 decks)',
      'Fetched Sol Ring (EDHREC has no page)',
      'EDHREC pages for 2 commanders: 2 fetched, 0 already fresh (within 30 days).',
      'rank_commanders now shows how much of each page the person owns.',
    ]);
    expect(urls).toEqual([
      'https://json.edhrec.com/pages/commanders/ayula-queen-among-bears.json',
      'https://json.edhrec.com/pages/commanders/sol-ring.json',
    ]);
    const again = await callTool(owner, 'refresh_edhrec', { commanders: ['Ayula, Queen Among Bears'] });
    expect(again.text).toBe('EDHREC pages for 1 commanders: 0 fetched, 1 already fresh (within 30 days).');
    expect(urls).toHaveLength(2);
    const ranking = await callTool(owner, 'rank_commanders', { min_cards: 0, name: 'Ayula', sort: 'edhrec' });
    expect(ranking.text).toMatch(/EDHREC: 1 of 2 listed cards owned/);
  });

  it('refuses unknown names and an empty request', async () => {
    mockEdhrec({});
    expect((await callTool(owner, 'refresh_edhrec', { commanders: ['Ayula Queen'] })).text).toMatch(
      /^No card named Ayula Queen/,
    );
    expect((await callTool(owner, 'refresh_edhrec', {})).text).toBe(
      'Name commanders, or pass top to refresh the best-ranked ones',
    );
  });

  it('reports a changed page shape without caching it', async () => {
    mockEdhrec({ 'ayula-queen-among-bears': { unexpected: true } });
    const { text } = await callTool(owner, 'refresh_edhrec', { commanders: ['Ayula, Queen Among Bears'] });
    expect(text).toMatch(/WARNING: Stopped early: Unexpected EDHREC response for ayula-queen-among-bears/);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM edhrec_pages').first('n')).toBe(0);
  });
});

describe('the outbound allowlist', () => {
  it('refuses other hosts, plain http and redirects off the list', async () => {
    const fetched = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/latest' } }),
      );
    fetched.mockClear();
    for (const url of ['https://example.com/x', 'http://json.edhrec.com/x', 'https://json.edhrec.com:8443/x']) {
      await expect(outboundFetch(url), url).rejects.toBeInstanceOf(OutboundRefused);
    }
    expect(fetched).not.toHaveBeenCalled();
    await expect(outboundFetch('https://archidekt.com/api/decks/1/')).rejects.toThrow(
      'Requests to 169.254.169.254 are not allowed',
    );
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('refuses oversized bodies', async () => {
    const big = new Response('x'.repeat(5 * 1024 * 1024));
    await expect(boundedJson(big)).rejects.toThrow('The response is too large');
  });
});
