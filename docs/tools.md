# Tools

All tools return **deterministic structured output**:
`{ success: true, ... }` on success or `{ success: false, error: { type, message } }`
on failure. They never throw exceptions that break the MCP session.

## 1. `scaffold_full_resource`

Generates the complete CRUD of a resource.

**Input**

| Field | Type | Rules |
|---|---|---|
| `resourceName` | string | `PascalCase`, 2–40 chars |
| `fields[]` | array | `name` (camelCase), `type` (`string\|int\|float\|boolean\|date\|text`), `required` (bool), `validation` (optional, e.g. `"max:255\|email"`) |
| `withTests` | bool | Generates unit and integration tests (default `true`) |
| `withRepository` | bool | Generates repositories (default `true`) |
| `overwrite` | bool | **Destructive.** Overwrites existing files (default `false`) |

**Output** — `filesCreated[]`, `filesSkipped[]`, `warnings[]`.

**Example**

```json
{
  "resourceName": "Product",
  "fields": [
    { "name": "title", "type": "string", "required": true, "validation": "max:255" },
    { "name": "price", "type": "float", "required": true },
    { "name": "description", "type": "text", "required": false }
  ]
}
```

Generates (in deterministic order):

```
app/Controllers/ProductController.php
app/Services/ProductService.php
app/Repositories/ProductRepositoryInterface.php
app/Repositories/ProductRepository.php
app/Entities/Product.php
app/Database/Migrations/2026_08_12_create_products_table.php
tests/Unit/ProductServiceTest.php
tests/Integration/ProductControllerTest.php
```

Rules: `withRepository=false` → no repositories are generated (the Service stays
contract-first) and it warns; with `withTests=true` and no repository it skips
the unit test and warns. Rate limited.

In the `ci4` profile the tool generates Controller + Model + Migration + View
(± Model test) instead; `withRepository=true` (default) also generates the Service
and wires the Controller to it; `withRepository=false` generates a controller using the Model directly.

## 2. `scaffold_controller`

Generates only the Controller. Available methods:
`index | show | store | update | destroy` (default: all).

Hard rule: the controller **only** calls the `{Resource}Service`. If the
generated content included SQL, the tool fails at build-time with
`ConventionViolationError` without writing the file. In the `ci4` profile the
controller extends `BaseController` and delegates to the Model.

## 3. `scaffold_service`

Generates only the Service (business logic + validation). Rule: if the
repository interface does not exist, it reports it in `warnings` but still
generates the Service injecting the interface (**contract first, implementation
later**). In the `ci4` profile it generates a real Service
(`app/Services/{X}Service.php`) that injects the Model; `withRepository=true`
also generates the Model (reported in `additionalFilesCreated`).

## 4. `scaffold_repository`

Generates **always** interface + implementation together. There is no
implementation without a contract. The implementation uses PDO with
*prepared statements* (SQL-injection safe). Rate limited. In the `ci4` profile
it is a no-op with a warning (CI4 handles data access through Models).

## 5. `validate_route`

**Read only.** Verifies against `app/Config/Routes.php`:

- **Exact** collision (same method + path).
- **Pattern** collision (`/products/{id}` vs `/products/{slug}`).
- Shape errors (unbalanced braces, invalid parameters).

Input: `{ method: "GET|POST|PUT|PATCH|DELETE", path: "/kebab-case/{param}" }`.
Output: `valid`, `conflicts[]`, `suggestions[]`. Never modifies `Routes.php`.

## 6. `run_migration` — DESTRUCTIVE

Runs migrations through the framework's native runner, per profile:
`spec` → `php bin/migrate up|down [migrationName]`; `ci4` →
`php spark migrate` (`migrate:rollback` for `down`).

Input: `{ direction: "up|down", migrationName?, confirm: boolean }`.

**Hard rule**: if `confirm !== true` the tool returns
`DestructiveOpBlockedError` **without touching the database or executing
anything** (tested: zero executions). Rate limited. `migrationName` is validated
with a regex (only `[a-z0-9_]`, optional `.php`) to prevent path traversal.

**On failure** the output is a `MigrationFailedError` with an actionable
message and sanitized `detail`: known patterns (`Parse error` incl. anonymous
classes, missing classes, `SQLSTATE`, undefined functions) are detected and
interpreted; absolute paths are replaced with `<path>`. No raw stack trace is
exposed. Only lines referencing an actual migration file are counted in
`executed` (spark table headers are ignored).

## 7. `lint_against_framework_rules`

Validates a PHP file against the conventions. `compliant=false` if at least one
`error` violation exists; `warning`s do not block.

| Rule | Applies to | Severity |
|---|---|---|
| `missing-strict-types` | all | error |
| `naming-convention` | all (class/file/methods) | error |
| `no-query-in-controller` | Controllers | error |
| `missing-input-validation` | Controllers/Services | error |
| `repository-without-interface` | Repositories | error |
| (layer file without class) | Controllers/Services/Repositories/Entities | warning |

Rules adapt to the profile: in `ci4` `missing-strict-types` and the
`Controller` suffix are **not** required, method names are snake_case, and SQL
in a controller is a `warning` instead of an `error`.

## 8. `scaffold_ci4_mcp_server`

Scaffolds a native, in-app Model Context Protocol (MCP) server Spark command inside a CodeIgniter 4 application (`app/Commands/McpServer.php`).

This enables **dual-architecture live runtime introspection**:
- **Outer MCP (Node/TypeScript)**: Rapid code scaffolding, convention enforcement, route collision validation, safe migrations.
- **Inner MCP (PHP Spark Command)**: Live runtime database schema reflection, safe read-only query execution, dynamic route discovery, and migration status.

**Input**

| Field | Type | Rules |
|---|---|---|
| `commandName` | string | Spark command format (`group:name`), default `"mcp:serve"` |
| `className` | string | `PascalCase`, default `"McpServer"` |
| `readOnly` | bool | Enforces safe read-only database inspection (default `true`) |
| `withDatabaseTools` | bool | Exposes `ci4_db_tables` and `ci4_db_query` (default `true`) |
| `withRouteTools` | bool | Exposes `ci4_routes_list` (default `true`) |
| `withMigrationTools` | bool | Exposes `ci4_migration_status` (default `true`) |
| `overwrite` | bool | Overwrite existing command file (default `false`) |

**Output**

- `filePath`: Path of the generated Spark command (`app/Commands/McpServer.php`)
- `written`: Whether the file was written to disk
- `sparkCommand`: The command line to execute (`php spark mcp:serve`)
- `supportedTools`: Array of in-app tools available (`ci4_db_tables`, `ci4_db_query`, `ci4_routes_list`, `ci4_migration_status`)
- `readOnly`: Whether readOnly mode is active
- `mcpConfigSnippet`: Ready-to-copy JSON configuration block for Claude Code / Cursor / Windsurf / Trae
- `warnings`: Actionable warnings

**Tools exposed by the generated in-app server:**
- `ci4_db_tables`: Lists all tables and schema structure (column types, nullability, primary keys).
- `ci4_db_query`: Executes safe read-only `SELECT` queries (capped at 50 rows, blocks mutations).
- `ci4_routes_list`: Reflects dynamically registered routes and handlers from CodeIgniter's RouteCollection.
- `ci4_migration_status`: Returns current migration batch and version status from the active database.

## End-to-end example

1. Set `APP_ROOT` to an empty framework directory.
2. Call `scaffold_full_resource` with `Product` (see the Tool 1 example).
3. Run `validate_route` over `POST /products` (no collisions).
4. Run `run_migration` with `{ direction: "up", confirm: true }` to create the
   `products` table.
5. Run `lint_against_framework_rules` on every generated file:
   all must return `compliant: true`.
6. Run the generated PHP tests: `vendor/bin/phpunit tests/Unit tests/Integration`.

The resource is functional without manual editing (spec acceptance criterion:
*full CRUD generated in <30s, zero post-generation manual edits*).

## FAQ

**Can I generate only one layer?** Yes: `scaffold_controller`, `scaffold_service`
and `scaffold_repository` generate individual layers with the same rules.

**What happens if a file already exists?** With `overwrite: false` (default) it
is not touched: the tool reports it in `filesSkipped`/`warnings` with `reason:
exists_no_overwrite`.

**Does the server write outside APP_ROOT?** No. `resolveInAppRoot` prevents it
(`ValidationError` on path traversal attempts).

**How do I disable the rate limit?** Raise `RATE_LIMIT_PER_MINUTE` in the
server configuration.

**Do errors expose system paths?** Never. Unexpected errors always return a
generic actionable message.
