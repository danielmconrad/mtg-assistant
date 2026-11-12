// The MCP server: one instance per request (stateless Streamable HTTP), built for the signed-in user.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export const SERVER_INFO = { name: 'mtg-assistant', version: '0.1.0' };

// Condensed from mtg-manager's AGENTS.md; grows with the tools.
export const INSTRUCTIONS = `MTG Assistant manages one person's Magic: The Gathering collection and decks.
Rules: never invent card text, legality, ownership, prices or test results; use the tools and say when data is missing.
Each user sees only their own data.`;

// Every tool registers here. user is { id, email } from the verified token, never from tool arguments.
export function buildServer(user) {
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

  return server;
}

export async function handleMcpRequest(request, user) {
  const server = buildServer(user);
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
