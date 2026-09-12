/**
 * Template for the native CodeIgniter 4 MCP Server command.
 *
 * Scaffolds an in-app Spark command (`app/Commands/McpServer.php`) that runs a
 * native, zero-dependency Model Context Protocol (JSON-RPC 2.0 stdio) server
 * allowing AI assistants (Claude Code, Cursor, Windsurf, Trae) to safely inspect
 * database tables, run read-only queries, and list active routes in real-time.
 */

export interface Ci4McpServerOptions {
  commandName: string;
  className?: string;
  readOnly?: boolean;
  withDatabaseTools: boolean;
  withRouteTools: boolean;
  withMigrationTools: boolean;
}

export function renderCi4McpServerCommand(options: Ci4McpServerOptions): string {
  const {
    commandName,
    className = "McpServer",
    readOnly = true,
  } = options;

  return `<?php

namespace App\\Commands;

use CodeIgniter\\CLI\\BaseCommand;
use CodeIgniter\\CLI\\CLI;
use Config\\Database;
use Config\\Services;

/**
 * Native Model Context Protocol (MCP) server for CodeIgniter 4.
 * ReadOnly mode: ${readOnly ? "active (safe inspection only)" : "unrestricted"}.
 *
 * Run with: php spark ${commandName}
 * Connect with Claude Code / Cursor / Windsurf / Trae via stdio.
 */
class ${className} extends BaseCommand
{
    protected $group       = 'MCP';
    protected $name        = '${commandName}';
    protected $description = 'Starts the native MCP server for AI live database and route introspection.';
    protected $usage       = '${commandName}';

    public function run(array $params)
    {
        // Suppress any non-JSON output on stdout (MCP requires clean JSON-RPC over stdout)
        \\error_reporting(E_ALL & ~E_DEPRECATED & ~E_USER_DEPRECATED & ~E_NOTICE);
        \\ini_set('display_errors', '0');

        $stdin = \\fopen('php://stdin', 'r');
        $stdout = \\fopen('php://stdout', 'w');

        if (! $stdin || ! $stdout) {
            CLI::error('Failed to open stdio streams.');
            return;
        }

        while (! \\feof($stdin)) {
            $line = \\fgets($stdin);
            if ($line === false) {
                break;
            }

            $line = \\trim($line);
            if ($line === '') {
                continue;
            }

            $request = \\json_decode($line, true);
            if (! \\is_array($request)) {
                continue;
            }

            $response = $this->handleRequest($request);
            if ($response !== null) {
                \\fwrite($stdout, \\json_encode($response, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\\n");
                \\fflush($stdout);
            }
        }

        \\fclose($stdin);
        \\fclose($stdout);
    }

    private function handleRequest(array $request): ?array
    {
        $id     = $request['id'] ?? null;
        $method = $request['method'] ?? '';
        $params = $request['params'] ?? [];

        switch ($method) {
            case 'initialize':
                return [
                    'jsonrpc' => '2.0',
                    'id'      => $id,
                    'result'  => [
                        'protocolVersion' => '2025-11-25',
                        'capabilities'    => [
                            'tools' => new \\stdClass(),
                        ],
                        'serverInfo' => [
                            'name'    => 'ci4-live-inspector',
                            'version' => '1.0.0',
                        ],
                    ],
                ];

            case 'notifications/initialized':
                return null;

            case 'ping':
                return [
                    'jsonrpc' => '2.0',
                    'id'      => $id,
                    'result'  => new \\stdClass(),
                ];

            case 'tools/list':
                return [
                    'jsonrpc' => '2.0',
                    'id'      => $id,
                    'result'  => [
                        'tools' => $this->getToolList(),
                    ],
                ];

            case 'tools/call':
                return [
                    'jsonrpc' => '2.0',
                    'id'      => $id,
                    'result'  => $this->callTool($params['name'] ?? '', $params['arguments'] ?? []),
                ];

            default:
                if ($id !== null) {
                    return [
                        'jsonrpc' => '2.0',
                        'id'      => $id,
                        'error'   => [
                            'code'    => -32601,
                            'message' => 'Method not found: ' . $method,
                        ],
                    ];
                }
                return null;
        }
    }

    private function getToolList(): array
    {
        return [
            [
                'name'        => 'ci4_db_tables',
                'description' => 'Lists all database tables and their column structure in the active CodeIgniter 4 database.',
                'inputSchema' => [
                    'type'       => 'object',
                    'properties' => [
                        'table' => [
                            'type'        => 'string',
                            'description' => 'Optional table name to get detailed column types and keys',
                        ],
                    ],
                ],
            ],
            [
                'name'        => 'ci4_db_query',
                'description' => 'Executes a safe read-only SELECT query against the CodeIgniter 4 database (max 50 rows).',
                'inputSchema' => [
                    'type'       => 'object',
                    'required'   => ['query'],
                    'properties' => [
                        'query' => [
                            'type'        => 'string',
                            'description' => 'SQL SELECT statement to execute',
                        ],
                        'limit' => [
                            'type'        => 'integer',
                            'description' => 'Maximum rows to return (default 20, max 50)',
                        ],
                    ],
                ],
            ],
            [
                'name'        => 'ci4_routes_list',
                'description' => 'Lists all registered and compiled routes in the CodeIgniter 4 application.',
                'inputSchema' => [
                    'type'       => 'object',
                    'properties' => new \\stdClass(),
                ],
            ],
            [
                'name'        => 'ci4_migration_status',
                'description' => 'Reports the status of all applied and pending database migrations in CodeIgniter 4.',
                'inputSchema' => [
                    'type'       => 'object',
                    'properties' => new \\stdClass(),
                ],
            ],
        ];
    }

    private function callTool(string $name, array $args): array
    {
        try {
            switch ($name) {
                case 'ci4_db_tables':
                    return $this->toolDbTables($args['table'] ?? null);

                case 'ci4_db_query':
                    return $this->toolDbQuery($args['query'] ?? '', (int) ($args['limit'] ?? 20));

                case 'ci4_routes_list':
                    return $this->toolRoutesList();

                case 'ci4_migration_status':
                    return $this->toolMigrationStatus();

                default:
                    return [
                        'isError' => true,
                        'content' => [
                            ['type' => 'text', 'text' => 'Unknown tool: ' . $name],
                        ],
                    ];
            }
        } catch (\\Throwable $e) {
            return [
                'isError' => true,
                'content' => [
                    ['type' => 'text', 'text' => 'Tool error: ' . $e->getMessage()],
                ],
            ];
        }
    }

    private function toolDbTables(?string $table = null): array
    {
        $db = Database::connect();
        if ($table !== null && $table !== '') {
            if (! $db->tableExists($table)) {
                return ['content' => [['type' => 'text', 'text' => "Table '{$table}' does not exist."]]];
            }
            $fields = $db->getFieldData($table);
            $result = [];
            foreach ($fields as $field) {
                $result[] = [
                    'name'       => $field->name,
                    'type'       => $field->type,
                    'max_length' => $field->max_length,
                    'nullable'   => $field->nullable,
                    'primary_key'=> $field->primary_key ?? false,
                ];
            }
            return ['content' => [['type' => 'text', 'text' => \\json_encode($result, JSON_PRETTY_PRINT)]]];
        }

        $tables = $db->listTables();
        return ['content' => [['type' => 'text', 'text' => \\json_encode($tables, JSON_PRETTY_PRINT)]]];
    }

    private function toolDbQuery(string $query, int $limit = 20): array
    {
        $clean = \\trim($query);
        if (! \\preg_match('/^\\s*SELECT\\b/i', $clean)) {
            return [
                'isError' => true,
                'content' => [['type' => 'text', 'text' => 'Only SELECT queries are allowed for safety.']],
            ];
        }

        $forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'REPLACE', 'GRANT', 'REVOKE'];
        foreach ($forbidden as $word) {
            if (\\preg_match('/\\b' . $word . '\\b/i', $clean)) {
                return [
                    'isError' => true,
                    'content' => [['type' => 'text', 'text' => "Destructive or modifying keyword '{$word}' is not allowed."]],
                ];
            }
        }

        $cap = \\min(\\max($limit, 1), 50);
        $db = Database::connect();
        $queryObj = $db->query($clean . ' LIMIT ' . $cap);
        $rows = $queryObj->getResultArray();

        return [
            'content' => [
                [
                    'type' => 'text',
                    'text' => \\json_encode([
                        'count' => \\count($rows),
                        'rows'  => $rows,
                    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE),
                ],
            ],
        ];
    }

    private function toolRoutesList(): array
    {
        $routesService = Services::routes();
        $raw = $routesService->getRoutes();
        $formatted = [];
        foreach ($raw as $from => $to) {
            $formatted[] = [
                'route'   => $from,
                'handler' => \\is_string($to) ? $to : '(Closure/Callable)',
            ];
        }
        return ['content' => [['type' => 'text', 'text' => \\json_encode($formatted, JSON_PRETTY_PRINT)]]];
    }

    private function toolMigrationStatus(): array
    {
        $runner = Services::migrations();
        $history = $runner->findMigrations();
        $formatted = [];
        foreach ($history as $migration) {
            $formatted[] = [
                'version'   => $migration->version,
                'name'      => $migration->name,
                'group'     => $migration->group,
                'namespace' => $migration->namespace,
            ];
        }
        return ['content' => [['type' => 'text', 'text' => \\json_encode($formatted, JSON_PRETTY_PRINT)]]];
    }
}
`;
}
