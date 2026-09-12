/**
 * Streamable HTTP transport (remote use, `MCP_TRANSPORT=http`).
 *
 * Hardening included (audit findings):
 * - try/catch around `handleRequest` → 500 response + stderr log
 *   (prevents the unhandled rejection that would crash the process on Node >= 15).
 * - `listen` 'error' handling → the promise rejects with a clear message
 *   (EADDRINUSE and similar) instead of hanging or crashing without context.
 * - Body size limit via the Content-Length header (basic anti-DoS).
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Max accepted body per request (anti-DoS hardening). */
export const MAX_HTTP_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export interface HttpTransportHandle {
  transport: StreamableHTTPServerTransport;
  /** Port actually bound (useful with port 0 in tests). */
  port: number;
  /** Host actually bound. */
  host: string;
  httpServer: Server;
  close: () => Promise<void>;
}

function log(message: string): void {
  // Always stderr: stdout is reserved for the JSON-RPC (stdio) protocol.
  process.stderr.write(`[codeigniter-mcp] ${message}\n`);
}

/**
 * Starts the HTTP server and returns the transport ready to connect.
 *
 * @param port         0 → ephemeral port (useful in tests).
 * @param maxBodyBytes Content-Length limit per request.
 * @param host         Interface to bind to (defaults to 127.0.0.1 for security).
 */
export async function startHttpTransport(
  port: number,
  maxBodyBytes: number = MAX_HTTP_BODY_BYTES,
  host: string = process.env.MCP_BIND_HOST ?? "127.0.0.1",
): Promise<HttpTransportHandle> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const allowedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    host.toLowerCase(),
    ...(process.env.MCP_ALLOWED_HOSTS
      ? process.env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim().toLowerCase())
      : []),
  ]);

  const httpServer = createServer(async (req, res) => {
    // DNS Rebinding protection: validate Host header.
    const rawHost = req.headers.host ?? "";
    const hostname = rawHost.split(":")[0]?.toLowerCase() ?? "";
    if (
      process.env.MCP_ALLOW_ANY_HOST !== "true" &&
      hostname &&
      !allowedHosts.has(hostname)
    ) {
      res.writeHead(403, {
        "Content-Type": "application/json",
        Connection: "close",
      });
      res.end(
        JSON.stringify({
          error: "Forbidden: Invalid Host header (DNS rebinding protection).",
        }),
      );
      return;
    }

    // Optional API key authentication.
    const expectedApiKey = process.env.MCP_API_KEY;
    if (expectedApiKey) {
      const authHeader = req.headers.authorization;
      const customKeyHeader = req.headers["x-api-key"];
      const token =
        typeof authHeader === "string" && authHeader.startsWith("Bearer ")
          ? authHeader.slice(7).trim()
          : typeof customKeyHeader === "string"
            ? customKeyHeader.trim()
            : undefined;

      if (!token || token !== expectedApiKey) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          Connection: "close",
        });
        res.end(
          JSON.stringify({
            error: "Unauthorized: Missing or invalid API key.",
          }),
        );
        return;
      }
    }

    // Clients without SSE support only get direct responses (no GET).
    if (req.method === "GET" && !req.headers.accept?.includes("text/event-stream")) {
      res.writeHead(405, {
        "Content-Type": "application/json",
        Allow: "POST, DELETE",
      });
      res.end(JSON.stringify({ error: "Method Not Allowed. Use POST or DELETE." }));
      return;
    }

    // Body limit (best-effort; only covers requests with Content-Length).
    const contentLength = Number.parseInt(req.headers["content-length"] ?? "0", 10);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Payload Too Large" }));
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch {
      // Never let a rejection become an unhandled rejection.
      log("Error handling HTTP request. Responding 500.");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      } else {
        res.end();
      }
    }
  });

  const actualPort = await new Promise<number>((resolvePromise, rejectPromise) => {
    const onError = (err: Error): void => {
      httpServer.removeListener("listening", onListening);
      rejectPromise(err);
    };
    const onListening = (): void => {
      httpServer.removeListener("error", onError);
      const address = httpServer.address();
      const boundPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolvePromise(boundPort);
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, host);
  });

  log(`Streamable HTTP transport listening on http://${host}:${actualPort}/`);
  return {
    transport,
    port: actualPort,
    host,
    httpServer,
    close: () => new Promise((resolvePromise) => httpServer.close(() => resolvePromise())),
  };
}
