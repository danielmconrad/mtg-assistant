// Commander eligibility, shared by check_deck, build_deck, search_cards commanders_only, rank_commanders,
// import_deck and set_commanders: a legendary creature, a legendary Vehicle or Spacecraft with a printed
// power/toughness box (since Edge of Eternities), or a card that says it can be your commander, judged on
// the front face. Cards go through toCard, so this also checks where Scryfall's power and toughness are read.
import { describe, expect, it } from 'vitest';
import { canBeCommander, isCommanderEligible } from '../../src/core/card.mjs';
import { checkDeck } from '../../src/core/rules.mjs';
import { toCard } from '../../src/core/scryfall.mjs';
import { cardIndex } from '../../src/core/card-index.mjs';
import { scryfallCard } from '../fixtures/scryfall.mjs';

const BUILT = '2026-11-12T10:06:21.099Z';
const model = (name, fields) => toCard(scryfallCard(name, fields), BUILT, { defaultPrinting: true });

const hearthhull = model('Hearthhull, the Worldseed', {
  type_line: 'Legendary Artifact — Spacecraft',
  power: '6',
  toughness: '7',
});
const parhelion = model('Parhelion II', { type_line: 'Legendary Artifact — Vehicle', power: '5', toughness: '5' });
const copter = model("Smuggler's Copter", { type_line: 'Artifact — Vehicle', power: '3', toughness: '3' });
const elevator = model('The Eternity Elevator', { type_line: 'Legendary Artifact — Spacecraft' });
const legend = model('Ayula, Queen Among Bears', {
  type_line: 'Legendary Creature — Bear',
  power: '2',
  toughness: '2',
});
const legendaryArtifact = model('Legendary Trinket', { type_line: 'Legendary Artifact' });
const teferi = model('Teferi, Temporal Archmage', {
  type_line: 'Legendary Planeswalker — Teferi',
  oracle_text: 'Teferi, Temporal Archmage can be your commander.',
});
// Only the front face counts: a legendary Vehicle on the back doesn't make a commander, and one on the
// front reads its power and toughness from card_faces[0].
const vehicleBack = model('Plain Gadget // Legendary Ride', {
  type_line: undefined,
  card_faces: [
    { name: 'Plain Gadget', type_line: 'Artifact' },
    { name: 'Legendary Ride', type_line: 'Legendary Artifact — Vehicle', power: '4', toughness: '4' },
  ],
});
const vehicleFront = model('Legendary Ride // Plain Gadget', {
  type_line: undefined,
  card_faces: [
    { name: 'Legendary Ride', type_line: 'Legendary Artifact — Vehicle', power: '4', toughness: '4' },
    { name: 'Plain Gadget', type_line: 'Artifact' },
  ],
});

const ELIGIBLE = { hearthhull, parhelion, legend, teferi, vehicleFront };
const INELIGIBLE = { copter, elevator, legendaryArtifact, vehicleBack };

// check_deck's commander finding for a deck led by card alone.
function commanderErrors(card) {
  const deck = {
    schema_version: 1,
    name: 'Fixture',
    format: 'commander',
    status: 'draft',
    allow_proxies: false,
    primer: 'Test',
    commanders: [{ name: card.name, quantity: 1 }],
    mainboard: [],
  };
  const index = cardIndex({ version: 7, cards: { [card.id]: card } });
  const report = checkDeck(deck, { available: [], protected: [] }, index, { now: Date.parse(BUILT) });
  return report.findings.filter((item) => item.message.endsWith('not an eligible commander'));
}

describe('commander eligibility', () => {
  it('reads the front face’s power and toughness, or null without a box', () => {
    expect(hearthhull).toMatchObject({ power: '6', toughness: '7' });
    expect(vehicleFront).toMatchObject({ power: '4', toughness: '4' });
    expect(vehicleBack).toMatchObject({ power: null, toughness: null });
    expect(elevator).toMatchObject({ power: null, toughness: null });
  });

  it.each(Object.entries(ELIGIBLE))('accepts %s', (_, card) => {
    expect(isCommanderEligible(card)).toBe(true);
    expect(canBeCommander(card)).toBe(true);
    expect(commanderErrors(card)).toEqual([]);
  });

  it.each(Object.entries(INELIGIBLE))('refuses %s', (_, card) => {
    expect(isCommanderEligible(card)).toBe(false);
    expect(canBeCommander(card)).toBe(false);
    expect(commanderErrors(card).map((item) => item.message)).toEqual([`${card.name}: not an eligible commander`]);
  });

  it('refuses a legendary Vehicle from card data that predates power and toughness', () => {
    const stale = { ...parhelion, power: undefined, toughness: undefined };
    expect(isCommanderEligible(stale)).toBe(false);
  });
});
