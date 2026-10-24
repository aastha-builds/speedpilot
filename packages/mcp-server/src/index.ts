/**
 * SpeedPilot MCP server (SPEC.md 10.2 and 15.9): read-only tools freely, write tools only with a plan ID and an
 * approval token (dry run by default), compact answers with evidence paths.
 * Register: claude mcp add speedpilot -- node packages/mcp-server/dist/index.js
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { projectRoot } from '@speedpilot/core';
import { xrayTools, capAnswer, type ToolDef } from './xrayTools.js';
import { siteTools } from './siteTools.js';

export * from './xrayTools.js';
export * from './siteTools.js';

export const WRITE_TOOLS = ['backup', 'prepare_staging', 'apply_change', 'rollback', 'deploy'];

export function allTools(root: string): ToolDef[] {
  return [...siteTools(root), ...xrayTools(root)];
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

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) await createServer().connect(new StdioServerTransport());
