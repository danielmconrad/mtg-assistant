// get_upload_link and the /upload page on the shared fixture (tool-fixtures.mjs): previews, applying a
// preview exactly once, and the refusals around them.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { entriesFor } from '../../src/storage/collection-writes.mjs';
import { listCollections } from '../../src/storage/collections.mjs';
import { loadDeckForUpdate, saveDeck } from '../../src/storage/decks.mjs';
import { ORIGIN, accessAssertion, call } from './helpers.mjs';
import { ID, OTHER, OWNER, callTool, loadFixtureCards, seedPeople } from './tool-fixtures.mjs';

let owner;

beforeAll(loadFixtureCards);

beforeEach(async () => {
  ({ owner } = await seedPeople());
});

const userId = async (email = OWNER) =>
  (await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()).id;
async function collection(name) {
  return (await listCollections(env.DB, await userId())).find((candidate) => candidate.name === name);
}
async function rows(name) {
  const found = await collection(name);
  if (!found) return undefined;
  return (await entriesFor(env.DB, await userId(), found.id)).map((entry) => [
    entry.name,
    entry.quantity,
    entry.finish,
  ]);
}

const linkFor = async (args = {}) => {
  const { text } = await callTool(owner, 'get_upload_link', args);
  const url = new URL(text.match(/https:\/\/\S+/)[0]);
  return { url, token: url.searchParams.get('token') };
};
const open = async (url, email = OWNER) =>
  call(url.pathname + url.search, { headers: { 'Cf-Access-Jwt-Assertion': await accessAssertion(email) } });

// Posts the page's form as a browser would: multipart, from the page's origin, with a length.
async function post(fields, { email = OWNER, origin = ORIGIN } = {}) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return call('/upload', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': encoded.headers.get('Content-Type'),
      'Content-Length': String(body.byteLength),
      Origin: origin,
      'Cf-Access-Jwt-Assertion': await accessAssertion(email),
    },
  });
}
const file = (text, name) => new File([text], name, { type: 'text/plain' });
const previewOf = async (token, text, name, fields = {}) =>
  post({ step: 'preview', token, collection: 'ManaBox_Collection', mode: 'merge', file: file(text, name), ...fields });
const formOf = (html) => ({
  upload: html.match(/name="upload" value="([^"]+)"/)[1],
  csrf: html.match(/name="csrf" value="([^"]+)"/)[1],
});
const events = async (type) =>
  (await env.DB.prepare('SELECT * FROM auth_events WHERE type = ?').bind(type).all()).results;

describe('get_upload_link and the page', () => {
  it('shows the form only to the link’s person, signed in through Access', async () => {
    const { url } = await linkFor({ binder: 'binders/New' });
    const page = await open(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('name="collection" value="binders/New"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect((await open(url, OTHER)).status).toBe(403);
    expect((await call(url.pathname + url.search)).status).toBe(403);
    const tampered = new URL(url);
    tampered.searchParams.set('token', `${url.searchParams.get('token')}x`);
    expect((await open(tampered)).status).toBe(403);
    expect((await events('upload_refused')).map((event) => JSON.parse(event.detail).reason)).toEqual([
      'signed-in person is not the link’s user',
      'missing Access assertion',
      'malformed token',
    ]);
  });
});

describe('merging', () => {
  it('previews a text list, then applies it once', async () => {
    const { token } = await linkFor();
    const before = await rows('ManaBox_Collection');
    const preview = await previewOf(token, '2 Lightning Bolt\n1 Sol Ring (C21) 263\n', 'cards.txt');
    expect(preview.status).toBe(200);
    const html = await preview.text();
    expect(html).toContain('<h1>Merge ManaBox_Collection?</h1>');
    expect(html).toContain('<li>+2 Lightning Bolt</li><li>+1 Sol Ring</li>');
    expect(html).toContain('Decks naming changed cards: bears (Sol Ring)');
    expect(await rows('ManaBox_Collection')).toEqual(before);

    const fields = { step: 'approve', ...formOf(html) };
    const applied = await post(fields);
    expect(await applied.text()).toContain('Merged into ManaBox_Collection: 2 cards changed.');
    expect(await rows('ManaBox_Collection')).toEqual([
      ['Sol Ring', 3, 'normal'],
      ['Llanowar Elves', 3, 'normal'],
      ['Ayula, Queen Among Bears', 1, 'foil'],
      ['Lightning Bolt', 2, 'normal'],
    ]);
    expect((await post(fields)).status).toBe(403);
    const { text } = await callTool(owner, 'collection_changes', { since: '2026-01-01' });
    expect(text).toMatch(/ upload, ManaBox_Collection: \+3 — merge from cards\.txt$/m);
    const stored = await env.DB.prepare('SELECT raw_key, status FROM uploads').first();
    expect(stored.status).toBe('applied');
    expect(await (await env.UPLOADS.get(stored.raw_key)).text()).toBe('2 Lightning Bolt\n1 Sol Ring (C21) 263\n');
  });

  it('shows the file’s problems on the form, changing nothing', async () => {
    const { token } = await linkFor();
    const typo = await previewOf(token, '1 Llanowar Elfs\n', 'cards.txt');
    expect(typo.status).toBe(400);
    expect(await typo.text()).toContain('cards.txt: line 1: no card named Llanowar Elfs; did you mean Llanowar Elves?');
    const pdf = await previewOf(token, '1 Sol Ring', 'cards.pdf');
    expect(await pdf.text()).toContain('Upload a .csv (ManaBox export) or .txt (text list) file.');
    // Three previews per link, good or bad.
    expect((await previewOf(token, '1 Sol Ring', 'cards.txt')).status).toBe(200);
    expect((await previewOf(token, '1 Sol Ring', 'cards.txt')).status).toBe(403);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM uploads').first('n')).toBe(1);
  });
});

describe('replacing', () => {
  const CSV =
    'Binder Name,Binder Type,Name,Quantity,Scryfall ID,Set code,Collector number,Foil,Purchase price,Condition\n' +
    `all cards,binder,Sol Ring,1,${ID.solRing},C21,263,normal,2.00,near_mint\n` +
    `all cards,binder,Reanimate,2,${ID.reanimate},TST,1,normal,,played\n`;

  it('makes the collection exactly the CSV, keeping its other columns', async () => {
    const { token } = await linkFor();
    const preview = await previewOf(token, CSV, 'ManaBox.csv', { mode: 'replace' });
    const html = await preview.text();
    expect(html).toContain(
      '<li>-1 Ayula, Queen Among Bears</li><li>-3 Llanowar Elves</li><li>+2 Reanimate</li><li>-1 Sol Ring</li>',
    );
    await post({ step: 'approve', ...formOf(html) });
    expect(await rows('ManaBox_Collection')).toEqual([
      ['Sol Ring', 1, 'normal'],
      ['Reanimate', 2, 'normal'],
    ]);
    const records = await env.DB.prepare('SELECT source_record FROM collection_entries WHERE name = ?')
      .bind('Reanimate')
      .all();
    expect(records.results.map((row) => JSON.parse(row.source_record))).toContainEqual({
      'Binder Name': 'all cards',
      'Purchase price': '',
      Condition: 'played',
    });
    const { text } = await callTool(owner, 'collection_changes', { since: '2026-01-01' });
    expect(text).toContain(
      'ManaBox_Collection: -1 Ayula, Queen Among Bears, -3 Llanowar Elves, +2 Reanimate, -1 Sol Ring',
    );
    expect(text).not.toContain('2.00');
  });

  it('starts a new collection in the file’s format', async () => {
    const { token } = await linkFor();
    const html = await (await previewOf(token, CSV, 'binder.csv', { collection: 'binders/Upload' })).text();
    expect(html).toContain('<h1>Merge binders/Upload (new)?</h1>');
    await post({ step: 'approve', ...formOf(html) });
    expect(await collection('binders/Upload')).toMatchObject({
      format: 'manabox_csv',
      path: 'collections/binders/Upload.csv',
    });
  });

  it('applies nothing when the collection changed since the preview', async () => {
    const { token } = await linkFor();
    const html = await (await previewOf(token, CSV, 'ManaBox.csv', { mode: 'replace' })).text();
    await callTool(owner, 'add_cards', { binder: 'ManaBox_Collection', cards: '1 Forest' });
    const before = await rows('ManaBox_Collection');
    const applied = await post({ step: 'approve', ...formOf(html) });
    expect(await applied.text()).toContain('ManaBox_Collection changed since the preview.');
    expect(await rows('ManaBox_Collection')).toEqual(before);
    expect(await env.DB.prepare('SELECT status FROM uploads').first('status')).toBe('failed');
  });
});

describe('refusals', () => {
  it('discards a preview, deleting its file', async () => {
    const { token } = await linkFor();
    const html = await (await previewOf(token, '1 Forest', 'cards.txt')).text();
    const { raw_key: key } = await env.DB.prepare('SELECT raw_key FROM uploads').first();
    expect(await (await post({ step: 'discard', ...formOf(html) })).text()).toContain('Upload discarded');
    expect(await env.UPLOADS.get(key)).toBeNull();
    expect((await post({ step: 'approve', ...formOf(html) })).status).toBe(403);
  });

  it('refuses another person’s preview, another origin, oversized bodies and unknown steps', async () => {
    await callTool(owner, 'get_upload_link');
    const { token } = await linkFor();
    const html = await (await previewOf(token, '1 Forest', 'cards.txt')).text();
    expect((await post({ step: 'approve', ...formOf(html) }, { email: OTHER })).status).toBe(403);
    expect((await post({ step: 'approve', ...formOf(html) }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ step: 'constructor' })).status).toBe(400);
    const big = await call('/upload', {
      method: 'POST',
      body: 'x',
      headers: {
        'Content-Length': String(6 * 1024 * 1024),
        Origin: ORIGIN,
        'Cf-Access-Jwt-Assertion': await accessAssertion(OWNER),
      },
    });
    expect(big.status).toBe(413);
    expect(await rows('ManaBox_Collection')).toHaveLength(3);
  });

  it('leaves a built deck’s own list to its deck', async () => {
    const id = await userId();
    const { deck, updatedAt } = await loadDeckForUpdate(env.DB, id, 'bears');
    const built = { ...deck, status: 'built', collection_destination: 'collections/protected/precons/Spooky.txt' };
    await saveDeck(env.DB, id, 'bears', built, { updatedAt, now: Date.now() });
    const { token } = await linkFor();
    const page = await previewOf(token, '1 Forest', 'cards.txt', { collection: 'protected/precons/Spooky' });
    expect(await page.text()).toContain('protected/precons/Spooky holds the built deck bears');
  });
});
