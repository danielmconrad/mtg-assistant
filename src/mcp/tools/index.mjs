// Every MCP tool, in the order Claude sees them. tests/worker/tools-isolation.test.mjs requires a
// cross-tenant test for each one.
import { CARD_TOOLS } from './cards.mjs';
import { COLLECTION_TOOLS } from './collections.mjs';
import { COMMANDER_TOOLS } from './commanders.mjs';
import { DECK_TOOLS } from './decks.mjs';

export const TOOLS = [...CARD_TOOLS, ...COLLECTION_TOOLS, ...COMMANDER_TOOLS, ...DECK_TOOLS];
