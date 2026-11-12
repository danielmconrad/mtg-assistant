// Scryfall-shaped card objects for tests: only the fields toCard reads. IDs derive from the name.
const NOT_LEGAL_EVERYWHERE = { standard: 'not_legal', commander: 'not_legal', oldschool: 'not_legal' };

export function scryfallCard(name, fields = {}) {
  const slug = name.toLowerCase().replace(/\W+/g, '-');
  return {
    id: `${slug}-print`,
    oracle_id: `${slug}-oracle`,
    name,
    set: 'tst',
    set_type: 'expansion',
    collector_number: '1',
    rarity: 'common',
    border_color: 'black',
    mana_cost: '',
    cmc: 0,
    type_line: 'Sorcery',
    oracle_text: '',
    keywords: [],
    color_identity: [],
    produced_mana: [],
    legalities: { ...NOT_LEGAL_EVERYWHERE, commander: 'legal' },
    game_changer: false,
    edhrec_rank: 100,
    prices: { usd: '1.00', usd_foil: '3.50', usd_etched: null, eur: '0.90' },
    ...fields,
  };
}

export const tokenCard = (name) =>
  scryfallCard(name, { type_line: 'Token Creature — Goblin', legalities: NOT_LEGAL_EVERYWHERE, edhrec_rank: null });
