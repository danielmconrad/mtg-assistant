// Every MCP tool, in the order Claude sees them. tests/worker/tools-isolation.test.mjs requires a
// cross-tenant test for each one.
import { CARD_TOOLS } from './cards.mjs';
import { COLLECTION_WRITE_TOOLS } from './collection-writes.mjs';
import { COLLECTION_TOOLS } from './collections.mjs';
import { COMMANDER_TOOLS } from './commanders.mjs';
import { DECK_WRITE_TOOLS } from './deck-writes.mjs';
import { DECK_TOOLS } from './decks.mjs';
import { DOWNLOAD_TOOLS } from './downloads.mjs';
import { WORKFLOW_TOOLS } from './workflows.mjs';

export const TOOLS = [
  ...CARD_TOOLS,
  ...COLLECTION_TOOLS,
  ...COLLECTION_WRITE_TOOLS,
  ...COMMANDER_TOOLS,
  ...DECK_TOOLS,
  ...DECK_WRITE_TOOLS,
  ...DOWNLOAD_TOOLS,
  ...WORKFLOW_TOOLS,
];
