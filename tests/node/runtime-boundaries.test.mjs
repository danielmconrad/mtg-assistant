// The Worker's code (src/) runs in workerd, which has no Node built-ins unless nodejs_compat is on (it
// isn't). Catch a stray import before deploy rather than at runtime.
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { OUTPUT_PATH, generate } from '../../scripts/generate-deck-validator.mjs';

const files = (await readdir('src', { recursive: true })).filter((file) => file.endsWith('.mjs'));

describe('src/ runs in workerd', () => {
  it.each(files)('%s uses no Node built-ins, Node globals or runtime code generation', async (file) => {
    const source = await readFile(`src/${file}`, 'utf8');
    expect(source).not.toMatch(/from ['"]node:|require\(|\bprocess\.|\bBuffer\b|__dirname|new Function\(|\beval\(/);
  });
});

describe('the precompiled deck validator', () => {
  it('matches schemas/deck.schema.json (run node scripts/generate-deck-validator.mjs if not)', async () => {
    expect(await readFile(OUTPUT_PATH, 'utf8')).toBe(await generate());
  });
});
