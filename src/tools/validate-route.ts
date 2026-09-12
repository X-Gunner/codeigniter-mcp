/**
 * Tool 3 — `validate_route` (spec section 2).
 *
 * Read-only: reads `app/Config/Routes.php` and NEVER modifies it.
 * Detects:
 * - Exact collision (same method + path).
 * - Pattern collision (`/products/{id}` vs `/products/{slug}`).
 * - Path shape errors (unbalanced braces, invalid parameters).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  resolveInAppRoot,
  type ToolDeps,
} from "../core/config.js";
import { handleToolCall, type ToolResult } from "../core/errors.js";
import { readFileIfExists } from "../core/fs-safe.js";
import { ValidateRouteInput } from "../schemas/validate-route.schema.js";

export interface RouteEntry {
  method: string;
  path: string;
}

export interface RouteConflict {
  existingMethod: string;
  existingPath: string;
  reason: string;
}

export interface ValidateRoutePayload {
  valid: boolean;
  conflicts: RouteConflict[];
  suggestions: string[];
}

const ROUTE_PATTERN_SOURCE = "->(get|post|put|patch|delete)\\s*\\(\\s*['\"]([^'\"]+)['\"]";

/** Helper: guarantees a leading slash for uniform comparison. */
export function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Extracts the registered routes from the Routes.php content.
 * Supported formats:
 * - Direct: `$routes->get('/products/{id}', 'ProductController::show');` or `$routes->get('products', ...);`
 * - CI4 Resource: `$routes->resource('photos');` (expands to standard REST routes)
 * Deduplicates by `method + path`.
 */
export function parseRoutes(content: string): RouteEntry[] {
  const regex = new RegExp(ROUTE_PATTERN_SOURCE, "gi");
  const seen = new Set<string>();
  const routes: RouteEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const method = match[1]!.toUpperCase();
    const path = ensureLeadingSlash(match[2]!);
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    routes.push({ method, path });
  }

  // Parse CI4 resource routes: $routes->resource('photos')
  const resourceRegex = /->resource\s*\(\s*['"]([^'"]+)['"]/gi;
  while ((match = resourceRegex.exec(content)) !== null) {
    const resource = match[1]!.replace(/^\/+|\/+$/g, "");
    const base = `/${resource}`;
    const resourceRoutes: RouteEntry[] = [
      { method: "GET", path: base },
      { method: "POST", path: base },
      { method: "GET", path: `${base}/new` },
      { method: "GET", path: `${base}/{id}` },
      { method: "GET", path: `${base}/{id}/edit` },
      { method: "PUT", path: `${base}/{id}` },
      { method: "PATCH", path: `${base}/{id}` },
      { method: "DELETE", path: `${base}/{id}` },
    ];
    for (const r of resourceRoutes) {
      const key = `${r.method} ${r.path}`;
      if (!seen.has(key)) {
        seen.add(key);
        routes.push(r);
      }
    }
  }

  return routes;
}

/** `{param}` or CI4 `(:num)`, `(:segment)`, `(:any)` → `*` to compare the structural shape of a route. */
export function normalizeRoutePattern(path: string): string {
  return ensureLeadingSlash(path)
    .replace(/\{[^}]+\}/g, "*")
    .replace(/\(:(num|segment|any|alphanumeric|hash|all)\)/gi, "*");
}

/** Validates the path shape: balanced braces and valid parameter names. */
export function validatePathShape(path: string): { ok: boolean; message?: string } {
  const opens = (path.match(/\{/g) ?? []).length;
  const closes = (path.match(/\}/g) ?? []).length;
  if (opens !== closes) {
    return { ok: false, message: "Unbalanced { } braces in the path." };
  }
  const paramPattern = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = paramPattern.exec(path)) !== null) {
    const name = match[1]!;
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) {
      return {
        ok: false,
        message: `Invalid parameter name: {${name}}. Use camelCase, e.g. {productId}.`,
      };
    }
  }
  return { ok: true };
}

/** Detects conflicts of the new route against the registered ones. */
export function findConflicts(
  method: string,
  path: string,
  existing: RouteEntry[],
): RouteConflict[] {
  const conflicts: RouteConflict[] = [];
  const normalizedPath = ensureLeadingSlash(path);
  const newPattern = normalizeRoutePattern(normalizedPath);

  for (const route of existing) {
    if (route.method !== method) {
      continue;
    }
    const existingNormalized = ensureLeadingSlash(route.path);
    if (existingNormalized === normalizedPath) {
      conflicts.push({
        existingMethod: route.method,
        existingPath: route.path,
        reason: "Exact duplicate route (same method and path).",
      });
    } else if (normalizeRoutePattern(existingNormalized) === newPattern) {
      conflicts.push({
        existingMethod: route.method,
        existingPath: route.path,
        reason: "Pattern collision: the route shares its structure with a different parameter placeholder.",
      });
    }
  }
  return conflicts;
}

function buildSuggestions(
  method: string,
  path: string,
  conflicts: RouteConflict[],
): string[] {
  if (conflicts.length === 0) {
    return [`The route ${method} ${path} does not collide with the registered routes.`];
  }
  return conflicts.map((conflict) => {
    if (conflict.reason.startsWith("Exact duplicate route")) {
      return (
        `Remove or modify the existing route ${conflict.existingMethod} ${conflict.existingPath}, ` +
        "or use a different path."
      );
    }
    return (
      `Differentiate the literal path to disambiguate, e.g. add a fixed segment ` +
      `(${path} with a prefix like /catalog) instead of ${conflict.existingPath}.`
    );
  });
}

export async function validateRoute(
  input: unknown,
  deps: ToolDeps,
): Promise<ToolResult<ValidateRoutePayload>> {
  return handleToolCall(async () => {
    const parsed = ValidateRouteInput.parse(input);

    const shape = validatePathShape(parsed.path);
    if (!shape.ok) {
      return {
        valid: false,
        conflicts: [],
        suggestions: [shape.message!],
      };
    }

    const routesFile = resolveInAppRoot(deps.appRoot, "app", "Config", "Routes.php");
    const content = readFileIfExists(routesFile);

    if (content === null) {
      return {
        valid: true,
        conflicts: [],
        suggestions: [
          "app/Config/Routes.php does not exist; collisions against registered routes could not be verified.",
        ],
      };
    }

    const existing = parseRoutes(content);
    const conflicts = findConflicts(parsed.method, parsed.path, existing);

    return {
      valid: conflicts.length === 0,
      conflicts,
      suggestions: buildSuggestions(parsed.method, parsed.path, conflicts),
    };
  });
}

export function registerValidateRoute(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "validate_route",
    {
      title: "Validate a route against Routes.php",
      description:
        "Verifies (read-only) that a route does not collide with the routes registered in app/Config/Routes.php " +
        "and follows the framework's kebab-case {param} syntax. Never modifies files.",
      inputSchema: ValidateRouteInput,
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await validateRoute(args, deps), null, 2),
        },
      ],
    }),
  );
}
