/** SpeedPilot MCP server: a small tool set with compact answers and evidence paths (SPEC.md 15.9). */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { projectRoot } from '@speedpilot/core';
import { xrayTools, capAnswer, type ToolDef } from './xrayTools.js';

export * from './xrayTools.js';

export function allTools(root: string): ToolDef[] {
  return [...xrayTools(root)];
}

export function createServer(root = projectRoot()): McpServer {
  const server = new McpServer({ name: 'speedpilot', version: '0.1.0' });
  for (const t of allTools(root)) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args: Record<string, unknown>) => {
      try {
        const res = capAnswer(await t.run(args));
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 1) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] };
      }
    });
  }
  return server;
}
