// The EDHREC page cache (migration 0009): pages as src/core/edhrec.mjs parses them, by commander name.
const toPage = (row) =>
  row.missing
    ? { slug: row.slug, fetchedAt: row.fetched_at, missing: true }
    : { slug: row.slug, fetchedAt: row.fetched_at, decks: row.decks, cards: JSON.parse(row.cards) };

// Every cached page, by commander name; only commanders someone refreshed are here.
export async function loadEdhrecPages(db) {
  const { results } = await db.prepare('SELECT * FROM edhrec_pages').all();
  return Object.fromEntries(results.map((row) => [row.name, toPage(row)]));
}

export async function loadEdhrecFetchedAt(db, names) {
  if (!names.length) return new Map();
  const { results } = await db
    .prepare('SELECT name, fetched_at FROM edhrec_pages WHERE name IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(names))
    .all();
  return new Map(results.map((row) => [row.name, row.fetched_at]));
}

export async function saveEdhrecPage(db, name, page) {
  await db
    .prepare(
      `INSERT INTO edhrec_pages (name, slug, fetched_at, missing, decks, cards) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET slug = excluded.slug, fetched_at = excluded.fetched_at,
         missing = excluded.missing, decks = excluded.decks, cards = excluded.cards`,
    )
    .bind(
      name,
      page.slug,
      page.fetchedAt,
      page.missing ? 1 : 0,
      page.missing ? null : page.decks,
      page.missing ? null : JSON.stringify(page.cards),
    )
    .run();
}
