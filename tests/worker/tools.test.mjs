// The read-only tools, called through /mcp as Claude calls them, on fixture cards and a migrated
// collection and deck (tool-fixtures.mjs).
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseCollection, parseTextCollection } from '../../src/core/collection.mjs';
import { DOWNLOAD_PURPOSE } from '../../src/downloads.mjs';
import { signLink } from '../../src/links.mjs';
import { TOOLS } from '../../src/mcp/tools/index.mjs';
import { WORKFLOWS } from '../../src/mcp/workflows/index.mjs';
import { accessAssertion, call, mcp } from './helpers.mjs';
import { OTHER, OWNER, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';
import { unzip } from './zip-reader.mjs';

let owner;
let other;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner, other } = await seedPeople());
});

describe('search_cards', () => {
  it('lists owned cards with copies, protected holdings noted', async () => {
    const { text } = await callTool(owner, 'search_cards', { include_protected: true });
    expect(text).toContain('2x Sol Ring {1} — Artifact [C] [Game Changer]');
    expect(text).toContain('3x Llanowar Elves {G} — Creature — Elf Druid [G]');
    expect(text).toContain('0x Reanimate {B} — Sorcery [B] (+1 in protected/precons/Spooky, protected)');
    expect(text).toMatch(/4 cards$/m);
  });

  it('counts and groups', async () => {
    expect((await callTool(owner, 'search_cards', { count: true })).text).toContain(
      '3 cards, 6 copies in ManaBox_Collection',
    );
    const grouped = (await callTool(owner, 'search_cards', { group_by: 'identity' })).text;
    expect(grouped).toMatch(/^2 +G \(4 copies\)$/m);
  });

  it('filters by identity, commander, text and type', async () => {
    expect((await callTool(owner, 'search_cards', { identity: 'C' })).text).toMatch(/Sol Ring[\s\S]*1 cards/);
    expect(
      (await callTool(owner, 'search_cards', { commander: 'Ayula, Queen Among Bears', type: ['creature'] })).text,
    ).toMatch(/Llanowar Elves[\s\S]*Ayula[\s\S]*2 cards/);
    expect((await callTool(owner, 'search_cards', { text: ['add \\{g\\}'] })).text).toMatch(
      /Llanowar Elves[\s\S]*1 cards/,
    );
    expect((await callTool(owner, 'search_cards', { role: ['ramp'], sort: 'edhrec' })).text).toMatch(
      /Sol Ring[\s\S]*Llanowar Elves/,
    );
  });

  it('searches cards the person does not own, and every card', async () => {
    const unowned = (await callTool(owner, 'search_cards', { scope: 'unowned', identity: 'G' })).text;
    expect(unowned).toContain('Bearded Bear');
    expect(unowned).not.toContain('Llanowar Elves');
    const all = (await callTool(owner, 'search_cards', { scope: 'all', set: ['lea'] })).text;
    expect(all).toContain('0x Lightning Bolt {R} — Instant [R] {lea 161, common}');
  });

  it('says when it shows only some results', async () => {
    expect((await callTool(owner, 'search_cards', { limit: 1 })).text).toMatch(/1 of 3 cards shown/);
  });

  it('refuses unsafe or contradictory searches', async () => {
    expect(await callTool(owner, 'search_cards', { text: ['(a+)+$'] })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/nested quantifier/),
    });
    expect(await callTool(owner, 'search_cards', { name: '(' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/not a valid regular expression/),
    });
    expect(await callTool(owner, 'search_cards', { count: true, group_by: 'role' })).toMatchObject({ isError: true });
    expect(
      await callTool(owner, 'search_cards', { identity: 'G', commander: 'Ayula, Queen Among Bears' }),
    ).toMatchObject({ isError: true, text: expect.stringMatching(/not both/) });
  });

  it('rejects unknown arguments', async () => {
    const result = await callTool(owner, 'search_cards', { user_id: 'someone-else' });
    expect(result.isError || result.error).toBeTruthy();
  });
});

describe('get_cards', () => {
  it('reports copies and the decks using a card', async () => {
    const { text } = await callTool(owner, 'get_cards', { names: ['Llanowar Elves'] });
    expect(text).toContain('Copies: 3 available');
    expect(text).toMatch(/Decks: .*bears/);
  });

  it('suggests names for misspellings', async () => {
    const { text } = await callTool(owner, 'get_cards', { names: ['Llanowar Elfs', 'Zzzzzzzzzz'] });
    expect(text).toContain('Llanowar Elfs: no card by that name; did you mean Llanowar Elves?');
    expect(text).toContain('Zzzzzzzzzz: no card by that name; check the spelling');
  });
});

describe('collection_summary', () => {
  it('lists collections, protection and unmatched rows', async () => {
    const { text } = await callTool(owner, 'collection_summary');
    expect(text).toMatch(/^Card data: \d+ printings of \d+ cards/m);
    expect(text).toContain('ManaBox_Collection: 3 rows, 6 copies, 3 distinct names, 0 proxy copies');
    expect(text).toContain('protected/precons/Spooky (protected): 2 rows');
    expect(text).toContain('WARNING: protected/precons/Spooky: line 2: Missing Card matches no printing');
  });
});

describe('rank_commanders', () => {
  it('ranks commanders from the precomputed pool, noting ownership and the decks they lead', async () => {
    const { text } = await callTool(owner, 'rank_commanders', { min_cards: 0 });
    expect(text).toMatch(/^1\. Ayula, Queen Among Bears \{1\}\{G\} \[G\] — 1 owned; leads bears \(/m);
    expect(text).toMatch(/on-theme cards of \d+ owned spells/);
    expect(text).toMatch(/commanders shown, by lift, of \d+ the filters keep/);
  });

  it('applies identity, ownership and theme filters', async () => {
    expect((await callTool(owner, 'rank_commanders', { min_cards: 0, identity: 'B' })).text).not.toContain('Ayula');
    expect((await callTool(owner, 'rank_commanders', { min_cards: 0, ownership: 'unowned' })).text).not.toContain(
      'Ayula',
    );
    expect((await callTool(owner, 'rank_commanders', { min_cards: 0, theme: 'bear' })).text).toContain('Ayula');
    expect((await callTool(owner, 'rank_commanders', { min_cards: 0, theme: 'treasure' })).text).not.toContain('Ayula');
  });

  it('refuses unsafe patterns', async () => {
    expect(await callTool(owner, 'rank_commanders', { theme: '(a*)*' })).toMatchObject({ isError: true });
  });
});

describe('deck tools', () => {
  it('list, show, stats, check and export a deck', async () => {
    expect((await callTool(owner, 'list_decks')).text).toBe('bears: Bears (commander, draft)');
    expect((await callTool(owner, 'show_deck', { slug: 'bears', role: 'ramp' })).text).toBe(
      [
        'Commander: 1x Ayula, Queen Among Bears {1}{G} — Legendary Creature — Bear',
        'ramp (2)',
        '  1x Llanowar Elves {G} — Creature — Elf Druid [ramp]',
        '  1x Sol Ring {1} — Artifact [ramp]',
      ].join('\n'),
    );
    expect((await callTool(owner, 'deck_stats', { slug: 'bears' })).text).toMatch(/curve/i);
    const check = (await callTool(owner, 'check_deck', { slug: 'bears' })).text;
    expect(check).toBe(
      'PASS: bears (100 cards)\n  NOTE: Bracket 3 or higher by its cards (1 Game Changers: Sol Ring); set target_bracket to enforce',
    );
    const exported = (await callTool(owner, 'export_deck', { slug: 'bears', format: 'moxfield', upgrades: 'apply' }))
      .text;
    expect(exported).toContain('1 Ayula, Queen Among Bears (MH1) 155');
    expect(exported).toContain('Bearded Bear');
    expect(exported).toContain('In Moxfield');
    const manabox = (await callTool(owner, 'export_deck', { slug: 'bears', format: 'manabox' })).text;
    expect(manabox).toMatch(/^Commander\n1 Ayula, Queen Among Bears \(MH1\) 155\n\nDeck\n/);
    expect(manabox).toContain('In ManaBox');
  });

  it('refuses an unknown or malformed slug', async () => {
    expect(await callTool(owner, 'show_deck', { slug: 'nope' })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/No deck named nope/),
    });
    const malformed = await callTool(owner, 'show_deck', { slug: '../etc' });
    expect(malformed.isError || malformed.error).toBeTruthy();
  });
});

describe('get_download_link and /download', () => {
  const linkIn = (text) => new URL(text.match(/https:\/\/\S+/)[0]);
  const open = async (url, email = OWNER) =>
    call(
      url.pathname + url.search,
      email ? { headers: { 'Cf-Access-Jwt-Assertion': await accessAssertion(email) } } : {},
    );
  const linkFor = async (args) => linkIn((await callTool(owner, 'get_download_link', args)).text);
  const events = async (type) =>
    (await env.DB.prepare('SELECT * FROM auth_events WHERE type = ? ORDER BY id').bind(type).all()).results;

  it('downloads a ManaBox CSV that reads back, without purchase prices unless asked', async () => {
    const { text } = await callTool(owner, 'get_download_link', {
      collection: 'ManaBox_Collection',
      format: 'manabox_csv',
    });
    expect(text).toMatch(/expires at \d\d:\d\d UTC \(15 minutes\) and works 3 times/);
    expect(text).toContain(`signed in through Cloudflare Access as ${OWNER}`);
    const response = await open(linkIn(text));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="ManaBox_Collection.csv"');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toMatch(/purchase price|1\.50/i);
    const rows = parseCollection(body, 'download');
    expect(rows.map((row) => [row.name, row.quantity, row.finish])).toEqual([
      ['Sol Ring', 2, 'normal'],
      ['Llanowar Elves', 3, 'normal'],
      ['Ayula, Queen Among Bears', 1, 'foil'],
    ]);
    expect(body.split('\n')[0]).toBe(
      'Binder Name,Binder Type,Name,Set code,Collector number,Foil,Quantity,Scryfall ID,Proxy',
    );

    const priced = await (
      await open(await linkFor({ collection: 'ManaBox_Collection', format: 'manabox_csv', include_prices: true }))
    ).text();
    expect(priced.split('\n')[0]).toContain('Purchase price');
    expect(priced).toContain('1.50');
  });

  it('writes Moxfield CSV and text lists', async () => {
    const moxfield = await (
      await open(await linkFor({ collection: 'ManaBox_Collection', format: 'moxfield_csv' }))
    ).text();
    expect(moxfield.split('\n').slice(0, 2)).toEqual([
      'Count,Name,Edition,Collector Number,Foil,Proxy',
      '2,Sol Ring,c21,263,,False',
    ]);
    const text = await (await open(await linkFor({ collection: 'ManaBox_Collection', format: 'text' }))).text();
    expect(text).toBe('2 Sol Ring (C21) 263\n3 Llanowar Elves (M19) 314\n1 Ayula, Queen Among Bears (MH1) 155 *F*\n');
    expect(parseTextCollection(text, 'download')).toHaveLength(3);
  });

  it('combines every collection into one ManaBox CSV, naming each row’s binder', async () => {
    const { text } = await callTool(owner, 'get_download_link', {
      collection: 'all',
      combine: true,
      format: 'manabox_csv',
    });
    expect(text).toContain('every collection (2) as one file');
    const response = await open(linkIn(text));
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="mtg-collections-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const body = await response.text();
    expect(body.split('\n')[0]).toMatch(/^Binder Name,Binder Type,Name,/);
    expect(parseCollection(body, 'combined').map((row) => row.name)).toEqual([
      'Sol Ring',
      'Llanowar Elves',
      'Ayula, Queen Among Bears',
      'Reanimate',
    ]);
    expect(body).toMatch(/^protected\/precons\/Spooky,binder,Reanimate,/m);
    expect(JSON.parse((await events('download_served'))[0].detail)).toMatchObject({ combine: true });
    expect((await callTool(owner, 'get_download_link', { collection: 'ManaBox_Collection', combine: true })).text).toBe(
      'combine joins every collection; pass collection "all"',
    );
  });

  it('writes a text list ManaBox imports by default', async () => {
    const { text } = await callTool(owner, 'get_download_link', { collection: 'ManaBox_Collection' });
    expect(text).toContain('ManaBox_Collection (text)');
    expect(text).not.toContain('WARNING');
    const response = await open(linkIn(text));
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="ManaBox_Collection.txt"');
    expect(await response.text()).toBe(
      '2 Sol Ring (C21) 263\n3 Llanowar Elves (M19) 314\n1 Ayula, Queen Among Bears (MH1) 155 *F*\n',
    );
  });

  it('zips every collection with a manifest', async () => {
    const { text } = await callTool(owner, 'get_download_link', { collection: 'all', format: 'manabox_csv' });
    expect(text).toContain('every collection (2) as a zip');
    expect(text).toContain('WARNING: 1 rows match no printing');
    const response = await open(linkIn(text));
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    const files = await unzip(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual([
      'ManaBox_Collection.csv',
      'manifest.json',
      'protected/precons/Spooky.csv',
    ]);
    expect(parseCollection(files['protected/precons/Spooky.csv'], 'spooky').map((row) => row.name)).toEqual([
      'Reanimate',
    ]);
    const manifest = JSON.parse(files['manifest.json']);
    expect(manifest).toMatchObject({ format: 'manabox_csv', include_prices: false });
    expect(manifest.collections).toEqual([
      {
        name: 'ManaBox_Collection',
        file: 'ManaBox_Collection.csv',
        protected: false,
        rows: 3,
        copies: 6,
        rows_left_out: 0,
      },
      {
        name: 'protected/precons/Spooky',
        file: 'protected/precons/Spooky.csv',
        protected: true,
        rows: 2,
        copies: 2,
        rows_left_out: 1,
      },
    ]);
    const textZip = await unzip(
      new Uint8Array(await (await open(await linkFor({ collection: 'all', format: 'text' }))).arrayBuffer()),
    );
    expect(textZip['protected/precons/Spooky.txt']).toMatch(/^1 Reanimate.*\n1 Missing Card \(ZZZ\) 1\n$/);
  });

  it('works three times, then refuses', async () => {
    const url = await linkFor({ collection: 'ManaBox_Collection' });
    for (let use = 0; use < 3; use += 1) expect((await open(url)).status).toBe(200);
    const refused = await open(url);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('invalid, expired or used up');
    expect(await events('download_served')).toHaveLength(3);
    expect(JSON.parse((await events('download_refused'))[0].detail)).toEqual({ reason: 'used up' });
  });

  it('opens only for the link’s own person, signed in through Access', async () => {
    const url = await linkFor({ collection: 'ManaBox_Collection' });
    expect((await open(url, OTHER)).status).toBe(403);
    expect((await open(url, null)).status).toBe(403);
    expect((await events('download_refused')).map((event) => JSON.parse(event.detail).reason)).toEqual([
      'signed-in person is not the link’s user',
      'missing Access assertion',
    ]);
    // Neither refusal used up the link.
    expect((await open(url)).status).toBe(200);
  });

  it('refuses tampered, expired and wrong-purpose tokens', async () => {
    const url = await linkFor({ collection: 'ManaBox_Collection' });
    const token = url.searchParams.get('token');
    const [body, signature] = token.split('.');
    const forged = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    forged.collection = 'all';
    const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    url.searchParams.set('token', `${forgedBody}.${signature}`);
    expect((await open(url)).status).toBe(403);

    const userId = (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(OWNER).first()).id;
    const claims = { user: userId, collection: 'all', format: 'text', prices: false };
    const expired = await signLink(env.DOWNLOAD_SIGNING_KEY, DOWNLOAD_PURPOSE, claims, {
      now: Date.now() - 3_600_000,
      ttlMs: 60_000,
    });
    url.searchParams.set('token', expired.token);
    expect((await open(url)).status).toBe(403);
    const upload = await signLink(env.DOWNLOAD_SIGNING_KEY, 'upload', claims, { now: Date.now(), ttlMs: 60_000 });
    url.searchParams.set('token', upload.token);
    expect((await open(url)).status).toBe(403);
    expect((await events('download_refused')).map((event) => JSON.parse(event.detail).reason)).toEqual([
      'bad signature',
      'expired',
      'link made for something else',
    ]);
  });

  it('refuses unknown collections, and says when downloads are not set up', async () => {
    expect(await callTool(owner, 'get_download_link', { collection: 'Nope' })).toMatchObject({
      isError: true,
      text: 'No collection named Nope; collection_summary lists yours',
    });
    const response = await mcp(
      owner.tokens.access_token,
      'tools/call',
      { name: 'get_download_link', arguments: { collection: 'all' } },
      { DOWNLOAD_SIGNING_KEY: '' },
    );
    expect((await response.json()).result.content[0].text).toBe('Downloads are not set up on this server yet.');
  });
});

describe('get_workflow and prompts', () => {
  // Tool names, and argument names that look like them (collection_source).
  const TOOL_NAMES = new Set(['whoami', ...TOOLS.flatMap((tool) => [tool.name, ...Object.keys(tool.schema.shape)])]);

  it('returns a playbook', async () => {
    const { text } = await callTool(owner, 'get_workflow', { name: 'new-deck' });
    expect(text).toMatch(/^# Brewing a new deck/);
    expect(text).toContain('create_deck and update_deck save decks');
    expect((await callTool(owner, 'get_workflow', { name: 'nope' })).isError).toBeTruthy();
  });

  it('offers every playbook as a prompt', async () => {
    const list = await (await mcp(owner.tokens.access_token, 'prompts/list')).json();
    expect(list.result.prompts.map((prompt) => prompt.name)).toEqual(WORKFLOWS.map((workflow) => workflow.name));
    const prompt = await (await mcp(owner.tokens.access_token, 'prompts/get', { name: 'deck-review' })).json();
    expect(prompt.result.messages[0].content.text).toMatch(/^# Reviewing a deck/);
  });

  it.each(WORKFLOWS.map((workflow) => [workflow.name, workflow.text]))(
    '%s names only this server’s tools, not mtg-manager’s commands',
    (_name, text) => {
      expect(text).not.toMatch(/mise run|\b(?:deck|collection|card|scryfall|edhrec):[a-z]/);
      for (const [named] of text.matchAll(/\b(?:search|get|list|show|deck|check|export|rank|collection)_[a-z_]+\b/g)) {
        expect(TOOL_NAMES, named).toContain(named);
      }
    },
  );
});

// Every tool, called by someone else, sees nothing of the owner's. A new tool fails this until added.
const ISOLATION = {
  search_cards: [{ include_protected: true }, (text) => expect(text).toMatch(/^0 cards$/m)],
  get_cards: [{ names: ['Llanowar Elves'] }, (text) => expect(text).toMatch(/Copies: 0 available[\s\S]*Decks: none/)],
  collection_summary: [{}, (text) => expect(text).toContain('No collections yet.')],
  list_decks: [{}, (text) => expect(text).toBe('No decks yet.')],
  rank_commanders: [
    { min_cards: 0 },
    (text) => {
      expect(text).toMatch(/Ayula, Queen Among Bears .* — unowned \(/);
      expect(text).toContain('0 on-theme cards of 0 owned spells');
      expect(text).not.toContain('leads');
    },
  ],
  show_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  deck_stats: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  check_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  export_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  verify_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  deck_candidates: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  deck_upgrades: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  // A second person's create_deck makes their own deck (deck-writes.test.mjs checks the owner's is untouched).
  create_deck: [
    { slug: 'mine', commanders: ['Ayula, Queen Among Bears'] },
    (text) => expect(text).toMatch(/^Created mine/),
  ],
  update_deck: [
    { slug: 'bears', ops: [{ op: 'set', field: 'notes', value: 'x' }] },
    (text) => expect(text).toMatch(/No deck named bears/),
  ],
  // A second person's import makes their own deck; the owner's bears deck is no conflict.
  import_deck: [
    { list: '1 Sol Ring', slug: 'bears' },
    (text) => expect(text).toMatch(/^Created bears \(casual-60, draft\)/),
  ],
  add_cards: [
    { collection: 'binder', cards: '1 Forest' },
    (text) => expect(text).toMatch(/^No collection named binder \(yours: none yet\)/),
  ],
  remove_cards: [
    { collection: 'binder', cards: '1 Forest' },
    (text) => expect(text).toMatch(/^No collection named binder \(yours: none yet\)/),
  ],
  collection_changes: [
    { since: '2026-01-01' },
    (text) => expect(text).toMatch(/^No collection changes since 2026-01-01\./),
  ],
  get_download_link: [{ collection: 'all' }, (text) => expect(text).toBe('No collections to download yet.')],
  build_deck: [{ slug: 'bears' }, (text) => expect(text).toMatch(/No deck named bears/)],
  teardown_deck: [{ slug: 'bears', to: 'binder' }, (text) => expect(text).toMatch(/No deck named bears/)],
  swap_deck: [
    { slug: 'bears', out: ['Sol Ring'], in: ['Lightning Bolt'], to: 'binder' },
    (text) => expect(text).toMatch(/No deck named bears/),
  ],
  get_upload_link: [{}, (text) => expect(text).toMatch(/^Upload page:\nhttps:\/\/\S+\/upload\?token=/)],
  // With nothing owned, the top of the ranking is empty, so nothing is fetched.
  refresh_edhrec: [{ top: 1 }, (text) => expect(text).toMatch(/^EDHREC pages for 0 commanders/)],
  get_workflow: [{ name: 'collection-survey' }, (text) => expect(text).toMatch(/^# Surveying the collection/)],
};

describe('isolation between people', () => {
  it('covers every tool', () => {
    expect(Object.keys(ISOLATION).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
  });

  it.each(Object.entries(ISOLATION))('%s shows another person nothing of the owner’s', async (name, [args, check]) => {
    const { text } = await callTool(other, name, args);
    check(text);
    expect(text).not.toMatch(/ManaBox_Collection|Spooky|Bears \(/);
  });
});

describe('/mcp request limits', () => {
  it('refuses bodies over 64 KB', async () => {
    const response = await call('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${owner.tokens.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_cards', arguments: { names: ['x'.repeat(70_000)] } },
      }),
    });
    expect(response.status).toBe(413);
  });
});
