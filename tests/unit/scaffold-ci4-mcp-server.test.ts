import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffoldCi4McpServer } from "../../src/tools/scaffold-ci4-mcp-server.js";
import { createTestContext, writeInAppRoot } from "../helpers.js";

function phpAvailable(): boolean {
  try {
    execFileSync("php", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("scaffold_ci4_mcp_server", () => {
  it("happy path: generates app/Commands/McpServer.php with valid syntax and MCP config", async () => {
    const { root, deps, cleanup } = createTestContext();
    try {
      const result = await scaffoldCi4McpServer({}, deps);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.filePath).toBe("app/Commands/McpServer.php");
      expect(result.written).toBe(true);
      expect(result.sparkCommand).toBe("php spark mcp:serve");
      expect(result.supportedTools).toContain("ci4_db_tables");
      expect(result.supportedTools).toContain("ci4_db_query");
      expect(result.supportedTools).toContain("ci4_routes_list");
      expect(result.supportedTools).toContain("ci4_migration_status");
      expect(result.mcpConfigSnippet.mcpServers["codeigniter-live"]?.command).toBe("php");
      expect(result.mcpConfigSnippet.mcpServers["codeigniter-live"]?.args).toEqual(["spark", "mcp:serve"]);

      const absPath = join(root, "app", "Commands", "McpServer.php");
      expect(existsSync(absPath)).toBe(true);
      const content = readFileSync(absPath, "utf8");

      expect(content).toContain("namespace App\\Commands;");
      expect(content).toContain("class McpServer extends BaseCommand");
      expect(content).toMatch(/protected \$name\s*=\s*'mcp:serve';/);
      expect(content).toContain("getToolList");
      expect(content).toContain("callTool");

      if (phpAvailable()) {
        const lintOutput = execFileSync("php", ["-l", absPath], { encoding: "utf8" });
        expect(lintOutput).toContain("No syntax errors detected");
      }
    } finally {
      cleanup();
    }
  });

  it("skips writing when file exists and overwrite is false", async () => {
    const { root, deps, cleanup } = createTestContext();
    try {
      writeInAppRoot(root, "app/Commands/McpServer.php", "/* original */");
      const result = await scaffoldCi4McpServer({ overwrite: false }, deps);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.written).toBe(false);
      const absPath = join(root, "app", "Commands", "McpServer.php");
      expect(readFileSync(absPath, "utf8")).toBe("/* original */");
    } finally {
      cleanup();
    }
  });

  it("overwrites file when overwrite is true", async () => {
    const { root, deps, cleanup } = createTestContext();
    try {
      writeInAppRoot(root, "app/Commands/McpServer.php", "/* original */");
      const result = await scaffoldCi4McpServer({ overwrite: true }, deps);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.written).toBe(true);
      const absPath = join(root, "app", "Commands", "McpServer.php");
      expect(readFileSync(absPath, "utf8")).not.toBe("/* original */");
      expect(readFileSync(absPath, "utf8")).toContain("class McpServer");
    } finally {
      cleanup();
    }
  });

  it("custom className and commandName are honored", async () => {
    const { root, deps, cleanup } = createTestContext();
    try {
      const result = await scaffoldCi4McpServer(
        { className: "CustomMcp", commandName: "ai:introspect" },
        deps,
      );
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.filePath).toBe("app/Commands/CustomMcp.php");
      expect(result.sparkCommand).toBe("php spark ai:introspect");
      expect(result.mcpConfigSnippet.mcpServers["codeigniter-live"]?.args).toEqual(["spark", "ai:introspect"]);

      const absPath = join(root, "app", "Commands", "CustomMcp.php");
      expect(existsSync(absPath)).toBe(true);
      const content = readFileSync(absPath, "utf8");
      expect(content).toContain("class CustomMcp extends BaseCommand");
      expect(content).toMatch(/protected \$name\s*=\s*'ai:introspect';/);

      if (phpAvailable()) {
        const lintOutput = execFileSync("php", ["-l", absPath], { encoding: "utf8" });
        expect(lintOutput).toContain("No syntax errors detected");
      }
    } finally {
      cleanup();
    }
  });

  it("readOnly mode prevents write queries in schema / code", async () => {
    const { root, deps, cleanup } = createTestContext();
    try {
      const result = await scaffoldCi4McpServer({ readOnly: true }, deps);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const absPath = join(root, "app", "Commands", "McpServer.php");
      const content = readFileSync(absPath, "utf8");
      expect(content).toContain("ReadOnly mode");

      if (phpAvailable()) {
        const lintOutput = execFileSync("php", ["-l", absPath], { encoding: "utf8" });
        expect(lintOutput).toContain("No syntax errors detected");
      }
    } finally {
      cleanup();
    }
  });
});
