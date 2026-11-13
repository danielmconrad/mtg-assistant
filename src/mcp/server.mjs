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
Protected collections (precons, built decks) are reported but never supply a deck's cards: mention useful protected copies, never put them in a deck.
Size broad questions with search_cards count or group_by before listing cards.
For a multi-step job (brewing, surveying, scouting commanders, reviewing or upgrading a deck), read its playbook with get_workflow first: ${WORKFLOWS.map((workflow) => workflow.name).join(', ')}.
Decks and collections can't be edited through these tools yet: propose changes rather than claiming they were saved.
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
        annotations: { readOnlyHint: true, openWorldHint: false },
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
