# db-mcp 2.0 配置参考

数据库连接集中写在一个 `config.json`，每个连接在 `sources` 中占一项。可从[最小 MySQL 模板](../config.example.json)开始，也可使用 [README 中的交互向导](../README.md#新手快速开始推荐)。下面是带注释的 JSONC 示例，保存为 `config.json` 时使用标准 JSON，去掉注释和注释行。

## 三库只读示例

示例使用环境变量引用。填写实际连接时，保留自己需要的 source，给每项使用唯一的 `id`。示例采用 TLS 身份校验。

```jsonc
{
  // 可选。构建后为支持 JSON Schema 的编辑器提供补全。
  "$schema": "./dist/config/config.schema.json",
  "version": 2, // 必填。v2 配置版本。
  "instance": {
    "name": "db-mcp-read",       // 必填。自定义实例名。
    "transport": "stdio",       // 必填。由 MCP 客户端启动本机进程。
    "environment": "production", // 必填。也可填 development 或 test。
    "tier": "read_only"        // 可省略，默认只读。
  },
  "sources": [
    {
      "id": "reports-mysql",       // 必填。工具调用里的 sourceId。
      "engine": "mysql",          // 必填。选择 MySQL 驱动。
      "purpose": "查询报表",        // 可选。list_sources 会显示这段用途。
      "required": true,           // 可省略，默认 true。启动探测失败会阻止服务启动。
      "host": "mysql.example.com", // 必填。可加 port，默认 3306。
      "database": "reporting",    // 必填。省略工具参数 database 时使用这个库。
      "username": "mcp_reader",   // 必填。使用专用只读 MySQL 账号。
      "passwordRef": "env:DB_MCP_MYSQL_PASSWORD", // 与 password 二选一。
      "tls": { "mode": "verify_identity" },        // 必填。校验证书和数据库 DNS 名。
      "access": {}               // 必填。空对象采用默认只读和库内读取范围。
    },
    {
      "id": "reports-redis",
      "engine": "redis",
      "host": "redis.example.com", // 必填。可加 port，默认 6379。
      "database": 0,                // 可省略，默认 DB 0。取值为 0–15 的整数。
      "username": "mcp_reader",     // 可省略，默认 Redis 的 default 用户。
      "passwordRef": "env:DB_MCP_REDIS_PASSWORD",
      "tls": { "mode": "verify_identity" },
      "access": {}                 // 默认可按已知 key 读取，扫描默认关闭。
    },
    {
      "id": "reports-mongo",
      "engine": "mongodb",
      "database": "reporting",                // 必填。须与连接串的库路径一致。
      "connectionStringRef": "env:DB_MCP_MONGO_URI", // 与 connectionString 二选一。
      "tls": { "mode": "verify_identity" },
      "access": {}
    }
  ]
}
```

## 凭据、TLS 和 SSH

| 配置项 | 怎么填 |
| --- | --- |
| MySQL / Redis 的 `password` 或 `passwordRef` | 在私有配置里直接填密码，或使用 `env:变量名`、`file:/绝对路径`。每项选一种。MySQL 的 `username` 不能用 `root`。 |
| MongoDB 的 `connectionString` 或 `connectionStringRef` | 直接填 URI，或引用存放完整 URI 的环境变量或文件。URI 包含一个主机、有效账号密码及默认库路径。账号建在其他认证库时，通过 URI 的 `authSource` 指定。对账号密码中的 URI 保留字符做百分号编码。 |
| `tls.mode` | `verify_identity` 验证数据库证书和主机身份。`disabled` 用于只读源连接明文端口，开发或测试的可写回环源也可使用。 |
| `tls.caFile` | 仅在 `verify_identity` 模式用到。填写私有 CA 的绝对路径，省略时使用 Node.js 的默认信任库。 |
| `ssh.host` | 仅在通过跳板机时填写。支持 IP、DNS 名称及 `~/.ssh/config` 中的别名。系统 OpenSSH 使用本机的用户、端口、密钥和已知主机配置。 |
| `ssh.passwordRef` | 密码方式登录跳板机时填写。支持环境变量或私有文件引用。数据库密码仍填在数据源对应的密码字段。 |

把直接填写凭据的配置保存为当前用户拥有的普通文件，权限设为 `0600` 或更严。用 `chmod 600 config.json` 设置权限。文件引用采用相同的所有者和权限规则。Windows 可以用环境变量引用凭据。通过 SSH 时，数据库地址填写跳板机侧可访问的地址。见 [SSH 通道说明](SSH.md)。

设置 `required: false` 可让连接失败的数据源保持 `unavailable`，其他数据源继续工作。可选的 SSH 数据源会在后台初始化。

## 默认库、切库和可读范围

| 配置项 | 默认值和作用 |
| --- | --- |
| `databaseScope` | 默认 `default`，只开放默认库。只读源可设为 `visible`，通过 `list_databases` 查找并选择其他库。 |
| `databases` | 只用于开启多库的 Redis。列出额外开放的逻辑库编号，例如 `[1, 2]`。默认库一直由 `database` 指定。 |
| `excludeDatabases` | 可选。MySQL/MongoDB 填库名，Redis 填数字编号。匹配的库不会出现在列表中，直接调用也会被拒绝。禁止排除默认库。 |
| `access.tier` | 默认 `read_only`。开发和测试的显式写入配置见[受控写入指南](WRITES.md)。 |
| `access.readScope` | 没有名单时默认 `database`，开放当前所选库内账号可读的范围。填写表、集合、字段或 key 前缀时可显式设为 `allowlist`。 |
| MySQL `access.tables` / `access.columns` | 限制表和列。允许的表如果省略对应的 `columns` 条目，允许读取该表的全部列。 |
| MySQL `access.rawSql` | 默认且只允许 `false`。使用 `mysql_select` 等结构化工具。 |
| MongoDB `access.collections` / `access.fields` | 限制集合和字段。名单模式下每个集合都要填写字段。可用 `profile.name` 这样的点路径。 |
| Redis `access.keyPrefixes` / `access.allowKeyspaceScan` | 前者匹配字面 key 前缀。后者默认 `false`，需要调用 `redis_keys` 时才开启。 |
| `access.allowedTools` | 可选，进一步缩小工具范围。省略时使用该数据源符合权限条件的工具。 |
| MongoDB `requireIndexedReads` | 默认 `false`。启用后，读取要通过索引计划检查。 |

开启多库后仍使用同一个 `sourceId`。例如在 `mysql_list_tables` 中传 `database: "reporting-archive"`，也可省略该参数使用默认库。切库仍受数据库账号、黑名单和表/字段等限制。分页及 Redis 分段续读沿用本次选择的库。

假设 `list_databases` 已返回 `reporting-archive`，用以下参数给 `mysql_list_tables` 取该库的第一项表元数据。

```json
{
  "sourceId": "reports-mysql",
  "database": "reporting-archive",
  "limit": 1
}
```

## 预算和故障提示

一般先用默认预算。实例预算放在 `instance.budgets`，单个数据源预算放在该 source 的 `budgets`。

| 配置项 | 实例默认值 | 数据源默认值 | 用途 |
| --- | --- | --- | --- |
| `maxSources` | `4` | — | 可配置的数据源总数 |
| `maxConnections` | `8` | `2` | 数据库连接预算 |
| `maxConcurrent` | `4` | `2` | 同时执行的工具调用 |
| `maxQueued` | `40` | `20` | 等候执行的调用数 |
| `maxRequestBytes` | `65536` | `32768` | 单次请求的 UTF-8 字节上限 |
| `maxRows` / `maxResponseBytes` / `maxItemBytes` | — | `200` / `65536` / `16384` | 行数、总响应和单项字节上限 |
| `connectTimeoutMs` / `queueTimeoutMs` / `queryTimeoutMs` | — | `10000` / `2000` / `5000` | 连接、排队和查询超时 |
| `maxScanPages` | — | `50` | 单次 Redis 扫描的页数上限 |

默认每个 MySQL 源计 2 条连接，MongoDB 源计 2 条连接加 2 条监控连接，Redis 只读源每个开放的 DB 计 1 条。例如 3 个 MySQL、1 个 MongoDB 和 1 个 Redis DB 需要 5 个 source 和 11 条连接额度。更多计算规则见 [README 预算说明](../README.md#预算与运行边界)。

- `SOURCE_BUDGET_EXCEEDED` 或 `CONNECTION_BUDGET_EXCEEDED` 表示配置超出实例预算。
- `CONFIG_SECRET_FILE_UNSAFE` 时检查含凭据的配置文件权限和所有者。
- `SSH_HOST_KEY_MISMATCH` 时检查跳板机的已知主机记录或已配置的指纹。
- `DATABASE_TLS_INVALID` 时检查端口是否支持 TLS、CA 与证书主机名。

保存后运行 `node dist/index.js --config "$PWD/config.json" --check` 做离线检查。启动 MCP 客户端后调用 `list_sources`，确认相应数据源显示 `ready`，再实际执行一次只读查询。
