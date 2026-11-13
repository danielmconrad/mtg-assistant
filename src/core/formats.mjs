// The deck formats this repo checks, and the other fixed vocabularies a deck.yaml uses. A new format
// goes here and in the schema's format enum; tests/consistency.test.mjs keeps the two in step.
//
// Each format gives its label in messages, its size (exact, including commanders) or minSize, its copy
// limit, whether it's played with commanders, the Scryfall legality key its cards must be legal under,
// and any price cap a deck without max_card_price gets.
export const FORMATS = {
  commander: { label: 'Commander', size: 100, copyLimit: 1, commanders: true, legality: 'commander' },
  // A house format: Commander's rules and card pool at 60 cards, with no card over 1 USD.
  'custom-dollar-brawl': {
    label: 'Custom Dollar Brawl',
    size: 60,
    copyLimit: 1,
    commanders: true,
    legality: 'commander',
    priceCap: { amount: 1, currency: 'USD' },
  },
  'casual-60': { label: 'Casual', minSize: 60, copyLimit: 4, commanders: false },
};

export const FORMAT_NAMES = Object.keys(FORMATS);

export const isCommanderFormat = (format) => FORMATS[format]?.commanders === true;

// Wizards' Commander Brackets, 1 (Exhibition) to 5 (cEDH).
export const BRACKETS = [1, 2, 3, 4, 5];

export const CURRENCIES = ['USD', 'EUR'];
