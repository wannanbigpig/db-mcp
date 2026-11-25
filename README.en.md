# db-mcp 2.0

[中文](README.md) · [Annotated configuration](docs/CONFIGURATION.md) · [SSH tunnels](docs/SSH.md) · [Deployment security](docs/SECURITY.md) · [Controlled writes and recovery](docs/WRITES.md) · [Validation](docs/VALIDATION.md)

A local stdio MCP server for MySQL, Redis and MongoDB. **Read-only by default.** Use one `config.json` for multiple connections. Each source can have a default database, optional database selection and an SSH tunnel. Development and test profiles can opt into controlled writes. See [Migration from 1.x](#migration-from-1x) before upgrading.

All three databases support SSH tunnels. On macOS or Linux, supply a bastion IP, hostname, or OpenSSH alias. Key authentication uses the local SSH settings, and password authentication adds a password reference. Database TLS verifies the original database identity. See [SSH setup](docs/SSH.md) and the [example](examples/config.ssh.example.json).

## Run with npm

Install Node.js 22 or later and npm. Reuse an existing v2 `config.json`, create one in standard JSON using the [annotated three-engine example](docs/CONFIGURATION.md#三库只读示例), or run `npx --yes @wannanbigpig/db-mcp@2.0.0 --setup` in an interactive terminal to generate a read-only profile. If you use the wizard, copy the path it prints for `config.json` into the MCP entry below.

Merge this `db-mcp` entry into your client configuration and replace the last argument with your absolute configuration path.

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "npx",
      "args": ["--yes", "@wannanbigpig/db-mcp@2.0.0", "--config", "/absolute/path/db-mcp/config.json"]
    }
  }
}
```

Declare each connection once in `sources`. Set the default database with `database`, which defaults to DB 0 for Redis. Set `tls.mode` per source and use `access: {}` for default read-only access. On macOS and Linux, you can keep MySQL/Redis passwords and the MongoDB connection string in the same private config file. Use `chmod 600 /absolute/path/db-mcp/config.json` for inline credentials. See the [configuration reference](docs/CONFIGURATION.md) for secret references, SSH and database selection.

Run the offline config check below. After `CONFIG_VALID`, reload the MCP client, call `list_sources` and try a read against a ready source.

```bash
npx --yes @wannanbigpig/db-mcp@2.0.0 --config /absolute/path/db-mcp/config.json --check
```

## Beginner quick start (recommended)

Run the wizard from source in an interactive macOS or Linux terminal. Install Node.js >= 22 and npm, then download this repository. Prepare the database host, port, database name and account. By default, reads cover everything visible to that account within the configured database, without listing tables, fields or key prefixes first. Prepare an allowlist only if you need narrower scope. Ask your database administrator about connection details if unsure; **never paste passwords into chat**.

### 1. Run the read-only setup wizard

Clone the repository and start the wizard from a terminal.

```bash
git clone https://github.com/wannanbigpig/db-mcp.git
cd db-mcp
npm ci --ignore-scripts
npm run setup
```

The wizard asks for MySQL/Redis/MongoDB, environment and connection details, then read scope after the password. Press Enter for default option `1`: all supported reads within the current fixed database. Choose `2` to enter MySQL/MongoDB tables/collections and fields or Redis literal prefixes. **Database-wide reads can expose sensitive data to the model; choose an allowlist, redacted views or a dedicated reader account when needed.** Redis usernames can default to an existing `default` account; MCP stays read-only and key scanning remains disabled by default.

The wizard defaults to a `production` profile with identity-verified TLS. Provide an absolute CA path for a private CA and optionally specify MongoDB `authSource`. The wizard's local development option uses plaintext on loopback. For an existing read-only configuration, edit each source's `tls.mode` directly.

Password entry is hidden, not echoed or supplied as a command argument. The wizard creates a new private profile directory under `~/.config/db-mcp`, containing a **read-only configuration, mode-0600 secret files and `client.json`**. Configuration uses file references; passwords are absent from configuration and client JSON. Existing configuration is not overwritten, and writes are not enabled.

### 2. Add the entry to your existing MCP client

Open the generated `client.json` at the path printed by the wizard. **Merge only its `db-mcp` entry inside `mcpServers` into your existing client configuration**. If a legacy `db-mcp` entry exists, replace only that entry and disable its old launch command, preserving other servers; do not replace the whole client configuration. Client formats differ: clients without `mcpServers` JSON require converting the entry's `command` / `args` into their corresponding format. The wizard does not modify clients. Save and reload/restart the client; the database connection happens when MCP starts for the first time.

Setup validates configuration only: it does not connect, verify actual TLS handshakes or database grants, or prove that the configured scope is readable. Successful generation is not a connection test. Native read-only accounts are still recommended. Secret files are not an encrypted vault; an Agent with the same OS user's shell/filesystem access can read them. Non-TTY/piped input is rejected. On Windows, use the manual env configuration below.

To choose another location after building, run `node dist/index.js --setup --directory /absolute/private/db-mcp`. The directory must be an absolute private path; a new profile is still created without replacing existing configuration. Use the manual setup below for multiple sources, custom budgets or deployment secret systems.

### 3. Verify the first read

In your MCP client, call `list_sources` and choose a source marked `ready`. Try `mysql_list_tables`, `mongodb_list_collections`, or `redis_type` for a known key. The first request uses the source's configured default database.

## Security contract

- Administrators configure sources before startup. Tools use `sourceId` to select a connection. Read-only multi-database sources can also accept `database`. Connection settings and credentials live in the configuration.
- Supply a v2 config explicitly. Database credentials can be stored in a private config or supplied through env/file references.
- Instance/source/tool/object/field/key policies are intersected on every call, including direct calls to hidden tools.
- Without a read allowlist, `access.readScope` defaults to `database`. Read access follows native grants for the selected database. Other databases require an explicit multi-database setting.
- Omitted `instance.tier` and `source.access.tier` independently default to `read_only`, even for write-capable database accounts. Writes require an explicit non-production `read_write` instance and source, journal, write policy and the particular action opt-in; create/update/delete do not grant one another.
- Set `tls.mode` per source. `verify_identity` verifies the certificate and host identity. Read-only sources can explicitly use `disabled` to connect to a plaintext port. Write-enabled sources can disable TLS only on loopback in development or test.
- No raw SQL, dynamic connections, runtime privilege elevation or model-supplied scripts. Read-only profiles have no write tools; non-production write profiles still require native least privilege.
- Requests, queues, deadlines, item counts and bytes are bounded. Truncated results are explicitly incomplete.
- stdout carries only MCP. stderr audit excludes arguments, results, credentials, targets and raw exceptions.

Secret references prevent credentials from entering tool arguments; they **do not isolate a same-OS-user Agent with shell/filesystem access**. Database content is untrusted data, never instructions or authorization.

## Read/write authorization

Application authorization is the first gate; native database least privilege is a second defense. Account grants, client confirmation and `readOnlyHint` do not authorize MCP writes. Tool arguments cannot change the frozen startup policy.

| Configuration | MCP capability |
| --- | --- |
| Instance/source tiers omitted or both `read_only`, without contradictory write configuration | Scoped reads, metadata and runtime status only; direct write-tool calls are still denied |
| Explicit `read_write` instance with a valid journal, but omitted/`read_only` source tier | That source remains read-only; it does not inherit instance write capability |
| Both tiers explicitly `read_write`, non-production, complete policy, update allowed only | Authorized updates only; inserts and deletes remain denied |
| `writes` on a read-only source, `journal` on a read-only instance, or missing/invalid write prerequisites | Startup rejected; no silent elevation or ignored contradiction |

Writes require all of: an explicit development/test `read_write` instance, a valid independent journal, an explicit `read_write` source, complete object/field/target/condition policy, action opt-in and tool authorization. MySQL/MongoDB use `allowInsert` / `allowUpdate` / `allowDelete`; Redis uses `allowCreate` / `allowReplace` / `allowDelete`. Every flag defaults to `false`. **Complete opt-in does not require enabling all CRUD actions**; there is no universal `full_access`/admin mode. Write profiles require Unix UID/filesystem-permission semantics.

## Setup

Use manual setup for multiple sources or an existing database account. See the [annotated three-engine configuration](docs/CONFIGURATION.md) for field defaults and examples.

Node.js >= 22 and npm are required. Docker and OpenSSL are needed only for isolated integration tests.

Build from the source repository without depending on a published npm version. Run in the repository root:

```bash
npm ci --ignore-scripts
npm run build
cp -n config.example.json config.json
```

Before startup, an administrator must:

1. Fill in the host, database and account in `config.json`. The starter template contains one MySQL source. Add `tls.caFile` for a private CA.
2. The example uses `access: {}` for everything the account can read in the fixed database. Add tables/fields, collections or key prefixes for a narrower scope. Budgets, default ports and read-only access can use their defaults.
3. For a single-file setup, replace the template's `passwordRef` with `password`. Alternatively, pass the referenced environment variable to the MCP process or use an absolute secret file path.
4. Check configuration before starting with the same file; separately verify actual TLS, native grants and data scope before deployment.

Validate from the repository root. Apply file permissions first if your config contains inline credentials.

```bash
chmod 600 config.json
node dist/index.js --config "$PWD/config.json" --check
```

The explicit path must be absolute. `DB_MCP_CONFIG` is an alternative; conflicting CLI/env paths are rejected. `--check` validates configuration, secret references and URIs, reporting `CONFIG_VALID` on stderr, **without connecting or verifying real grants, TLS handshakes or journal availability**. Normal startup initializes the journal if configured, then connects to databases. The server waits for MCP input without a stdout startup banner.

On macOS and Linux, set `password` for MySQL or Redis and `connectionString` for MongoDB. For each source, supply either the inline value or its reference. A config containing inline credentials must be a regular file owned by the current user with mode `0600` or stricter and no leaf symlink. If `--check` reports `CONFIG_SECRET_FILE_UNSAFE`, correct the file permissions. Keep credential-bearing config files out of Git.

`passwordRef` and `connectionStringRef` accept `env:NAME` or `file:/absolute/path`. Unix secret files must be current-UID-owned regular files, mode `0600` or stricter, nonempty, at most 64 KiB, with no leaf symlink. File references remove one trailing newline. Windows uses env references.

Replace the paths in this example with absolute paths. JSON-based MCP clients can merge this stdio entry.

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/absolute/path/db-mcp/dist/index.js", "--config", "/absolute/path/db-mcp/config.json"]
    }
  }
}
```

In Codex, add the same entry to `~/.codex/config.toml`. [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```toml
[mcp_servers.db-mcp]
command = "node"
args = ["/absolute/path/db-mcp/dist/index.js", "--config", "/absolute/path/db-mcp/config.json"]
```

In a graphical stdio setup form, enter `node` as the command and add each argument separately. Use the absolute path from `command -v node` if the client cannot find it. For an environment reference, pass the existing variable in the Codex entry with `env_vars = ["DB_MCP_MYSQL_PASSWORD"]`. Reload the MCP client after saving.

## Sources and tools

Put the connection settings in one read-only source and use `database` for its default database. Set `databaseScope` to `visible` to enable more databases. MySQL and MongoDB discover database names visible to the account. MySQL database names can contain hyphens, such as `reporting-archive`. In Redis, add numeric `databases` entries for additional indexes.

`excludeDatabases` is optional. It accepts database names or Redis indexes, filters discovery and denies direct selection. The default database cannot be excluded. Use `list_databases` to find available options and pass `database` to a read tool with the same `sourceId`. Omit it to use the default. Keep the same database for page and Redis fragment continuations. Database grants and the source's existing table, collection, field and key restrictions apply in every selected database. MongoDB keeps the configured connection string and authentication database. Redis reserves one connection per enabled database and opens alternate connections on demand.

`access.readScope` accepts `database` or `allowlist`. When omitted without any range properties, it defaults to `database`. Existing `tables` / `columns`, `collections` / `fields` or `keyPrefixes` properties infer `allowlist`; even empty lists must pass allowlist validation rather than silently widening access. Explicit `database` conflicts with nonempty allowlists and is read-only only; write sources require an explicit allowlist policy.

With `access.readScope: "database"`, queries follow native grants and query/byte budgets in the selected database. MySQL and MongoDB can read visible tables, collections and fields. Redis allows known-key reads, and scanning requires a separate opt-in.

MySQL sources declare the host, database, username, TLS settings, and either `password` or `passwordRef`. The port defaults to 3306. Allowlist profiles also declare `access.tables` and optional `access.columns`. Use reviewed redacted views and a dedicated reader account. Omitted columns in allowlist mode authorize all columns of that table. MySQL `tls.mode: verify_identity` requires a certificate-matching DNS hostname.

Redis read-only sources can omit `username` to use `default`, or name an existing dedicated ACL user. Write sources require a non-default dedicated user and complete write authorization. The default `database` index is `0`. Read-only multi-database sources can select the configured additional indexes. `allowKeyspaceScan` defaults to `false`, including database-wide read profiles. Allowlist profiles use literal `access.keyPrefixes`. Native Redis ACL key patterns do not isolate SCAN responses, and application filtering does not provide database-side tenant metadata isolation.

MongoDB sources require `database` and either `connectionString` or `connectionStringRef`. Allowlist mode requires explicit fields for every authorized collection. A URI must contain nonempty credentials and the matching database path. The connection targets one fixed host and rejects SRV, discovery and automatic failover. Accepted URI options are `authSource`, `replicaSet` and `directConnection=true`. URI settings for TLS, retries and the connection pool are rejected. Authorizing a parent field also authorizes its nested content. Use redacted views for stronger boundaries.

Every source defaults to `required: true`, so an initial connection failure prevents startup. An SSH source with `required: false` connects in the background after required and optional direct sources finish their startup probes. The MCP handshake proceeds independently. `list_sources` reports `reconnecting` during the first background attempt and after transient connection loss, then `ready` once the database probe passes. Restart to load changes to credentials, CAs, or fixed targets. `access.allowedTools` narrows engine tools/write workflows; it cannot elevate a read-only source. Allowing `*_prepare_write` allows the corresponding controlled commit/status workflow once all write gates pass, not a preview-only permission. Global `commit_write`/`operation_status` are not source allowlist entries.

| Tools | Contract |
| --- | --- |
| `list_sources`, `server_runtime_status` | Source status, enabled tools, read scope, and row limit / global concurrency status |
| `list_databases` | Paginated database choices for an enabled multi-database source |
| `mysql_list_tables` | Paginated table and view names within the selected database and any configured allowlist |
| `mysql_select`, `mysql_describe_table` | Reads in the selected database with parameterized equality/NULL filters and permitted sorts, or paginated scoped column metadata |
| `redis_get`, `redis_get_range` | Bounded GETRANGE fragments, base64 encoded; never unbounded GET |
| `redis_type`, `redis_memory_usage` | Exact scoped key; fixed MEMORY SAMPLES 5 |
| `redis_keys` | Paginated scan with explicit opt-in and a configured literal prefix in allowlist mode or an empty prefix in database mode |
| `mongodb_find`, `mongodb_find_one` | Fixed-database reads; mandatory field projection in allowlist mode, scalar equality or `$oid`, bounded cursor |
| `mongodb_list_collections` | Paginated collection names within the selected database and any configured allowlist |
| `mysql_prepare_write`, `mongodb_prepare_write`, `redis_prepare_write` | Explicit non-production write profile only; complete verified primary key / `_id` / exact key, version/value/TTL conditions |
| `commit_write`, `operation_status` | Execute the bound operation ID once / query durable status; unknown is never replayed; previews are not human approval |

Use `list_sources` to choose a source by its `purpose`, `status`, and `enabledTools`. Each source reports its `readScope` and per-request `maxRows`. The `sourceId` choices in `tools/list` reflect configured access. Sources with `redis_keys` enabled report `scanPrefixes`. Choose a listed prefix in allowlist mode, or omit `prefix` or pass the empty string in database mode.

Example `mysql_select`:

```json
{ "sourceId": "reports", "table": "v_report_safe", "columns": ["id", "name"], "where": { "id": 1 }, "limit": 10 }
```

Example `mongodb_find`:

```json
{ "sourceId": "documents", "collection": "reports", "filter": { "_id": { "$oid": "507f1f77bcf86cd799439011" } }, "fields": ["name"], "limit": 10 }
```

Data-reading tools return `rows` and `truncated` in MCP text content. Budget truncation adds `reason`. Multi-row queries without pagination mark results truncated when they reach the row limit. A successful single result from `mongodb_find_one` or an exact Redis read completes the row stream. Byte limits can still truncate the result. Global status and write tools have their own response contracts.

`mysql_list_tables`, `mysql_describe_table`, `mongodb_list_collections`, and `redis_keys` accept optional `limit` and `cursor` arguments. Omit `cursor` on the first request, then pass the returned `nextCursor` to the same tool with the same `sourceId` and table or Redis prefix. Stop when the response has no `nextCursor`. Redis returns `reason: "scan_pages"` and a cursor on reaching the per-request `maxScanPages`, even when that page has no rows.

Cursors are valid within the running service process. Each request still enforces authorization and the existing time, count, and byte budgets. MySQL uses stable ordering, MongoDB follows the server's enumeration order, and Redis resumes from a native SCAN position. Concurrent database changes can cause repeated or missing items across pages. Deep MongoDB pages stream past the preceding entries within the request deadline.

Pass the `key` returned by `redis_keys` directly to the exact-key read tools. UTF-8 keys are strings, and other keys are `{ "base64": "..." }` objects. Scans deduplicate and match allowlist prefixes by raw bytes. Read tools accept keys of up to 4096 bytes subject to request and response budgets. A scan returns `BUDGET_EXCEEDED` when a matching key exceeds the length limit or cannot fit in the request budget.

`redis_get` and `redis_get_range` still return Base64 fragments with `bytes`, `offset`, and `complete`. `complete` means the fragment covers the whole value from offset zero. When `hasMore` is true, pass `nextOffset` to `redis_get_range` for the same key. The final fragment reports `hasMore: false`, and a nonzero offset still leaves `complete: false`. An empty fragment can represent an empty or missing key. Concurrent changes can affect successive fragments.

`maxItemBytes` measures each record as JSON. `maxResponseBytes` measures the serialized MCP tool result in UTF-8, including escaped text content and truncation metadata. String reads on a Redis key of another type return `REDIS_WRONG_TYPE`. Use `redis_type` to inspect the key. A Redis command deadline closes a stalled shared connection. An SSH source reports `reconnecting` while recovering, and a direct Redis source reports `unavailable`.

MySQL JSON columns return the database's JSON text as strings, preserving exact decimal/integer literals and JSON types instead of automatically decoding them. JSON null is the string `"null"`; SQL NULL remains `null`. Consumers needing structured data with exact numbers must use a lossless JSON parser rather than ordinary `JSON.parse` into JavaScript numbers. Encoded text counts toward byte budgets.

MySQL and MongoDB equality filters and write keys and values reject JSON numbers outside the JavaScript safe integer range. The tool returns `INVALID_ARGUMENT` with `details.reason` set to `UNSAFE_INTEGER` and the argument path, such as `$.where.*`.

Tool errors retain `isError: true` and text JSON with `code`, `message`, and `requestId`. Recognized errors may include a sanitized `details.reason` and `details.path`. Read errors can also include `details.nextAction`. For example, restart the same list from its first page after `invalid_cursor`, or retry a read later after `queue_full`. Diagnostics omit raw database errors and input values.

## Controlled development/test writes

Use a separate instance, account and genuinely isolated database with [config.write.example.json](examples/config.write.example.json) and the [write guide](docs/WRITES.md). Do not label production as test to bypass restrictions, or assume changing two tiers to `read_write` is deployment-ready.

Administrators must pre-create the journal directory outside the repository: a real directory owned by the current UID, mode 0700 or stricter, with a trusted path and reliable rename/fsync semantics. Do not use unverified shared/NFS storage; `--check` neither creates nor verifies this directory.

- MySQL requires InnoDB, the complete PRIMARY KEY, an integer version and a reviewed fixed metadata guard. MongoDB requires a fixed replica-set primary, `_id`, version and transactions. Redis 7+ requires exact string keys, expected value/TTL conditions and a fixed atomic script. No arbitrary SQL/scripts, DDL, bulk writes or upsert.
- Call the engine's `*_prepare_write` to obtain a server-generated `operationId`, valid for 60 seconds by default. Previewing does not modify business data and is not human approval or a backup.
- Each preview durably registers a new operation, even for identical arguments, and consumes journal capacity. Preview tools are therefore annotated as non-read-only, non-idempotent and non-destructive.
- `commit_write` accepts only the bound `sourceId` and `operationId`; preview arguments cannot change, and repeated commits of the same ID do not replay. Inspect `state` / `effect` / `journalDegraded`, not only `isError`.
- Timeouts/lost confirmations can yield `unknown_outcome`, not proof that nothing ran. Query `operation_status`; do not retry with a new ID, compensate automatically or delete records. An unknown outcome blocks new writes on its source.
- An unhealthy journal closes writes not yet sent. Confirmed database success remains success with a degradation marker if final journaling fails. See the write guide for capacity, private directory permissions, crash locks, credential rotation and administrator recovery.

No generic rollback, cross-database transactions, cross-instance deduplication or exactly-once guarantee. Production writes, trusted human approval, Keychain, short-lived cloud credentials and hot rotation are outside the current supported scope.

## Budgets and limitations

Per-source defaults: maxRows 200, maxResponseBytes 65536, maxItemBytes 16384, maxRequestBytes 32768, maxConcurrent 2, maxQueued 20, maxConnections 2, connectTimeoutMs 10000, queueTimeoutMs 2000, queryTimeoutMs 5000, maxScanPages 50.

Instance defaults: maxSources 4, maxConcurrent 4, maxQueued 40, maxConnections 8, maxRequestBytes 65536. Connection accounting reserves MySQL concurrent connections, one Redis connection per source (plus maxConcurrent dedicated write sockets for writers), and MongoDB pool connections plus two monitors per fixed host. MySQL discards each connection after an operation instead of pooling unread/session-contaminated results; measure connection overhead before deployment.

Queue waiting counts toward total deadlines. Cancelled queued jobs never run; actual application cleanup retains capacity. Cancellation is not guaranteed to stop database computation immediately. For reads, MySQL uses read-only transactions, streamed native prepared execution and server MAX_EXECUTION_TIME; MongoDB uses batchSize 1/maxTimeMS/cursor cleanup/no read/write retries; Redis disables offline queuing/reconnect and caps its internal queue. Controlled writes use the separate transactions/atomic operations described above, never DML in a read-only transaction.

Instance and source execution permits are acquired together. A request waiting for source capacity does not reserve an instance execution slot, allowing eligible sources to proceed. A pending request counts against both queues; either queue's limit can reject new waiters. queueTimeoutMs covers the single combined wait.

These are acquisition/response limits, **not a hard RSS cap for arbitrary large rows/documents/SCAN replies**. Drivers can decode a single oversized item before checks. Expose only bounded, reviewed fields/views and enforce container/database resource limits. Stdio bounds each newline-delimited message before JSON parsing and uses a fixed-size incomplete-frame buffer; coalesced valid messages are processed separately.

The transport closes when stdout backlog reaches 2 MiB. stderr audit is bounded and best-effort: backpressure or a closed receiver can drop records without terminating MCP. It is not lossless audit storage; the durable write journal is independent.

## Migration from 1.x

1. Provision narrow native read-only accounts. Rotate historical credentials if they entered Git/chat.
2. Configure v2 sources with dedicated database accounts. Use a private local file for inline credentials, or use env/file references.
3. Update client launch arguments and mandatory `sourceId`; replace raw SQL with structured selects, MongoDB operator filters with equality, and Redis GET with fragment handling.
4. Remove dependencies on connect/disconnect, legacy write tools, security-mode switching and unbounded hashes/rankings/aggregation. There are no compatibility aliases. Required development/test writes use a separately deployed controlled profile, not the old dynamic interfaces.
5. Run configuration checks and isolated TLS/grant/contract tests before administrator deployment. Stop on failure; do not restore unsafe defaults as a rollback.

Legacy DB_MCP_CONFIG_PATH/security-mode/connection/budget environment variables no longer modify configuration. The 1.x implementation and its dedicated tests are isolated under `legacy/`, outside the v2 executable and release package. Active concurrency/timeout utilities and their tests remain under `src/`. The legacy `config.json.example` is replaced by the new template; local configuration is not automatically migrated/read.

## Configuration diagnostics and editor support

`npm run build` generates `dist/config/config.schema.json` for editor completion and npm packaging. Edit your `config.json` to configure db-mcp. The `$schema` reference is optional and can use an absolute path if you move the configuration. `node dist/index.js --print-config-schema` prints the current schema. `--check` reports enabled tools on success or redacted paths and stable reason codes on failure.

The wizard selects direct or SSH access before database addresses, explaining which machine must resolve/reach the destination. Passwords are single-line only. The terminal enables bracketed paste, keeps a complete paste hidden and cancels multiline pastes; use a terminal supporting bracketed paste and avoid multiline secrets.

MongoDB `find/find_one` results now use canonical Extended JSON, retaining BSON type tags, ObjectIds, non-finite numbers, regular expressions and binary subtypes. Legacy BSON Undefined is returned as `{"$undefined":true}`. A BSON date outside the JavaScript Date range causes the read to return `BSON_DATE_OUT_OF_RANGE`. Decode Extended JSON rather than assuming every numeric field is a JSON number. Equality-filter inputs are unchanged. MySQL JSON columns follow the text contract above; Redis uses bounded base64 fragments.

A MongoDB source can opt into `"requireIndexedReads": true` (default false). The same authorized query is checked using its winning plan before reading; collection scans and unrecognized plans return `QUERY_REQUIRES_INDEX`. This does not expand access or expose internal plans, and does not freeze indexes/plans between inspection and execution. Validate indexes and grants with the target server version before enabling it.

## Development

CI compares the generated schema with the configuration definition using `npm run schema:check`.

```bash
npm test
# Separate reports: npm run test:current / npm run test:legacy
npm run schema:check
npm run test:integration
npm audit --omit=dev --registry=https://registry.npmjs.org
npm pack --dry-run --ignore-scripts
npm run verify:artifact
```

Default tests include unit tests and a real stdio subprocess, skipping two Docker aggregates. `npm run test:integration` separately runs both read and write aggregates with disposable mysql:8.4.8 / redis:7.4.7 / mongo:7.0.31, random loopback ports, isolated accounts and temporary certificates. Cleanup targets only the test's containers/anonymous volumes/temp files; image caches remain. No existing databases are accessed. Authorization controls include native CRUD succeeding for the same account while default/explicit read-only MCP rejects writes and leaves data unchanged.

Current test environments, results, artifacts and remaining gaps are maintained in [validation evidence](docs/VALIDATION.md). Offline `--check` does not establish real SSH/VPN, database TLS/grants, client or remote CI acceptance.

[Support the project](docs/SPONSOR.en.md) · MIT · Issues and pull requests welcome.
