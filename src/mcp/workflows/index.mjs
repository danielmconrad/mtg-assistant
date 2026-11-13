// The playbooks Claude follows for multi-step jobs: mtg-manager's Claude Code skills, rewritten for this
// server's tools. get_workflow returns them, and each is also an MCP prompt.
import { COLLECTION_SURVEY } from './collection-survey.mjs';
import { COMMANDER_SCOUT } from './commander-scout.mjs';
import { DECK_REVIEW } from './deck-review.mjs';
import { DECK_UPGRADES } from './deck-upgrades.mjs';
import { DECKBUILDING_STRATEGY } from './deckbuilding-strategy.mjs';
import { FORMATS } from './formats.mjs';
import { NEW_DECK } from './new-deck.mjs';

export const WORKFLOWS = [
  NEW_DECK,
  COLLECTION_SURVEY,
  COMMANDER_SCOUT,
  DECK_REVIEW,
  DECK_UPGRADES,
  DECKBUILDING_STRATEGY,
  FORMATS,
];
