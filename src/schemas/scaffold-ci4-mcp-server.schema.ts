/**
 * Zod schema for `scaffold_ci4_mcp_server`.
 *
 * Scaffolds an in-app, native Model Context Protocol (MCP) server command
 * inside a CodeIgniter 4 application (`app/Commands/McpServer.php`).
 */

import { z } from "zod";

export const ScaffoldCi4McpServerInput = z.object({
  commandName: z
    .string()
    .regex(/^[a-z0-9]+:[a-z0-9]+$/, "Must be spark command syntax, e.g. mcp:serve")
    .default("mcp:serve"),
  className: z
    .string()
    .regex(/^[A-Z][a-zA-Z0-9]*$/, "className must be PascalCase, e.g. McpServer")
    .default("McpServer"),
  readOnly: z.boolean().default(true),
  withDatabaseTools: z.boolean().default(true),
  withRouteTools: z.boolean().default(true),
  withMigrationTools: z.boolean().default(true),
  overwrite: z.boolean().default(false),
});

export const ScaffoldCi4McpServerOutput = z.object({
  success: z.boolean(),
  filePath: z.string(),
  written: z.boolean(),
  sparkCommand: z.string(),
  supportedTools: z.array(z.string()),
  readOnly: z.boolean(),
  mcpConfigSnippet: z.object({
    mcpServers: z.record(
      z.object({
        command: z.string(),
        args: z.array(z.string()),
        cwd: z.string().optional(),
      }),
    ),
  }),
  warnings: z.array(z.string()),
});

export type ScaffoldCi4McpServerInputType = z.infer<
  typeof ScaffoldCi4McpServerInput
>;
export type ScaffoldCi4McpServerOutputType = z.infer<
  typeof ScaffoldCi4McpServerOutput
>;
