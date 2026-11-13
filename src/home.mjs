// /: a public page on what MTG Assistant does and how to connect Claude to it. It shows nothing about
// anyone, only examples, the steps, this server's connector URL and the tools and playbooks (listed from
// TOOLS and WORKFLOWS, so they stay current); who may connect is still decided by ALLOWED_EMAILS.
import { card, escapeHtml, htmlPage } from './http.mjs';
import { TOOLS } from './mcp/tools/index.mjs';
import { WORKFLOWS } from './mcp/workflows/index.mjs';

// Things worth asking, each a job that strings several tools together.
const ASKS = [
  'Which commanders could I build from cards I already own? Give me three directions.',
  'Brew a bracket 3 Food deck from my binders with at most $40 of cards to buy.',
  'Review my Ayula deck: what strong cards am I leaving out, and does it play like a 2?',
  'Find a commander I don’t own yet whose themes my collection already feeds.',
];

// The tools by job. A tool missing here still appears, under More, so the page never drops one.
const GROUPS = [
  ['Cards and collection', ['search_cards', 'get_cards', 'collection_summary', 'collection_changes']],
  ['Commanders', ['rank_commanders', 'refresh_edhrec']],
  [
    'Decks',
    [
      'list_decks',
      'show_deck',
      'deck_stats',
      'check_deck',
      'verify_deck',
      'deck_candidates',
      'deck_upgrades',
      'draft_deck',
      'update_deck',
      'import_deck',
      'export_deck',
    ],
  ],
  ['Physical decks', ['build_deck', 'teardown_deck', 'swap_deck']],
  [
    'Binders, imports and downloads',
    ['add_cards', 'remove_cards', 'update_binder', 'import_collection', 'import_binder', 'get_download_link'],
  ],
  ['Account and playbooks', ['whoami', 'get_workflow']],
];

const ALL_TOOLS = [...TOOLS, { name: 'whoami', title: 'Who am I' }];

function toolGroups() {
  const byName = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));
  const listed = new Set(GROUPS.flatMap(([, names]) => names));
  const groups = [...GROUPS, ['More', ALL_TOOLS.filter((tool) => !listed.has(tool.name)).map((tool) => tool.name)]];
  return groups
    .map(([label, names]) => [label, names.map((name) => byName.get(name)).filter(Boolean)])
    .filter(([, tools]) => tools.length)
    .map(
      ([label, tools]) =>
        `<h3>${escapeHtml(label)}</h3><ul class="tools">${tools
          .map((tool) => `<li>${escapeHtml(tool.title)}<code>${escapeHtml(tool.name)}</code></li>`)
          .join('')}</ul>`,
    )
    .join('\n');
}

export function homePage(config) {
  const mcp = escapeHtml(`${config.origin}/mcp`);
  const hero = card(
    '<h1>MTG Assistant</h1>',
    `<p class="lede">Your Magic collection and decks, inside Claude. Ask for real work:</p>
<ul class="asks">${ASKS.map((ask) => `<li>${escapeHtml(ask)}</li>`).join('')}</ul>
<p class="ctas"><a class="button primary" href="#connect">Connect to Claude ↓</a><a class="button" href="#claude-code">Use it in Claude Code ↓</a></p>
<p>It knows every card you own and every card on Scryfall, and how Commander decks are built. Claude answers from your binders and the card database, never from memory; it builds, reviews and prices decks, tracks your physical builds, and keeps your binders in step with ManaBox, Moxfield and Archidekt.</p>`,
    { className: 'hero' },
  );
  const connect = card(
    '<h2>Connect to Claude</h2>',
    `<p class="warn">It’s invitation only. Ask whoever runs this server to add your Google account’s email before you connect.</p>
<p>For claude.ai, the desktop app and the phone apps. Add it once on the web or desktop and your phone picks it up.</p>
<ol>
  <li>Open <strong>Settings › Connectors</strong> and choose <strong>Add custom connector</strong>. On a Team or Enterprise plan, an owner adds it for the organization instead.</li>
  <li>Name it <strong>MTG Assistant</strong>, and for the URL enter:<code class="url">${mcp}</code>Leave the advanced settings (OAuth client ID and secret) empty.</li>
  <li>Choose <strong>Connect</strong>. Sign in with the Google account you were invited with, choose <strong>Allow</strong>, and confirm with Google.</li>
  <li>In a chat, turn MTG Assistant on from the tools menu (the <strong>+</strong> button, then <strong>Connectors</strong>).</li>
  <li>Ask “Who am I in MTG Assistant?” to check the connection, then “Import my ManaBox collection” to bring your cards in.</li>
</ol>`,
    { id: 'connect' },
  );
  const claudeCode = card(
    '<h2>Connect Claude Code</h2>',
    `<p>Add the server, then run <strong>/mcp</strong> in Claude Code and sign in with your invited Google account:</p>
<code class="url">claude mcp add --transport http mtg-assistant ${mcp}</code>
<p>Signing in opens a browser and sends access back to Claude Code on your computer; the consent page says so before you allow it.</p>`,
    { id: 'claude-code' },
  );
  const tools = card(
    '<h2>Tools</h2>',
    `<p>Claude chooses among these as it works. You never call them by name, but they show what it can do.</p>
${toolGroups()}`,
    { id: 'tools' },
  );
  const playbooks = card(
    '<h2>Playbooks</h2>',
    `<p>Step-by-step guides Claude reads before a bigger job, so a brew or review is done the same careful way each time. Clients that show MCP prompts list them too.</p>
<ul class="playbooks">${WORKFLOWS.map(
      (workflow) =>
        `<li><strong>${escapeHtml(workflow.title)}</strong> <code>${escapeHtml(workflow.name)}</code><small>${escapeHtml(workflow.description)}</small></li>`,
    ).join('')}</ul>`,
    { id: 'playbooks' },
  );
  const trouble = card(
    '<h2>If something goes wrong</h2>',
    `<ul>
  <li><strong>Not allowed</strong> at sign-in: your email isn’t invited yet, or you signed in with a different Google account.</li>
  <li><strong>This app is not allowed to connect</strong>: the app you’re connecting from isn’t one this server accepts.</li>
  <li>A link that says it’s <strong>expired or used up</strong>: ask Claude for a new one. Upload links last 10 minutes and download links 15.</li>
</ul>`,
    { id: 'help' },
  );
  return htmlPage('MTG Assistant', [hero, connect, claudeCode, tools, playbooks, trouble].join('\n'), {
    cards: true,
    eyebrow: 'Magic: The Gathering · a Claude connector',
  });
}
