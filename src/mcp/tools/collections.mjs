// collection_summary: mtg-manager's collection:check, read-only.
import { z } from 'zod';
import { ageInDays } from '../../core/card.mjs';
import { summarize } from '../../core/collection.mjs';
import { cacheStatusLine, collectionSummaryLine } from '../../core/format.mjs';
import { cardDataMeta } from '../../storage/cards.mjs';
import { loadCollections } from '../../storage/collections.mjs';
import { staleDataWarning, textResult } from './shared.mjs';

async function collectionSummary(_args, { db, user, now }) {
  const [collections, meta] = await Promise.all([loadCollections(db, user.id), cardDataMeta(db)]);
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
  if (!collections.sources.length) lines.push('No collections yet.');
  for (const { name, isProtected, rows } of collections.sources) {
    lines.push(collectionSummaryLine(name, isProtected, summarize(rows)));
    for (const row of rows.filter((candidate) => !candidate.scryfallId)) {
      warnings.push(`${row.location ?? name}: ${row.name} matches no printing in the card data`);
    }
  }
  return textResult(lines, warnings);
}

export const COLLECTION_TOOLS = [
  {
    name: 'collection_summary',
    title: 'Collection summary',
    description:
      "The person's collections: rows, copies and distinct cards in each, which are protected (reported but never used by decks), any rows that match no printing, and how fresh the card data is.",
    schema: z.object({}).strict(),
    handler: collectionSummary,
  },
];
