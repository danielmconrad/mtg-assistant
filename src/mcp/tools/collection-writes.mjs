// add_cards, remove_cards and collection_changes: changing a person's collections by text list, and
// what changed since a date (mtg-manager's collection:diff, read from the change log rather than Git).
import { z } from 'zod';
import { normalizeName } from '../../core/card.mjs';
import { decksNaming } from '../../core/collection-diff.mjs';
import { parseTextCollection, resolveTextRows } from '../../core/collection.mjs';
import { isActiveDeck } from '../../core/deck.mjs';
import { collectionDiffLines } from '../../core/format.mjs';
import { cardIndexFor, loadCardRows, nameSuggester } from '../../storage/cards.mjs';
import {
  applyCollectionChanges,
  collectionEvents,
  entriesFor,
  isValidCollectionName,
  newTextCollection,
  planAdd,
  planRemove,
} from '../../storage/collection-writes.mjs';
import { listCollections } from '../../storage/collections.mjs';
import { loadAllDecks } from '../../storage/decks.mjs';
import { ToolError, textResult } from './shared.mjs';

const MAX_LIST_CHARS = 20_000;
const DEFAULT_DAYS = 30;
const BATCHES_SHOWN = 20;
const collectionName = z.string().min(1).max(120).describe('A collection’s name, as collection_summary lists it');
const cardList = z
  .string()
  .min(1)
  .max(MAX_LIST_CHARS)
  .describe('One card per line, as Moxfield, Archidekt and Arena export: 2 Sol Ring (C21) 263, with *F* for foil');
const note = z.string().min(1).max(500).optional().describe('Why, for the change log (e.g. "Bought at the LGS")');

const copiesOf = (count) => `${count} ${count === 1 ? 'copy' : 'copies'}`;

// The text list's rows, each matched to a printing (a line with SET NUMBER) or a card (a name alone).
// Lines that match nothing are refused, with suggestions. The upload page reads text files with it too.
export async function resolvedRows(db, text, source = 'cards') {
  let rows;
  try {
    rows = parseTextCollection(text, source);
  } catch (error) {
    throw new ToolError(error.message);
  }
  const printings = rows.filter((row) => row.set).map(({ set, collectorNumber }) => ({ set, collectorNumber }));
  const { index } = await cardIndexFor(db, await loadCardRows(db, { names: rows.map((row) => row.name), printings }));
  let resolved;
  try {
    resolved = resolveTextRows(rows, index);
  } catch (error) {
    throw new ToolError(error.message);
  }
  const unmatched = resolved.filter((row) => !row.scryfallId);
  if (unmatched.length) {
    const suggest = await nameSuggester(db);
    throw new ToolError(
      unmatched
        .map((row) => {
          if (row.set) {
            return `${row.location}: no ${row.set.toUpperCase()} ${row.collectorNumber} printing of ${row.name}`;
          }
          const suggestions = suggest(row.name);
          return `${row.location}: no card named ${row.name}${suggestions.length ? `; did you mean ${suggestions.join(', ')}?` : ''}`;
        })
        .join('\n'),
    );
  }
  return { rows: resolved, index };
}

// The collection to change. A deck's own list (collection_destination) changes only with its deck, through
// the physical-deck tools. A new one is a text list unless format says otherwise (an uploaded CSV).
export async function targetCollection(db, userId, name, { create, now, format }) {
  const collections = await listCollections(db, userId);
  const existing = collections.find((collection) => collection.name === name);
  const decks = await loadAllDecks(db, userId);
  if (existing) {
    const builtInto = decks.find(({ deck }) => deck.collection_destination === existing.path);
    if (builtInto) {
      throw new ToolError(`${name} holds the built deck ${builtInto.slug}; its cards change only with that deck`);
    }
    return { collection: existing, decks };
  }
  if (!create) {
    const names = collections.map((collection) => collection.name).join(', ') || 'none yet';
    throw new ToolError(`No collection named ${name} (yours: ${names}); pass create: true to start a new text list`);
  }
  if (!isValidCollectionName(name)) {
    throw new ToolError(
      `${name} can't be a collection name: use folders and names of letters, digits, spaces, dots, underscores and hyphens`,
    );
  }
  return { collection: newTextCollection(name, now, format), decks };
}

async function saved(db, userId, change, context) {
  if (!(await applyCollectionChanges(db, userId, [change], context))) {
    throw new ToolError(`${change.collection.name} changed while this was being saved; try again`);
  }
}

// The changed cards' decks, as collection_changes reports them.
function deckLines(events, decks) {
  const changes = [{ cards: events.map(({ name, change }) => ({ name, change })) }];
  const naming = decksNaming(
    changes,
    decks.filter(({ deck }) => isActiveDeck(deck)),
  );
  return naming.map(({ deck, cards }) => `${deck} names ${cards.join(', ')}`);
}

const finishNote = (finish) => (finish === 'normal' ? '' : ` (${finish})`);

async function addCards(args, { db, user, now }) {
  const { rows } = await resolvedRows(db, args.cards);
  const { collection, decks } = await targetCollection(db, user.id, args.collection, { create: args.create, now });
  const entries = collection.isNew ? [] : await entriesFor(db, user.id, collection.id);
  const plan = planAdd(entries, rows);
  const events = rows.map((row) => ({
    name: row.name,
    scryfallId: row.scryfallId,
    finish: row.finish,
    change: row.quantity,
  }));
  await saved(db, user.id, { collection, plan, events }, { source: 'add_cards', note: args.note, now });
  const copies = rows.reduce((sum, row) => sum + row.quantity, 0);
  return textResult([
    `Added ${copiesOf(copies)} to ${collection.name}${collection.isNew ? ` (new${collection.protected ? ', protected' : ''})` : ''}: ${rows.map((row) => `+${row.quantity} ${row.name}${finishNote(row.finish)}`).join(', ')}.`,
    ...deckLines(events, decks),
  ]);
}

// Which rows a line takes copies from. A line with SET NUMBER takes that printing in its finish; a name
// alone takes the card in whatever printing the collection holds, if it holds only one printing and finish.
function rowsForLine(row, entries, index) {
  const target = index.byId.get(row.scryfallId).oracleId;
  const matches = row.set
    ? entries.filter((entry) => entry.scryfall_id === row.scryfallId && entry.finish === row.finish)
    : entries.filter((entry) => entry.oracle_id === target);
  const kinds = new Set(matches.map((entry) => `${entry.scryfall_id}|${entry.finish}`));
  if (!row.set && kinds.size > 1) {
    const options = [
      ...new Set(
        matches.map(
          (entry) =>
            `${entry.set_code?.toUpperCase() ?? '?'} ${entry.collector_number ?? '?'}${entry.finish === 'normal' ? '' : ` ${entry.finish}`}`,
        ),
      ),
    ];
    throw new ToolError(
      `${row.location}: ${row.name} is held in several printings (${options.join('; ')}); name one as (SET) NUMBER, with *F* for foil`,
    );
  }
  return matches;
}

async function removeCards(args, { db, user, now }) {
  const { rows, index } = await resolvedRows(db, args.cards);
  const { collection, decks } = await targetCollection(db, user.id, args.collection, { create: false, now });
  const entries = await entriesFor(db, user.id, collection.id);
  const left = new Map(entries.map((entry) => [entry.id, entry.quantity]));
  const takes = [];
  const problems = [];
  for (const row of rows) {
    let wanted = row.quantity;
    for (const entry of rowsForLine(row, entries, index)) {
      const quantity = Math.min(wanted, left.get(entry.id));
      if (!quantity) continue;
      takes.push({ entry, quantity });
      left.set(entry.id, left.get(entry.id) - quantity);
      wanted -= quantity;
      if (!wanted) break;
    }
    if (wanted) {
      problems.push(
        `${row.location}: ${collection.name} has ${row.quantity - wanted} of the ${row.quantity} ${row.name} to remove`,
      );
    }
  }
  if (problems.length) throw new ToolError(problems.join('\n'));
  const events = takes.map(({ entry, quantity }) => ({
    name: entry.name,
    scryfallId: entry.scryfall_id,
    finish: entry.finish,
    change: -quantity,
  }));
  await saved(
    db,
    user.id,
    { collection, plan: planRemove(takes), events },
    { source: 'remove_cards', note: args.note, now },
  );
  const copies = takes.reduce((sum, take) => sum + take.quantity, 0);
  return textResult([
    `Removed ${copiesOf(copies)} from ${collection.name}: ${takes.map(({ entry, quantity }) => `-${quantity} ${entry.name}${finishNote(entry.finish)}`).join(', ')}.`,
    ...deckLines(events, decks),
  ]);
}

// Net change per collection and card since the date, in collection:diff's shape.
function netChanges(events) {
  const byCollection = new Map();
  for (const { collection_name: collection, name, change } of events) {
    const cards = byCollection.get(collection) ?? new Map();
    const key = normalizeName(name);
    const card = cards.get(key) ?? { name, change: 0 };
    card.change += change;
    cards.set(key, card);
    byCollection.set(collection, cards);
  }
  return [...byCollection]
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([collection, cards]) => ({
      collection,
      status: 'changed',
      cards: [...cards.values()]
        .filter(({ change }) => change)
        .sort((first, second) => first.name.localeCompare(second.name)),
    }))
    .filter(({ cards }) => cards.length);
}

// Each change made (one tool call or upload), newest first.
function batchLines(events) {
  const batches = new Map();
  for (const event of events) {
    const batch = batches.get(event.batch_id) ?? { ...event, added: 0, removed: 0, collections: new Set() };
    if (event.change > 0) batch.added += event.change;
    else batch.removed -= event.change;
    batch.collections.add(event.collection_name);
    batches.set(event.batch_id, batch);
  }
  const newest = [...batches.values()].reverse();
  const lines = newest.slice(0, BATCHES_SHOWN).map((batch) => {
    const counts = [batch.added && `+${batch.added}`, batch.removed && `-${batch.removed}`].filter(Boolean).join(' ');
    const why = batch.note ? ` — ${batch.note}` : '';
    return `  ${batch.at.slice(0, 16).replace('T', ' ')} ${batch.source}, ${[...batch.collections].join(', ')}: ${counts}${why}`;
  });
  if (newest.length > BATCHES_SHOWN) lines.push(`  and ${newest.length - BATCHES_SHOWN} earlier changes`);
  return lines.length ? ['Changes made through MTG Assistant (UTC), newest first:', ...lines] : [];
}

async function collectionChanges(args, { db, user, now }) {
  const since = args.since ?? new Date(now - DEFAULT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [events, decks] = await Promise.all([
    collectionEvents(db, user.id, { since: `${since}T00:00:00.000Z`, collection: args.collection }),
    loadAllDecks(db, user.id),
  ]);
  const changes = netChanges(events);
  const naming = decksNaming(
    changes,
    decks.filter(({ deck }) => isActiveDeck(deck)),
  );
  return textResult(
    [...collectionDiffLines(since, changes, naming), ...batchLines(events)],
    [
      'Only changes made through MTG Assistant are logged; collections migrated from mtg-manager have no earlier history.',
    ],
  );
}

const WRITES = { readOnlyHint: false, openWorldHint: false, idempotentHint: false };

export const COLLECTION_WRITE_TOOLS = [
  {
    name: 'add_cards',
    title: 'Add cards to a collection',
    description:
      'Add copies to one of the person’s collections from a short text list (Moxfield/Archidekt/Arena lines), after they say they’ve got the cards. Every line must match a card; set and number pin the printing. create: true starts a new text list. Logged for collection_changes.',
    schema: z
      .object({ collection: collectionName, cards: cardList, create: z.boolean().default(false), note })
      .strict(),
    annotations: { ...WRITES, destructiveHint: false },
    handler: addCards,
  },
  {
    name: 'remove_cards',
    title: 'Remove cards from a collection',
    description:
      'Remove copies from one of the person’s collections (sold, traded, lost), from a short text list. A name alone works when the collection holds that card in one printing; otherwise give (SET) NUMBER and *F* for foil. Nothing is removed unless every line can be. Logged for collection_changes.',
    schema: z.object({ collection: collectionName, cards: cardList, note }).strict(),
    annotations: { ...WRITES, destructiveHint: true },
    handler: removeCards,
  },
  {
    name: 'collection_changes',
    title: 'Collection changes',
    description:
      'What changed in the person’s collections since a date (default 30 days): net copies per card per collection, the decks naming changed cards, and each change made, with its note.',
    schema: z
      .object({
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD'),
        collection: collectionName.optional(),
      })
      .strict(),
    handler: collectionChanges,
  },
];
