// A SQL filter that narrows a card search before mtg-manager's own filters run on the result. It must
// match a superset of what searchCollection would keep, never fewer: every condition here is either
// exact or looser than its JavaScript counterpart in src/core/search.mjs.
const COLOR_BITS = { W: 1, U: 2, B: 4, R: 8, G: 16 };
// A regex with no special characters, in ASCII: SQLite's LIKE is case-insensitive only for ASCII, so
// only then is "contains this text, any case" a safe superset of the case-insensitive regex.
const PLAIN_ASCII = /^[\x20-\x7e]+$/;
const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/;

const likePattern = (text) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
const literalOf = (source) => (source && PLAIN_ASCII.test(source) && !REGEX_SPECIAL.test(source) ? source : null);

export function identityMask(letters) {
  return [...letters.toUpperCase()].reduce((mask, letter) => mask | (COLOR_BITS[letter] ?? 0), 0);
}

// Collects conditions and their bound values in order.
function conditionList() {
  const conditions = [];
  const params = [];
  return {
    add(sql, ...values) {
      conditions.push(sql);
      params.push(...values);
    },
    result: () => ({ sql: conditions.join(' AND '), params }),
  };
}

function addCardConditions(list, args, mask) {
  list.add('c.playable = 1');
  if (mask !== undefined) list.add('(c.color_identity & ~?) = 0', mask);
  else if (args.identity) list.add('(c.color_identity & ~?) = 0', identityMask(args.identity));
  const legal = args.legal ?? (args.commander ? 'commander' : undefined);
  if (legal) list.add('c.legalities LIKE ?', `%"${legal}":"legal"%`);
  if (args.min_mv !== undefined) list.add('c.mana_value >= ?', args.min_mv);
  if (args.max_mv !== undefined) list.add('c.mana_value <= ?', args.max_mv);
  if (args.game_changers) list.add('c.game_changer = 1');
  // GLOB is case-sensitive like String.includes, so this matches isLand exactly.
  if (args.nonland) list.add("c.front_type NOT GLOB '*Land*'");
  // canBeCommander: a legendary creature, a Background, or "can be your commander"; LIKE ignores case,
  // so this is a superset.
  if (args.commanders_only) {
    list.add(
      "(c.front_type LIKE '%Background%' OR (c.front_type LIKE '%Legendary%' AND c.front_type LIKE '%Creature%') OR c.oracle_text LIKE '%can be your commander%')",
    );
  }
}

function addTextConditions(list, args) {
  const literal = (sql, source) => {
    const text = literalOf(source);
    if (text) list.add(`${sql} LIKE ? ESCAPE '\\'`, likePattern(text));
  };
  literal('c.name', args.name);
  for (const source of args.type ?? []) literal('c.type_line', source);
  for (const source of args.text ?? []) literal('c.oracle_text', source);
}

// One printing must be in one of the sets and of one of the rarities, as matchingPrinting requires.
function addPrintingCondition(list, args) {
  const sets = (args.set ?? [])
    .flatMap((value) => value.split(','))
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);
  const rarities = args.rarity ?? [];
  if (!sets.length && !rarities.length) return;
  const marks = (values) => values.map(() => '?').join(', ');
  const printing = ['p.oracle_id = c.oracle_id'];
  if (sets.length) printing.push(`p.set_code IN (${marks(sets)})`);
  if (rarities.length) printing.push(`p.rarity IN (${marks(rarities)})`);
  list.add(`EXISTS (SELECT 1 FROM printings p WHERE ${printing.join(' AND ')})`, ...sets, ...rarities);
}

// args: the search tool's arguments, plus identityMask when a commander's identity is known.
export function searchPrefilter(args, { identityMask: mask } = {}) {
  const list = conditionList();
  addCardConditions(list, args, mask);
  addTextConditions(list, args);
  addPrintingCondition(list, args);
  return list.result();
}
