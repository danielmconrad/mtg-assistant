import { roleLabels } from './deck.mjs';

// Paste-ready decklists. Each format receives the deck and printingOf(entry), which returns the
// cached printing to export for an entry, or null so the site picks its default printing. Optional
// deck.upgradesIn lists deck cards an applied upgrade added. Optional deck.swapOut lists cards the
// upgrades would cut and deck.considering cards they would add; both stay outside the deck, as the
// Sideboard and Considering sections in Moxfield and the Sideboard and Maybeboard categories in Archidekt.

// Picks each entry's printing: its pinned scryfall_id, else the non-proxy printing with the most
// copies in the given collection rows (the earliest row wins a tie), else any cached printing.
// Names with no printing are added to missing.
export function printingChooser(index, ownedRows, missing = new Set()) {
  const copiesById = new Map();
  for (const row of ownedRows) {
    if (!row.isProxy) copiesById.set(row.scryfallId, (copiesById.get(row.scryfallId) ?? 0) + row.quantity);
  }
  const ownedPrintings = new Map();
  for (const [id, copies] of copiesById) {
    const card = index.byId.get(id);
    const best = card && ownedPrintings.get(card.oracleId);
    if (card && (!best || copies > best.copies)) ownedPrintings.set(card.oracleId, { card, copies });
  }
  return (entry) => {
    if (entry.scryfall_id) {
      const pinned = index.byId.get(entry.scryfall_id);
      if (!pinned) missing.add(entry.name);
      return pinned ?? null;
    }
    const { card } = index.lookup(entry);
    if (!card) missing.add(entry.name);
    return card ? (ownedPrintings.get(card.oracleId)?.card ?? card) : null;
  };
}

const titleCase = (label) => label.replace(/\b\w/g, (letter) => letter.toUpperCase());

const printingSuffix = (card) => (card ? ` (${card.set.toUpperCase()}) ${card.collectorNumber}` : '');

function plainText(deck) {
  const render = (entries) => entries.map((entry) => `${entry.quantity} ${entry.name}`).join('\n');
  const commanderSection = deck.commanders.length ? `Commander\n${render(deck.commanders)}\n\n` : '';
  const section = (heading, entries) => (entries?.length ? `\n\n${heading}\n${render(entries)}` : '');
  const extraSections =
    section('Upgrades', deck.upgradesIn) + section('Swap Out', deck.swapOut) + section('Considering', deck.considering);
  return `${commanderSection}${render(deck.mainboard)}${extraSections}\n`;
}

// MTG Arena's layout, which Moxfield accepts as a pasted list.
function moxfield(deck, printingOf) {
  const line = (entry) => `${entry.quantity} ${entry.name}${printingSuffix(printingOf(entry))}`;
  const section = (heading, entries) => [heading, ...entries.map(line)].join('\n');
  const optional = (heading, entries) => (entries?.length ? [section(heading, entries)] : []);
  const sections = [
    ...optional('Commander', deck.commanders),
    section('Deck', [...deck.mainboard, ...(deck.upgradesIn ?? [])]),
    ...optional('Sideboard', deck.swapOut),
    ...optional('Considering', deck.considering),
  ];
  return `${sections.join('\n\n')}\n`;
}

// The cards a Moxfield list holds as the deck (Commander, Deck and the Sideboard of upgrade cuts), as
// sorted "quantity name" lines without printings, so a new collection export or a changed upgrade
// doesn't count as a different list. Considering, the upgrade adds, is left out.
export function moxfieldCardList(text) {
  const quantities = new Map();
  for (const block of text.trim().split(/\n\s*\n/)) {
    const [heading, ...lines] = block.split('\n');
    if (heading === 'Considering') continue;
    for (const line of lines) {
      const [, quantity, name] = line.match(/^(\d+) (.+?)(?: \([A-Z0-9]+\) \S+)?$/) ?? [];
      if (name) quantities.set(name, (quantities.get(name) ?? 0) + Number(quantity));
    }
  }
  return [...quantities].map(([name, quantity]) => `${quantity} ${name}`).sort();
}

// Archidekt's line syntax: categories in brackets, with roles becoming Title Case categories
// ("ramp" becomes "Ramp"). {top} marks Commander as a premier category so Archidekt treats those
// cards as the commanders. Upgrade is a plain category, so those cards still count toward the deck;
// it comes first so it is the card's primary category, then its roles. Sideboard and Maybeboard are
// Archidekt's built-in categories for cards outside the deck, so they stand alone.
function archidekt(deck, printingOf) {
  const line = (entry, categories) => {
    const tags = categories.length ? ` [${categories.join(',')}]` : '';
    return `${entry.quantity}x ${entry.name}${printingSuffix(printingOf(entry))}${tags}`;
  };
  const lines = [
    ...deck.commanders.map((entry) => line(entry, ['Commander{top}'])),
    ...deck.mainboard.map((entry) => line(entry, roleLabels(entry).map(titleCase))),
    ...(deck.upgradesIn ?? []).map((entry) => line(entry, ['Upgrade', ...roleLabels(entry).map(titleCase)])),
    ...(deck.swapOut ?? []).map((entry) => line(entry, ['Sideboard'])),
    ...(deck.considering ?? []).map((entry) => line(entry, ['Maybeboard'])),
  ];
  return `${lines.join('\n')}\n`;
}

const EXPORT_FORMATS = { text: plainText, moxfield, archidekt };

export const EXPORT_FORMAT_NAMES = Object.keys(EXPORT_FORMATS);

export const PASTE_HINTS = {
  text: 'Plain list; most deck sites accept it, but commander handling varies.',
  moxfield: 'In Moxfield, create a deck and paste into Import, or replace an existing list with Bulk Edit.',
  archidekt: "In Archidekt, open a deck's Import menu, paste, and save.",
};

export function exportDeck(deck, { format = 'text', printingOf = () => null } = {}) {
  if (!Object.hasOwn(EXPORT_FORMATS, format)) {
    throw new Error(`--format must be one of: ${Object.keys(EXPORT_FORMATS).join(', ')}`);
  }
  return EXPORT_FORMATS[format](deck, printingOf);
}
