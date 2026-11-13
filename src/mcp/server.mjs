// The MCP server: one instance per request (stateless Streamable HTTP), built for the signed-in user.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ToolError } from './tools/shared.mjs';
import { TOOLS } from './tools/index.mjs';
import { WORKFLOWS } from './workflows/index.mjs';

export const SERVER_INFO = { name: 'mtg-assistant', version: '0.1.0' };

// Condensed from mtg-manager's AGENTS.md; grows with the tools.
export const INSTRUCTIONS = `MTG Assistant manages one person's Magic: The Gathering collection and decks.
Rules: never invent card text, legality, ownership, prices or test results; use the tools and say when data is missing.
Each user sees only their own data.
Terms follow ManaBox, Moxfield and Archidekt: the collection is every card the person owns, kept in binders; a deck is a list with its own structure, and a built deck's cards sit in its deck binder.
Protected binders (precons, built decks) are reported but never supply a deck's cards: mention useful protected copies, never put them in a deck.
Size broad questions with search_cards count or group_by before listing cards.
For a multi-step job (brewing, surveying, scouting commanders, reviewing or upgrading a deck), read its playbook with get_workflow first: ${WORKFLOWS.map((workflow) => workflow.name).join(', ')}.
Decks are saved with draft_deck and update_deck (import_deck copies one from an Archidekt link or a pasted list); ask before big rewrites.
Change binders (add_cards, remove_cards, import_binder, or import_collection for a fresh ManaBox export of everything) only when the person says their physical cards changed, and never move cards between binders to make a deck pass. import_deck brings in a deck list.
build_deck, teardown_deck and swap_deck move a deck's real cards: show the plan first, and apply it only once the person says they've done it.
Purchase prices are private: include them in a download only when the person asks.`;

// Runs a tool for the signed-in user. ToolErrors are the caller's to see; anything else is logged and
// reported generically, so internals never reach the client.
function runTool(tool, user, env) {
  return async (args) => {
    try {
      return await tool.handler(args, { db: env.DB, user, env, now: Date.now() });
    } catch (error) {
      if (error instanceof ToolError) return { isError: true, content: [{ type: 'text', text: error.message }] };
      console.error(`tool ${tool.name} failed`, error?.stack ?? error);
      return {
        isError: true,
        content: [{ type: 'text', text: `${tool.name} failed unexpectedly; try again or narrow the request.` }],
      };
    }
  };
}

// Every tool and prompt registers here. user is { id, email } from the verified token, never from tool arguments.
export function buildServer(user, env) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Shows which MTG Assistant account this connection is signed in as.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: 'text', text: `Signed in to MTG Assistant as ${user.email}.` }],
      structuredContent: { email: user.email },
    }),
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations ?? { readOnlyHint: true, openWorldHint: false },
      },
      runTool(tool, user, env),
    );
  }

  // The playbooks as prompts, for clients that offer them (get_workflow serves the rest).
  for (const workflow of WORKFLOWS) {
    server.registerPrompt(workflow.name, { title: workflow.title, description: workflow.description }, () => ({
      description: workflow.description,
      messages: [{ role: 'user', content: { type: 'text', text: workflow.text } }],
    }));
  }

  return server;
}

export async function handleMcpRequest(request, user, env) {
  const server = buildServer(user, env);
  // Stateless: no session IDs, and JSON responses rather than SSE streams.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
