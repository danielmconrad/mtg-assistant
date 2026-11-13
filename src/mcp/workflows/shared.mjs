// What the deck playbooks say about saving decks and changing binders.
export const DECK_SAVING =
  "create_deck and update_deck save decks; each save is checked against the deck schema and records lowest_legal_bracket. Binders change only when the person says their cards did: add_cards once they have bought cards, remove_cards when they sell or trade them, and get_upload_link for a whole file (a fresh ManaBox export), which they preview and apply themselves. Drafts don't reserve cards; build_deck moves a finished deck's cards into its own protected deck binder once the person sleeves it.";
