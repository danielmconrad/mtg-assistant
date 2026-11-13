// Signed links (src/links.mjs) and the ZIP writer (src/zip.mjs), on their own.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { LinkKeyMissing, signLink, useLink, verifyLink } from '../../src/links.mjs';
import { crc32, zipFiles } from '../../src/zip.mjs';
import { unzip } from './zip-reader.mjs';

const KEY = 'k'.repeat(32);
const NOW = Date.UTC(2026, 10, 12, 12);

describe('signed links', () => {
  it('round-trips claims until they expire', async () => {
    const { token, claims } = await signLink(
      KEY,
      'download',
      { user: 'u1', collection: 'all' },
      { now: NOW, ttlMs: 1000 },
    );
    expect(claims).toMatchObject({ user: 'u1', collection: 'all', purpose: 'download', exp: NOW + 1000 });
    expect((await verifyLink(KEY, 'download', token, NOW + 999)).claims).toEqual(claims);
    expect(await verifyLink(KEY, 'download', token, NOW + 1000)).toEqual({ problem: 'expired' });
  });

  it('refuses another key, another purpose and malformed tokens', async () => {
    const { token } = await signLink(KEY, 'download', { user: 'u1' }, { now: NOW, ttlMs: 1000 });
    expect(await verifyLink('o'.repeat(32), 'download', token, NOW)).toEqual({ problem: 'bad signature' });
    expect(await verifyLink(KEY, 'upload', token, NOW)).toEqual({ problem: 'link made for something else' });
    for (const bad of [null, '', 'abc', `${token}x`, token.replace('.', '')]) {
      expect((await verifyLink(KEY, 'download', bad, NOW)).problem, String(bad)).toBeTruthy();
    }
  });

  it('treats a missing or short key as no key', async () => {
    for (const key of [undefined, '', 'short']) {
      await expect(signLink(key, 'download', {}, { now: NOW, ttlMs: 1 })).rejects.toBeInstanceOf(LinkKeyMissing);
      await expect(verifyLink(key, 'download', 'a.b', NOW)).rejects.toBeInstanceOf(LinkKeyMissing);
    }
  });

  it('counts uses per link, and forgets expired ones', async () => {
    await env.DB.prepare('DELETE FROM link_uses').run();
    const claims = { nonce: crypto.randomUUID(), user: 'u1', exp: NOW + 1000 };
    const uses = [];
    for (let use = 0; use < 4; use += 1) uses.push(await useLink(env.DB, claims, 3, NOW));
    expect(uses).toEqual([true, true, true, false]);
    expect(await useLink(env.DB, { ...claims, nonce: crypto.randomUUID() }, 3, NOW)).toBe(true);
    await useLink(env.DB, { nonce: crypto.randomUUID(), user: 'u1', exp: NOW + 5000 }, 3, NOW + 2000);
    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM link_uses').first();
    expect(n).toBe(1);
  });
});

describe('zipFiles', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes an archive that reads back, with UTF-8 names', async () => {
    const files = [
      { path: 'binders/Alphabetized.csv', text: 'Name\nSol Ring\n'.repeat(50) },
      { path: 'Glóin.txt', text: '1 Glóin, Dwarf Emissary\n' },
      { path: 'empty.txt', text: '' },
    ];
    const read = await unzip(await zipFiles(files, new Date(NOW)));
    expect(read).toEqual(Object.fromEntries(files.map((file) => [file.path, file.text])));
  });
});
