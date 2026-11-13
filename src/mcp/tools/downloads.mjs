// get_download_link: a short-lived signed link to a person's collection or one binder as files
// (src/downloads.mjs).
import { z } from 'zod';
import { readConfig } from '../../config.mjs';
import { DOWNLOAD_FORMATS, DOWNLOAD_PURPOSE, DOWNLOAD_TTL_MS, MAX_DOWNLOAD_USES } from '../../downloads.mjs';
import { LinkKeyMissing, signLink } from '../../links.mjs';
import { listCollections } from '../../storage/collections.mjs';
import { ToolError, textResult } from './shared.mjs';

const schema = z
  .object({
    binder: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('One binder’s name from collection_summary; the whole collection when left out'),
    format: z
      .enum(DOWNLOAD_FORMATS)
      .default('text')
      .describe(
        'text (default: a card list ManaBox, Moxfield and Arena import, as a collection or a deck), manabox_csv (keeps every ManaBox column, such as condition and language) or moxfield_csv (Moxfield collection import)',
      ),
    combine: z
      .boolean()
      .default(false)
      .describe(
        'For the whole collection: one file instead of a zip with a file per binder; a ManaBox CSV names each row’s binder in Binder Name',
      ),
    include_prices: z
      .boolean()
      .default(false)
      .describe('Include purchase prices, which are private; only when the person asks for them'),
  })
  .strict();

// The binders a request names: one by name, or every one.
async function chosenBinders(db, userId, args) {
  const binders = await listCollections(db, userId);
  if (!binders.length) throw new ToolError('No binders to download yet.');
  if (args.binder === undefined) return binders;
  if (args.combine) throw new ToolError('combine joins every binder; leave binder out');
  const chosen = binders.filter((binder) => binder.name === args.binder);
  if (!chosen.length) throw new ToolError(`No binder named ${args.binder}; collection_summary lists yours`);
  return chosen;
}

async function getDownloadLink(args, { db, user, env, now }) {
  const chosen = await chosenBinders(db, user.id, args);
  const all = args.binder === undefined;
  let signed;
  try {
    signed = await signLink(
      env.DOWNLOAD_SIGNING_KEY,
      DOWNLOAD_PURPOSE,
      {
        user: user.id,
        ...(all ? {} : { binder: args.binder }),
        format: args.format,
        prices: args.include_prices,
        ...(args.combine ? { combine: true } : {}),
      },
      { now, ttlMs: DOWNLOAD_TTL_MS },
    );
  } catch (error) {
    if (error instanceof LinkKeyMissing) throw new ToolError('Downloads are not set up on this server yet.');
    throw error;
  }
  const url = new URL('/download', readConfig(env).origin);
  url.searchParams.set('token', signed.token);
  const what = args.combine ? 'as one file' : 'as a zip with a file per binder';
  const lines = [
    `Download ${all ? `the whole collection (${chosen.length} binders) ${what}` : args.binder} (${args.format}${args.include_prices ? ', with purchase prices' : ''}):`,
    url.toString(),
    `The link expires at ${new Date(signed.claims.exp).toISOString().slice(11, 16)} UTC (${DOWNLOAD_TTL_MS / 60_000} minutes) and works ${MAX_DOWNLOAD_USES} times. It opens only in a browser signed in through Cloudflare Access as ${user.email}.`,
  ];
  const warnings = [];
  const unmatched = chosen.reduce((sum, binder) => sum + binder.unresolved_rows, 0);
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
      'A link, valid for 15 minutes, that downloads the person’s whole collection (a zip with a file per binder, or with combine one file) or one binder, as a text list (the default, which ManaBox imports), ManaBox CSV or Moxfield CSV. Give the person the link to open; purchase prices are left out unless they ask for them.',
    schema,
    handler: getDownloadLink,
  },
];
