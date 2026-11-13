// get_download_link: a short-lived signed link to a person's collections as files (src/downloads.mjs).
import { z } from 'zod';
import { readConfig } from '../../config.mjs';
import {
  ALL_COLLECTIONS,
  DOWNLOAD_FORMATS,
  DOWNLOAD_PURPOSE,
  DOWNLOAD_TTL_MS,
  MAX_DOWNLOAD_USES,
} from '../../downloads.mjs';
import { LinkKeyMissing, signLink } from '../../links.mjs';
import { listCollections } from '../../storage/collections.mjs';
import { ToolError, textResult } from './shared.mjs';

const schema = z
  .object({
    collection: z
      .string()
      .min(1)
      .max(200)
      .describe(`A collection's name from collection_summary, or "${ALL_COLLECTIONS}" for every collection as a zip`),
    format: z
      .enum(DOWNLOAD_FORMATS)
      .default('manabox_csv')
      .describe(
        'manabox_csv (default; keeps every ManaBox column), moxfield_csv (Moxfield collection import) or text (a card list)',
      ),
    include_prices: z
      .boolean()
      .default(false)
      .describe('Include purchase prices, which are private; only when the person asks for them'),
  })
  .strict();

async function getDownloadLink(args, { db, user, env, now }) {
  const collections = await listCollections(db, user.id);
  if (!collections.length) throw new ToolError('No collections to download yet.');
  const all = args.collection === ALL_COLLECTIONS;
  const chosen = all ? collections : collections.filter((collection) => collection.name === args.collection);
  if (!chosen.length) throw new ToolError(`No collection named ${args.collection}; collection_summary lists yours`);
  let signed;
  try {
    signed = await signLink(
      env.DOWNLOAD_SIGNING_KEY,
      DOWNLOAD_PURPOSE,
      { user: user.id, collection: args.collection, format: args.format, prices: args.include_prices },
      { now, ttlMs: DOWNLOAD_TTL_MS },
    );
  } catch (error) {
    if (error instanceof LinkKeyMissing) throw new ToolError('Downloads are not set up on this server yet.');
    throw error;
  }
  const url = new URL('/download', readConfig(env).origin);
  url.searchParams.set('token', signed.token);
  const lines = [
    `Download ${all ? `every collection (${chosen.length}) as a zip` : args.collection} (${args.format}${args.include_prices ? ', with purchase prices' : ''}):`,
    url.toString(),
    `The link expires at ${new Date(signed.claims.exp).toISOString().slice(11, 16)} UTC (${DOWNLOAD_TTL_MS / 60_000} minutes) and works ${MAX_DOWNLOAD_USES} times. It opens only in a browser signed in through Cloudflare Access as ${user.email}.`,
  ];
  const warnings = [];
  const unmatched = chosen.reduce((sum, collection) => sum + collection.unresolved_rows, 0);
  if (args.format === 'manabox_csv' && unmatched) {
    warnings.push(
      `${unmatched} rows match no printing and can't be written as ManaBox rows, so they're left out; format text keeps them`,
    );
  }
  return textResult(lines, warnings);
}

export const DOWNLOAD_TOOLS = [
  {
    name: 'get_download_link',
    title: 'Download link',
    description:
      'A link, valid for 15 minutes, that downloads one of the person’s collections, or all of them as a zip, as a ManaBox CSV, Moxfield CSV or text list. Give the person the link to open; purchase prices are left out unless they ask for them.',
    schema,
    handler: getDownloadLink,
  },
];
