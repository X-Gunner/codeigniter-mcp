/**
 * Integration tests of the Streamable HTTP transport (MCP_TRANSPORT=http).
 *
 * Covers the audit findings:
 * - 405 for GET clients without SSE support.
 * - 413 with excessive Content-Length (anti-DoS body limit).
 * - Clean EADDRINUSE rejection (handled listen error).
 * - initialize + tools/list handshake over real HTTP with session.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_HTTP_BODY_BYTES,
  startHttpTransport,
  type HttpTransportHandle,
} from "../../src/http-transport.js";
import { buildServer } from "../../src/server.js";
import { createTestContext, type TestContext } from "../helpers.js";

interface HttpResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/**
 * Parses the transport response: if the server chose SSE
 * (Content-Type text/event-stream), extracts the last `data:` frame.
 */
function parseMcpResponse(response: HttpResponse): unknown {
  const contentType = String(response.headers["content-type"] ?? "");
  if (contentType.includes("text/event-stream")) {
    const dataLines = response.body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    const last = dataLines[dataLines.length - 1];
    if (last === undefined) {
      throw new Error("SSE response without a data frame:");
    }
    return JSON.parse(last) as unknown;
  }
  return JSON.parse(response.body) as unknown;
}

function rawSocket(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(raw);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

function jsonPost(
  port: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "Content-Length": Buffer.byteLength(payload, "utf8"),
          ...extraHeaders,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("HTTP transport (Streamable)", () => {
  let ctx: TestContext;
  let server: McpServer;
  let handle: HttpTransportHandle;
  let port: number;

  beforeAll(async () => {
    ctx = createTestContext();
    server = buildServer(ctx.deps);
    handle = await startHttpTransport(0); // ephemeral port
    port = handle.port;
    await server.connect(handle.transport);
  }, 30_000);

  afterAll(async () => {
    await server.close().catch(() => {});
    await handle.close();
    ctx.cleanup();
  });

  it("GET without SSE support → 405 Method Not Allowed", async () => {
    const response = await rawSocket(
      port,
      "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
    );
    expect(response).toContain("405");
  });

  it("excessive Content-Length → 413 Payload Too Large", async () => {
    const response = await rawSocket(
      port,
      `POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${MAX_HTTP_BODY_BYTES + 1}\r\nConnection: close\r\n\r\n`,
    );
    expect(response).toContain("413");
  });

  it("initialize + tools/list over real HTTP (session)", async () => {
    const init = await jsonPost(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "http-test", version: "1.0.0" },
      },
    });
    expect(init.status).toBe(200);
    const initParsed = parseMcpResponse(init) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(initParsed.result?.serverInfo?.name).toBe("codeigniter-mcp");

    const sessionId = String(init.headers["mcp-session-id"] ?? "");
    expect(sessionId.length).toBeGreaterThan(0);

    await jsonPost(
      port,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { "Mcp-Session-Id": sessionId },
    );

    const list = await jsonPost(
      port,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "Mcp-Session-Id": sessionId },
    );
    expect(list.status).toBe(200);
    const listParsed = parseMcpResponse(list) as {
      result?: { tools?: unknown[] };
    };
    expect(listParsed.result?.tools?.length).toBeGreaterThanOrEqual(7);
  });

  it("occupied port → EADDRINUSE rejects with a clear error (no hang)", async () => {
    await expect(startHttpTransport(port)).rejects.toThrow(
      /EADDRINUSE|address already in use/i,
    );
  });

  it("blocks DNS rebinding with untrusted Host header → 403 Forbidden", async () => {
    const response = await rawSocket(
      port,
      "POST / HTTP/1.1\r\nHost: evil-rebound-domain.com\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    expect(response).toContain("403");
    expect(response).toContain("DNS rebinding protection");
  });

  it("enforces MCP_API_KEY when configured → 401 without key, 200 with key", async () => {
    const originalKey = process.env.MCP_API_KEY;
    process.env.MCP_API_KEY = "super-secret-token";
    const authServerHandle = await startHttpTransport(0);
    const authPort = authServerHandle.port;
    const authServer = buildServer(ctx.deps);
    await authServer.connect(authServerHandle.transport);

    try {
      // Missing token → 401
      const resUnauth = await jsonPost(authPort, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      });
      expect(resUnauth.status).toBe(401);

      // Wrong token → 401
      const resWrong = await jsonPost(
        authPort,
        { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
        { Authorization: "Bearer wrong-token" },
      );
      expect(resWrong.status).toBe(401);

      // Correct token → 200
      const resOk = await jsonPost(
        authPort,
        { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
        { Authorization: "Bearer super-secret-token" },
      );
      expect(resOk.status).toBe(200);
    } finally {
      await authServer.close().catch(() => {});
      await authServerHandle.close();
      if (originalKey === undefined) {
        delete process.env.MCP_API_KEY;
      } else {
        process.env.MCP_API_KEY = originalKey;
      }
    }
  });
});
