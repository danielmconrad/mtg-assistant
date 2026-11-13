// import_collection and import_binder: bringing cards in from ManaBox, Moxfield, Archidekt or Arena. A
// whole collection, or a file for one binder, goes through the upload page (src/uploads.mjs), where the
// person previews it and applies it; a pasted list goes straight into one binder. import_deck
// (imports.mjs) brings in decks.
import { z } from 'zod';
import { readConfig } from '../../config.mjs';
import { LinkKeyMissing, signLink } from '../../links.mjs';
import {
  applyCollectionChanges,
  entriesFor,
  planAdd,
  planReplace,
  replaceEvents,
} from '../../storage/collection-writes.mjs';
import { MAX_UPLOAD_PREVIEWS, UPLOAD_MODES, UPLOAD_PURPOSE, UPLOAD_TTL_MS } from '../../uploads.mjs';
import { deckLines, resolvedRows, targetCollection } from './collection-writes.mjs';
import { ToolError, textResult } from './shared.mjs';

const binderName = z.string().min(1).max(120);
const mode = z.enum(UPLOAD_MODES);

async function uploadLink(env, user, now, claims) {
  if (!env.UPLOADS) throw new ToolError('Uploads are not set up on this server yet.');
  let signed;
  try {
    signed = await signLink(
      env.UPLOAD_SIGNING_KEY,
      UPLOAD_PURPOSE,
      { user: user.id, ...claims },
      { now, ttlMs: UPLOAD_TTL_MS },
    );
  } catch (error) {
    if (error instanceof LinkKeyMissing) throw new ToolError('Uploads are not set up on this server yet.');
    throw error;
  }
  const url = new URL('/upload', readConfig(env).origin);
  url.searchParams.set('token', signed.token);
  return [
    'Import page:',
    url.toString(),
    `The link expires at ${new Date(signed.claims.exp).toISOString().slice(11, 16)} UTC (${UPLOAD_TTL_MS / 60_000} minutes) and opens only in a browser signed in through Cloudflare Access as ${user.email}. The page shows every change before anything is applied; it allows ${MAX_UPLOAD_PREVIEWS} previews.`,
  ];
}

async function importCollection(args, { user, env, now }) {
  const lines = await uploadLink(env, user, now, { target: 'collection', mode: args.mode });
  const effect =
    args.mode === 'replace'
      ? 'Replacing makes the collection exactly the file: each ManaBox binder becomes a binder, ManaBox decks become protected deck binders, and binders the file doesn’t have are removed.'
      : 'Merging adds each ManaBox binder’s cards to the binder of that name, creating new ones (ManaBox decks as protected deck binders).';
  return textResult([
    ...lines,
    `The person picks a ManaBox CSV export (5 MB at most). ${effect} Lists (wishlists) are left out, and built decks’ binders are never changed.`,
  ]);
}

async function importBinder(args, { db, user, env, now }) {
  if (!args.cards) {
    const lines = await uploadLink(env, user, now, { target: 'binder', collection: args.binder, mode: args.mode });
    return textResult([
      ...lines,
      'The person picks a ManaBox CSV export or a text list (5 MB at most) for the binder.',
    ]);
  }
  const { rows } = await resolvedRows(db, args.cards);
  const { collection, decks } = await targetCollection(db, user.id, args.binder, {
    create: args.create,
    isProtected: args.protected,
    now,
  });
  const entries = collection.isNew ? [] : await entriesFor(db, user.id, collection.id);
  const merge = args.mode === 'merge';
  const events = merge
    ? rows.map((row) => ({ name: row.name, scryfallId: row.scryfallId, finish: row.finish, change: row.quantity }))
    : replaceEvents(entries, rows);
  const change = { collection, plan: merge ? planAdd(entries, rows) : planReplace(entries, rows), events };
  if (!(await applyCollectionChanges(db, user.id, [change], { source: 'import_binder', note: args.note, now }))) {
    throw new ToolError(`${collection.name} changed while this was being saved; try again`);
  }
  const added = events.filter((event) => event.change > 0).reduce((sum, event) => sum + event.change, 0);
  const removed = events.filter((event) => event.change < 0).reduce((sum, event) => sum - event.change, 0);
  const label = `${collection.name}${collection.isNew ? ` (new${collection.protected ? ', protected' : ''})` : ''}`;
  return textResult([
    `${merge ? 'Merged into' : 'Replaced'} ${label}: +${added} -${removed} copies.`,
    ...deckLines(events, decks),
  ]);
}

const WRITES = { readOnlyHint: false, openWorldHint: false, idempotentHint: false, destructiveHint: true };

export const UPLOAD_TOOLS = [
  {
    name: 'import_collection',
    title: 'Import the whole collection',
    description:
      'A link, valid for 10 minutes, to a page where the person uploads a ManaBox CSV export of their whole collection, previews it and applies it. Each ManaBox binder becomes a binder (unprotected) and each ManaBox deck a protected deck binder; lists are left out. merge adds to existing binders; replace makes the collection exactly the file, removing binders it doesn’t have. Built decks’ binders are never changed. Use it for a fresh ManaBox export.',
    schema: z
      .object({
        mode: mode.default('replace').describe('replace (default): the collection becomes the file; merge: add it'),
      })
      .strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: importCollection,
  },
  {
    name: 'import_binder',
    title: 'Import a binder',
    description:
      'Bring one binder over from another app: fill it from a pasted list (Moxfield, Archidekt, Arena or ManaBox text lines), merged in or replacing the binder’s cards; or, without cards, a link to a page where the person uploads a file (ManaBox CSV or text list) for the binder. create: true starts a new binder. Built decks’ binders change only with their decks. Logged for collection_changes.',
    schema: z
      .object({
        binder: binderName.describe('The binder’s name, as collection_summary lists it'),
        cards: z
          .string()
          .min(1)
          .max(20_000)
          .optional()
          .describe('One card per line: 2 Sol Ring (C21) 263, *F* for foil; leave out for an upload link'),
        mode: mode.default('merge').describe('merge (default): add the cards; replace: the binder becomes the list'),
        create: z.boolean().default(false).describe('Start a new binder with this name'),
        protected: z.boolean().default(false).describe('With create: protect the new binder'),
        note: z.string().min(1).max(500).optional().describe('Why, for the change log'),
      })
      .strict(),
    annotations: WRITES,
    handler: importBinder,
  },
];
