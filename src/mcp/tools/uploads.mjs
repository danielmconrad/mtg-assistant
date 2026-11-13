// get_upload_link: a short-lived signed link to the upload page (src/uploads.mjs), where the person
// previews a ManaBox CSV or text list against one collection and applies it.
import { z } from 'zod';
import { readConfig } from '../../config.mjs';
import { LinkKeyMissing, signLink } from '../../links.mjs';
import { MAX_UPLOAD_PREVIEWS, UPLOAD_PURPOSE, UPLOAD_TTL_MS } from '../../uploads.mjs';
import { ToolError, textResult } from './shared.mjs';

const schema = z
  .object({
    collection: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe('The collection to fill in on the page (the person can change it); a new name starts a new one'),
  })
  .strict();

async function getUploadLink(args, { user, env, now }) {
  if (!env.UPLOADS) throw new ToolError('Uploads are not set up on this server yet.');
  let signed;
  try {
    signed = await signLink(
      env.UPLOAD_SIGNING_KEY,
      UPLOAD_PURPOSE,
      { user: user.id, ...(args.collection ? { collection: args.collection } : {}) },
      { now, ttlMs: UPLOAD_TTL_MS },
    );
  } catch (error) {
    if (error instanceof LinkKeyMissing) throw new ToolError('Uploads are not set up on this server yet.');
    throw error;
  }
  const url = new URL('/upload', readConfig(env).origin);
  url.searchParams.set('token', signed.token);
  return textResult([
    'Upload page:',
    url.toString(),
    `The link expires at ${new Date(signed.claims.exp).toISOString().slice(11, 16)} UTC (${UPLOAD_TTL_MS / 60_000} minutes) and opens only in a browser signed in through Cloudflare Access as ${user.email}. The page takes a ManaBox CSV export or a text list (5 MB at most), merges it into a collection or replaces one, and shows the changes before anything is applied; it allows ${MAX_UPLOAD_PREVIEWS} previews.`,
  ]);
}

export const UPLOAD_TOOLS = [
  {
    name: 'get_upload_link',
    title: 'Upload link',
    description:
      'A link, valid for 10 minutes, to a page where the person uploads a ManaBox CSV export or a text list to merge into a collection or replace it. The page shows what would change and applies it only when they confirm. Use it for big changes, such as a fresh ManaBox export; add_cards and remove_cards suit a few cards.',
    schema,
    handler: getUploadLink,
  },
];
