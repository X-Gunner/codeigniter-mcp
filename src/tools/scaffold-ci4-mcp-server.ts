/**
 * Tool 8 — `scaffold_ci4_mcp_server`.
 *
 * Scaffolds an in-app native Model Context Protocol (MCP) server command
 * inside a CodeIgniter 4 application (`app/Commands/McpServer.php`).
 *
 * This allows AI assistants (Claude Code, Cursor, Windsurf, Trae) to:
 * - Inspect database tables and column types live
 * - Run safe, read-only SELECT queries with max row limits
 * - List active compiled routes
 * - Inspect migration status directly from CodeIgniter 4
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveInAppRoot,
  toRelativePath,
  type ToolDeps,
} from "../core/config.js";
import { handleToolCall, type ToolResult } from "../core/errors.js";
import { safeWriteFile } from "../core/fs-safe.js";
import {
  ScaffoldCi4McpServerInput,
  type ScaffoldCi4McpServerOutputType,
} from "../schemas/scaffold-ci4-mcp-server.schema.js";
import { renderCi4McpServerCommand } from "../templates/ci4-mcp-server.template.js";

export async function scaffoldCi4McpServer(
  input: unknown,
  deps: ToolDeps,
): Promise<ToolResult<ScaffoldCi4McpServerOutputType>> {
  return handleToolCall(async () => {
    const parsed = ScaffoldCi4McpServerInput.parse(input);
    const warnings: string[] = [];

    if (deps.conventions.framework !== "ci4") {
      warnings.push(
        "Current profile is not 'ci4'. The scaffolded command targets CodeIgniter 4 (spark runner). " +
          "Ensure your project has CodeIgniter 4 installed or set framework='ci4' in .codeigniter-mcp.json.",
      );
    }

    const relPath = `app/Commands/${parsed.className}.php`;
    const absPath = resolveInAppRoot(deps.appRoot, ...relPath.split("/"));

    const content = renderCi4McpServerCommand({
      commandName: parsed.commandName,
      className: parsed.className,
      readOnly: parsed.readOnly,
      withDatabaseTools: parsed.withDatabaseTools,
      withRouteTools: parsed.withRouteTools,
      withMigrationTools: parsed.withMigrationTools,
    });

    const result = safeWriteFile(absPath, content, parsed.overwrite);
    const relative = toRelativePath(deps.appRoot, absPath);

    const supportedTools: string[] = [];
    if (parsed.withDatabaseTools) {
      supportedTools.push("ci4_db_tables", "ci4_db_query");
    }
    if (parsed.withRouteTools) {
      supportedTools.push("ci4_routes_list");
    }
    if (parsed.withMigrationTools) {
      supportedTools.push("ci4_migration_status");
    }

    const mcpConfigSnippet = {
      mcpServers: {
        "codeigniter-live": {
          command: "php",
          args: ["spark", parsed.commandName],
          cwd: deps.appRoot,
        },
      },
    };

    return {
      filePath: relative,
      written: result.written,
      sparkCommand: `php spark ${parsed.commandName}`,
      supportedTools,
      readOnly: parsed.readOnly,
      mcpConfigSnippet,
      warnings: result.written
        ? warnings
        : [...warnings, `${relative} already exists and overwrite=false; not modified.`],
    };
  });
}

export function registerScaffoldCi4McpServer(
  server: McpServer,
  deps: ToolDeps,
): void {
  server.registerTool(
    "scaffold_ci4_mcp_server",
    {
      title: "Scaffold native CI4 MCP server (Live runtime introspection)",
      description:
        "Generates a native CodeIgniter 4 Spark command (`app/Commands/McpServer.php`) that runs an in-app " +
        "Model Context Protocol (MCP) server over stdio. Enables AI assistants (Claude Code, Cursor, Trae) " +
        "to inspect live database tables, run read-only queries, check migration status, and list compiled routes. " +
        "Requires overwrite=true to overwrite existing files.",
      inputSchema: ScaffoldCi4McpServerInput,
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await scaffoldCi4McpServer(args, deps), null, 2),
        },
      ],
    }),
  );
}
