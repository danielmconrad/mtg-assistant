// /: a public page on connecting Claude to this server. It shows nothing about anyone, only the steps and
// this server's connector URL; who may connect is still decided by ALLOWED_EMAILS at sign-in.
import { escapeHtml, htmlPage } from './http.mjs';

export function homePage(config) {
  const mcp = escapeHtml(`${config.origin}/mcp`);
  return htmlPage(
    'MTG Assistant',
    `<h1>Connect to Claude</h1>
<p>Your Magic: The Gathering collection and decks, in Claude: search what you own, brew and review decks from it, and keep your binders in step with ManaBox, Moxfield and Archidekt.</p>
<p class="warn">It’s invitation only. Ask whoever runs this server to add your Google account’s email before you connect.</p>

<h2>Connect Claude</h2>
<p>For claude.ai, the desktop app and the phone apps. Add it once on the web or desktop and your phone picks it up.</p>
<ol>
  <li>Open <strong>Settings › Connectors</strong> and choose <strong>Add custom connector</strong>. On a Team or Enterprise plan, an owner adds it for the organization instead.</li>
  <li>Name it <strong>MTG Assistant</strong>, and for the URL enter:<code class="url">${mcp}</code>Leave the advanced settings (OAuth client ID and secret) empty.</li>
  <li>Choose <strong>Connect</strong>. Sign in with the Google account you were invited with, choose <strong>Allow</strong>, and confirm with Google.</li>
  <li>In a chat, turn MTG Assistant on from the tools menu (the <strong>+</strong> button, then <strong>Connectors</strong>).</li>
</ol>

<h2>Connect Claude Code</h2>
<p>Run this, then <strong>/mcp</strong> in Claude Code to sign in:</p>
<code class="url">claude mcp add --transport http mtg-assistant ${mcp}</code>

<h2>First steps</h2>
<ul>
  <li>“Who am I in MTG Assistant?” checks the connection.</li>
  <li>“Import my ManaBox collection” gives you a link to upload a ManaBox CSV export. You preview every change before it’s applied.</li>
  <li>“Summarize my collection”, “What commanders does my collection support?” or “Review my deck” to get going.</li>
</ul>

<h2>If something goes wrong</h2>
<ul>
  <li><strong>Not allowed</strong> at sign-in: your email isn’t invited yet, or you signed in with a different Google account.</li>
  <li><strong>This app is not allowed to connect</strong>: the app you’re connecting from isn’t one this server accepts.</li>
  <li>A link that says it’s <strong>expired or used up</strong>: ask Claude for a new one. Upload links last 10 minutes and download links 15.</li>
</ul>`,
  );
}
