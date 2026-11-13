// What every tool shares: refusals the caller should see, regex safety, result text, and loading a
// person's cards. Tools get the user from the verified token (ctx.user), never from their arguments.
import { cardIndexFor, loadCardRows, loadOwnedRows } from '../../storage/cards.mjs';

// A problem with the request, shown to Claude as the tool's answer. Anything else thrown is a bug, and
// Claude sees only a generic error.
export class ToolError extends Error {}

const MAX_PATTERN_LENGTH = 200;
// A group containing a quantifier, itself quantified ((a+)+, (\w*)*, (x+){2,}): the classic shapes of
// catastrophic backtracking. Backreferences are refused too. The Worker's CPU limit is the backstop.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)\s*[*+{?]/;
const BACKREFERENCE = /\\[1-9]|\\k</;

// Checks a user-supplied regular expression before mtg-manager's code compiles it (case-insensitive).
export function checkPattern(source, field) {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new ToolError(`${field} is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  if (NESTED_QUANTIFIER.test(source) || BACKREFERENCE.test(source)) {
    throw new ToolError(`${field} has a nested quantifier or backreference, which could run too long; simplify it`);
  }
  try {
    new RegExp(source, 'i');
  } catch (error) {
    throw new ToolError(`${field} is not a valid regular expression: ${error.message}`);
  }
  return source;
}

// A tool result: the text Claude reads (mtg-manager's text output, warnings last).
export function textResult(lines, warnings = []) {
  const text = [...lines, ...warnings.map((warning) => `WARNING: ${warning}`)].join('\n');
  return { content: [{ type: 'text', text }] };
}

const uniqueById = (rows) => [...new Map(rows.map((row) => [row.id, row])).values()];

// The card index for a request: every card the person owns (ownership counts read every row), with the
// printings src/core reads (plus those in sets and rarities a search names), and any further cards
// it names or rows it adds.
export async function personalIndex(db, userId, { names = [], extraRows = [], sets = [], rarities = [] } = {}) {
  const [owned, named] = await Promise.all([
    loadOwnedRows(db, userId, { sets, rarities }),
    names.length ? loadCardRows(db, { names }) : [],
  ]);
  return cardIndexFor(db, uniqueById([...owned, ...named, ...extraRows]));
}

// A note when the card data is older than the nightly ingest should leave it.
export function staleDataWarning(meta, now) {
  if (!meta.ingestedAt) return 'No card data has been loaded yet; the nightly Scryfall ingest loads it';
  const days = (now - Date.parse(meta.ingestedAt)) / 86_400_000;
  return days > 3 ? `Card data was last loaded ${Math.floor(days)} days ago; check the Scryfall ingest workflow` : null;
}
