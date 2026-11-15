// A SQL filter that narrows a card search before mtg-manager's own filters run on the result. It must
// match a superset of what searchCollection would keep, never fewer: every condition here is either
// exact or looser than its JavaScript counterpart in src/core/search.mjs.
const COLOR_BITS = { W: 1, U: 2, B: 4, R: 8, G: 16 };
// SQLite's LIKE is case-insensitive only for ASCII, so only ASCII text is a safe "contains this, any case"
// stand-in for part of a case-insensitive regex.
const PLAIN_ASCII = /^[\x20-\x7e]$/;
// A {n} or {n,m} quantifier; any other { is a plain character in a regex without the u flag, as
// src/core/search.mjs builds them.
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}\??/;

const likePattern = (text) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

// The index of the ] closing the class that opens at start, or -1.
function classEnd(source, start) {
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === ']') return i;
  }
  return -1;
}

// The index of the ) closing the group that opens at start, or -1.
function groupEnd(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === '[') {
      i = classEnd(source, i);
      if (i === -1) return -1;
    } else if (source[i] === '(') depth += 1;
    else if (source[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

// The atom starting at i: a plain character ({ char }) or something else ({}), and the index of its
// last character, or null when the pattern can't be read there.
function readAtom(source, i) {
  const char = source[i];
  if (char === '(' || char === '[') {
    const end = char === '(' ? groupEnd(source, i) : classEnd(source, i);
    return end === -1 ? null : { atom: {}, end };
  }
  if (char === '\\') {
    const next = source[i + 1];
    if (next === undefined) return null;
    // \d, \b, \n and the like stand for something else; an escaped symbol is itself.
    return { atom: /[\dA-Za-z]/.test(next) ? {} : { char: next }, end: i + 1 };
  }
  if (char === ')') return null;
  const plain = !'^$.?*+{'.includes(char) || (char === '{' && !BRACE_QUANTIFIER.test(source.slice(i)));
  return { atom: plain ? { char } : {}, end: i };
}

// The pattern read as a list of top-level alternatives, each a list of atoms, with whether a quantifier
// lets an atom be skipped (optional true) or repeats it (optional false). Null when it can't be read.
function parseAlternatives(source) {
  const alternatives = [[]];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '|') {
      alternatives.push([]);
      continue;
    }
    const read = readAtom(source, i);
    if (!read) return null;
    const quantifier = /^(?:[?*+]|\{\d+(?:,\d*)?\})\??/.exec(source.slice(read.end + 1));
    i = read.end + (quantifier?.[0].length ?? 0);
    if (quantifier) read.atom.optional = !/^(?:\+|\{[1-9])/.test(quantifier[0]);
    alternatives.at(-1).push(read.atom);
  }
  return alternatives;
}

// The longest run of plain ASCII text every match of an alternative contains, or '' when there's none.
// An optional, repeated or non-ASCII character ends a run.
function requiredText(atoms) {
  let longest = '';
  let run = '';
  for (const { char, optional } of atoms) {
    if (char !== undefined && optional === undefined && PLAIN_ASCII.test(char)) {
      run += char;
      continue;
    }
    // A character repeated by + ends one run and starts the next; anything else just ends it.
    const repeated = char !== undefined && optional === false && PLAIN_ASCII.test(char);
    if (repeated) run += char;
    if (run.length > longest.length) longest = run;
    run = repeated ? char : '';
  }
  return run.length > longest.length ? run : longest;
}

// Plain text standing in for a regex in SQL: for each top-level alternative, text that every match of it
// contains, so a card matching the regex contains at least one of them. Null when some alternative
// needs no such text, since nothing then narrows the search safely. A group
// wrapping the whole pattern, as in (a|b), is unwrapped first.
export function regexLiterals(source) {
  // A plain or non-capturing group; lookarounds and named groups stay as they are.
  const wrapper = /^\((?:\?:)?(?!\?)/.exec(source);
  const unwrapped = wrapper && groupEnd(source, 0) === source.length - 1 ? source.slice(wrapper[0].length, -1) : source;
  const alternatives = parseAlternatives(unwrapped);
  if (!alternatives) return null;
  const literals = alternatives.map(requiredText);
  return literals.every(Boolean) ? [...new Set(literals)] : null;
}

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

// The most LIKE values the text conditions bind, which keeps the whole filter well under D1's 100
// parameters; patterns past it just don't narrow in SQL.
const MAX_TEXT_PARAMS = 40;

function addTextConditions(list, args) {
  let budget = MAX_TEXT_PARAMS;
  const literal = (column, source) => {
    const texts = source === undefined ? null : regexLiterals(source);
    if (!texts || texts.length > budget) return;
    budget -= texts.length;
    const likes = texts.map(() => `${column} LIKE ? ESCAPE '\\'`);
    list.add(likes.length === 1 ? likes[0] : `(${likes.join(' OR ')})`, ...texts.map(likePattern));
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
