// collection_summary (mtg-manager's collection:check, read-only) and update_binder. A person's collection
// is every card in their binders; deck binders hold a deck's physical cards.
import { z } from 'zod';
import { ageInDays } from '../../core/card.mjs';
import { summarize } from '../../core/collection.mjs';
import { cacheStatusLine } from '../../core/format.mjs';
import { cardDataMeta } from '../../storage/cards.mjs';
import { BINDER_NAME_RULE, isValidBinderName, saveBinderSettings } from '../../storage/collection-writes.mjs';
import { listCollections, loadCollections } from '../../storage/collections.mjs';
import { loadAllDecks } from '../../storage/decks.mjs';
import { ToolError, staleDataWarning, textResult } from './shared.mjs';

const binderName = z.string().min(1).max(120).describe('A binder’s name, as collection_summary lists it');

const binderLine = (name, { kind, isProtected }, { copies, distinctNames, proxyCopies }) => {
  const labels = [kind === 'deck' && 'deck', isProtected && 'protected'].filter(Boolean);
  const proxies = proxyCopies ? `, ${proxyCopies} proxies` : '';
  return `  ${name}${labels.length ? ` (${labels.join(', ')})` : ''}: ${copies} copies, ${distinctNames} distinct cards${proxies}`;
};

async function collectionSummary(_args, { db, user, now }) {
  const [collections, listed, meta] = await Promise.all([
    loadCollections(db, user.id),
    listCollections(db, user.id),
    cardDataMeta(db),
  ]);
  const status = {
    printings: meta.printingCount,
    cards: meta.cardCount,
    fromBulk: true,
    bulkBuiltAt: meta.builtAt,
    refreshedAt: meta.ingestedAt,
    daysSinceRefresh: meta.ingestedAt ? Math.floor(ageInDays({ fetchedAt: meta.ingestedAt }, now)) : null,
  };
  const lines = [cacheStatusLine(status).replace('Card cache:', 'Card data:')];
  const warnings = [staleDataWarning(meta, now)].filter(Boolean);
  if (!collections.sources.length) return textResult([...lines, 'No binders yet.'], warnings);
  const all = summarize(collections.sources.flatMap((source) => source.rows));
  const protectedCount = collections.sources.filter((source) => source.isProtected).length;
  lines.push(
    `Collection: ${all.copies} copies, ${all.distinctNames} distinct cards in ${collections.sources.length} binders (${protectedCount} protected: reported, but never used by other decks).`,
  );
  const kinds = new Map(listed.map((binder) => [binder.name, binder.kind]));
  for (const { name, isProtected, rows } of collections.sources) {
    lines.push(binderLine(name, { kind: kinds.get(name), isProtected }, summarize(rows)));
    for (const row of rows.filter((candidate) => !candidate.scryfallId)) {
      warnings.push(`${row.location ?? name}: ${row.name} matches no printing in the card data`);
    }
  }
  return textResult(lines, warnings);
}

function checkRequest(args) {
  if (args.delete && (args.rename || args.protected !== undefined)) {
    throw new ToolError('Delete a binder on its own, without rename or protected');
  }
  if (!args.delete && !args.rename && args.protected === undefined) {
    throw new ToolError('Pass rename, protected or delete');
  }
}

// The binder to change, refusing a built deck's binder, a delete that isn't empty and a taken new name.
async function changeableBinder(db, userId, args) {
  const binders = await listCollections(db, userId);
  const binder = binders.find((candidate) => candidate.name === args.binder);
  if (!binder) throw new ToolError(`No binder named ${args.binder}; collection_summary lists yours`);
  const builtFor = (await loadAllDecks(db, userId)).find(({ deck }) => deck.collection_destination === binder.path);
  if (builtFor) {
    throw new ToolError(
      `${binder.name} holds the built deck ${builtFor.slug}; it stays as it is until teardown_deck takes the deck apart`,
    );
  }
  if (args.delete && binder.row_count) {
    throw new ToolError(`${binder.name} still holds ${binder.copies} copies; move or remove them first`);
  }
  if (args.rename && !isValidBinderName(args.rename)) {
    throw new ToolError(`${args.rename} can't be a binder name: ${BINDER_NAME_RULE}`);
  }
  if (args.rename && binders.some((other) => other.name === args.rename)) {
    throw new ToolError(`A binder named ${args.rename} already exists`);
  }
  return binder;
}

async function updateBinder(args, { db, user, now }) {
  checkRequest(args);
  const binder = await changeableBinder(db, user.id, args);
  const name = args.rename ?? binder.name;
  const isProtected = args.protected ?? binder.protected === 1;
  if (!(await saveBinderSettings(db, user.id, binder, { name, isProtected, remove: args.delete, now }))) {
    throw new ToolError(`${binder.name} changed while this was being saved; try again`);
  }
  if (args.delete) return textResult([`Deleted the empty binder ${binder.name}.`]);
  const changes = [
    name !== binder.name && `renamed to ${name}`,
    isProtected !== (binder.protected === 1) && (isProtected ? 'now protected' : 'no longer protected'),
  ].filter(Boolean);
  return textResult([`${binder.name}: ${changes.join(', ') || 'unchanged'}.`]);
}

export const COLLECTION_TOOLS = [
  {
    name: 'collection_summary',
    title: 'Collection summary',
    description:
      "The person's collection (every card they own) and the binders it's in: copies and distinct cards in each, which are deck binders (a deck's physical cards) and which are protected (reported, but never used by other decks), any rows that match no printing, and how fresh the card data is.",
    schema: z.object({}).strict(),
    handler: collectionSummary,
  },
  {
    name: 'update_binder',
    title: 'Rename, protect or delete a binder',
    description:
      'Rename one of the person’s binders, protect it (its cards are reported but never used by other decks, as for precons) or unprotect it, or delete it once it’s empty. A built deck’s binder changes only through the physical-deck tools.',
    schema: z
      .object({
        binder: binderName,
        rename: z.string().min(1).max(120).optional().describe('The new name'),
        protected: z.boolean().optional(),
        delete: z.boolean().default(false).describe('Delete the binder; it must be empty'),
      })
      .strict(),
    annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: true },
    handler: updateBinder,
  },
];
