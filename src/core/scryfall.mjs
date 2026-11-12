// The card model: one printing, in camelCase, translated from a Scryfall card object. Ported from
// mtg-manager's scripts/scryfall.mjs; foil and etched prices are new here, since collections track
// finishes.

// Translates a Scryfall card object into the card model, reading face data where double-faced and
// reversible cards leave top-level fields empty. defaultPrinting marks the printing Scryfall shows for
// the card's name, which only bulk data identifies. Every branch the complexity rule counts here is a
// `??` fallback in a flat field mapping, so splitting it would only hurt.
// eslint-disable-next-line complexity
export function toCard(scryfallCard, fetchedAt, { defaultPrinting = false } = {}) {
  const faces = scryfallCard.card_faces ?? [];
  const front = faces[0] ?? scryfallCard;
  return {
    id: scryfallCard.id,
    oracleId: scryfallCard.oracle_id ?? front.oracle_id,
    name: scryfallCard.name,
    frontName: front.name ?? scryfallCard.name,
    set: scryfallCard.set,
    collectorNumber: scryfallCard.collector_number,
    manaCost: scryfallCard.mana_cost ?? front.mana_cost ?? '',
    manaValue: scryfallCard.cmc ?? front.cmc ?? 0,
    typeLine: scryfallCard.type_line ?? faces.map((face) => face.type_line).join(' // '),
    frontType: front.type_line ?? '',
    flavorName: scryfallCard.flavor_name ?? front.flavor_name ?? null,
    oracleText: scryfallCard.oracle_text ?? faces.map((face) => face.oracle_text ?? '').join('\n'),
    keywords: scryfallCard.keywords ?? [],
    colorIdentity: scryfallCard.color_identity ?? [],
    producedMana: scryfallCard.produced_mana ?? [],
    legalities: scryfallCard.legalities ?? {},
    gameChanger: scryfallCard.game_changer === true,
    // Gold borders and memorabilia sets mark printings that aren't legal to play; see isPlayablePrinting.
    borderColor: scryfallCard.border_color ?? null,
    setType: scryfallCard.set_type ?? null,
    // The printing's rarity (common, uncommon, rare, mythic, special or bonus).
    rarity: scryfallCard.rarity ?? null,
    // Popularity on EDHREC (1 is the most played card), the same for every printing; null when unranked.
    edhrecRank: scryfallCard.edhrec_rank ?? null,
    prices: {
      usd: scryfallCard.prices?.usd ?? null,
      usdFoil: scryfallCard.prices?.usd_foil ?? null,
      usdEtched: scryfallCard.prices?.usd_etched ?? null,
      eur: scryfallCard.prices?.eur ?? null,
    },
    defaultPrinting,
    fetchedAt,
  };
}
