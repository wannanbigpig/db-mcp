# db-mcp 2.0

[English](README.en.md) · [配置项说明](docs/CONFIGURATION.md) · [SSH 通道](docs/SSH.md) · [安全部署](docs/SECURITY.md) · [受控写入与恢复](docs/WRITES.md) · [验证记录](docs/VALIDATION.md)

面向 MySQL、Redis、MongoDB 的本地 stdio MCP 服务。**默认只读**，一份 `config.json` 可管理多个连接。每个连接可设默认库、按需开启多库和配置 SSH。开发及测试实例可显式启用受控写入。旧版用户先看[从 1.x 迁移](#从-1x-迁移)。

## 通过 npm 启动

安装 Node.js 22 或更高版本及 npm。已有 v2 `config.json` 可以直接沿用。首次配置可以按[带注释的三库示例](docs/CONFIGURATION.md#三库只读示例)在本机创建一份标准 JSON，或在交互终端运行 `npx --yes @wannanbigpig/db-mcp@2.0.0 --setup` 生成只读配置。使用向导时，取它打印的 `config.json` 路径填入下面的客户端配置。

在支持 `mcpServers` 的客户端中合并下面的 `db-mcp` 条目。把最后一项换成本机 `config.json` 的绝对路径。在图形界面中，启动命令填 `npx`，四个参数按顺序分四项添加。

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

每个连接在 `sources` 里写一项。`database` 是默认库，Redis 省略时使用 DB 0。`tls.mode` 按数据源填写，`access: {}` 使用默认只读范围。macOS/Linux 上，可以把 MySQL/Redis 的 `password` 和 MongoDB 的 `connectionString` 填在同一份私有配置中，用 `chmod 600 /absolute/path/db-mcp/config.json` 设置权限。引用方式、SSH 和切库见[配置项说明](docs/CONFIGURATION.md)。

启动前可运行下面的命令做离线检查。返回 `CONFIG_VALID` 后，重载 MCP 客户端，调用 `list_sources` 确认源为 `ready`，再用该源执行一次只读查询。

```bash
npx --yes @wannanbigpig/db-mcp@2.0.0 --config /absolute/path/db-mcp/config.json --check
```

## 新手快速开始（推荐）

以下演示从源码运行向导，适用于 macOS/Linux 的真实交互终端。先安装 Node.js >= 22 和 npm、下载本仓库；准备数据库地址、端口、数据库名和账号。默认读取已配置数据库内账号可见的全部范围，无需先列出表名、字段或 key 前缀；需要收窄时才准备名单。不清楚连接信息时先向数据库管理员确认，**不要把密码发到聊天里**。

### 1. 运行只读配置向导

首次下载时，在终端运行以下命令。已有仓库可直接从仓库目录执行 `npm ci`。

```bash
git clone https://github.com/wannanbigpig/db-mcp.git
cd db-mcp
npm ci --ignore-scripts
npm run setup
```

向导会询问 MySQL/Redis/MongoDB、用途和连接信息，密码后选择读取范围：直接回车选默认 `1`，读取当前固定数据库内的全部可读范围；选 `2` 才填写 MySQL/MongoDB 表/集合及字段，或 Redis 字面量前缀。**全库读取可能把敏感数据交给模型；不希望暴露时请选择名单或使用脱敏视图/专用只读账号。**Redis 用户名可回车使用已有 `default` 账号，但仍只开放读取、默认不扫描 key。

向导默认选择 `production` 并启用 TLS 身份校验。私有 CA 可提供 CA 文件的绝对路径，MongoDB 可额外填写 `authSource`。向导的本机开发选项使用回环地址和明文连接。已有只读配置可以直接编辑各数据源的 `tls.mode`。

数据库只能经内网访问时，可在生产 TLS 流程选择「SSH 通道」。密钥登录填写跳板机 IP、域名或 `~/.ssh/config` 别名，密码登录再输入 SSH 密码。数据库地址填写跳板机能访问且匹配证书的原地址。三种数据库均支持。见 [SSH 通道](docs/SSH.md) 和 [配置示例](examples/config.ssh.example.json)。

密码在终端中隐藏输入，不回显，也不作为命令参数。向导在 `~/.config/db-mcp` 下创建新的私有 profile 目录，生成**只读配置、0600 秘密文件和 `client.json`**；配置使用文件引用，不把密码放进配置或客户端 JSON，不覆盖已有配置，不开放写入。

### 2. 接入现有 MCP 客户端

按向导显示的路径打开生成的 `client.json`，**只把 `mcpServers` 内的 `db-mcp` 一项合并到客户端现有配置**；若已有旧版 `db-mcp`，只替换这一项并停用旧入口，保留其他服务，不用整个文件覆盖客户端配置。不同客户端的格式可能不同；不采用 `mcpServers` JSON 的客户端需将该项的 `command` / `args` 转为其对应格式。向导不会替你修改客户端。保存后重载/重启客户端，首次启动 MCP 时才会连接数据库。

向导只检查配置，不连接数据库，也不验证真实 TLS 握手、数据库授权或能否读取指定范围；配置生成成功不等于连接成功。仍建议使用原生只读账号。秘密文件不是加密保险箱，同一 OS 用户的 shell/文件权限仍可读取它。非 TTY/管道输入会被拒绝；Windows 请使用后面的手工 env 配置方式。

需要换保存位置时，可在已构建的仓库运行 `node dist/index.js --setup --directory /absolute/private/db-mcp`，目录参数必须是绝对的私有路径；仍创建新 profile，不覆盖原配置。多数据源、自定义预算或部署秘密系统等高级需求，继续使用下面的手工配置流程。

### 3. 验证第一次读取

在 MCP 客户端调用 `list_sources`，记录显示为 `ready` 的数据源 ID。接着在默认库调用 `mysql_list_tables`、`mongodb_list_collections` 或针对已知 key 的 `redis_type`，确认读请求走通。

## 安全模型

- 数据源由管理员在启动前配置。工具用 `sourceId` 选连接，多库只读源可额外传 `database` 选库。地址、凭据和 TLS 在配置文件中管理。
- 启动时显式指定 v2 配置。数据库凭据可以填在私有配置文件里，也可以用 `env:NAME` 或 `file:/absolute/path` 引用。
- 实例、数据源、工具、表/集合/字段/key 范围逐层取交集；隐藏工具直调仍会被拒绝。
- 没有设置任何读取名单时，`access.readScope` 默认是 `database`，允许读取所选库内账号可见的范围。其他库须显式开启多库模式。
- `instance.tier`、`source.access.tier` 缺省均为 `read_only`；即使账号原生可写也不会自动升权。只有非生产实例/source 均显式 `read_write`，journal、写策略及具体动作齐备时才开放相应受控写入，新增/更新/删除不互相授权。
- 每个数据源显式配置 `tls.mode`。`verify_identity` 校验证书和主机身份。只读数据源可用 `disabled` 连接明文端口。启用写入的数据源仅可对开发或测试的回环地址关闭 TLS。
- 不提供原始 SQL、动态连接、运行时升权或模型脚本。只读 profile 无写工具；写 profile 仅开发/测试显式单目标操作，仍需数据库原生范围授权。
- 请求、队列、时间、行数、单项和响应字节均有预算；超额结果带 `truncated`，不是完整结果。
- stdout 仅用于 MCP；stderr 审计只记录时间、随机请求/操作 ID、已知工具/数据源 ID、结果码、耗时及数量，不记录参数、结果、URI、账号或原始异常。

环境变量/秘密文件降低模型工具链泄露风险，**不能隔离拥有同一 OS 用户 shell/文件权限的 Agent**。数据库返回内容同样是不可信数据，不能作为新指令或授权依据。

## 读写权限如何控制

应用授权是第一道门禁，数据库原生最小权限是第二道防线。账号有写权限、客户端确认或工具的 `readOnlyHint` 都不能给 MCP 授权；工具参数不能改变启动后冻结的权限模式。

| 配置情况 | MCP 能力 |
| --- | --- |
| 实例/source 的 `tier` 省略或均为 `read_only`，且不带矛盾写配置 | 仅授权范围内的读取、元数据和运行状态；强行调用写工具仍拒绝 |
| 实例为 `read_write` 且具备有效 journal，但 source 省略 tier/为 `read_only` | 该 source 仍只读，不继承实例写能力 |
| 两层显式 `read_write`、非生产、完整写策略，仅允许更新 | 只开放授权更新；新增和删除仍拒绝 |
| 只读 source 带 `writes`、只读实例带 `journal`，或写前置配置缺失/非法 | 拒绝启动，不静默升级或忽略错误 |

允许写入必须同时满足：development/test 实例显式 `read_write`、有效独立 journal、source 显式 `read_write`、完整对象/字段/定位/条件策略、对应动作允许，以及工具范围授权。MySQL/MongoDB 使用 `allowInsert` / `allowUpdate` / `allowDelete`；Redis 使用 `allowCreate` / `allowReplace` / `allowDelete`，均默认 `false`。**完整开启写前置条件不等于同时开放全部增改删**，没有万能 `full_access`/admin 模式。写 profile 只支持具备 Unix UID/文件权限语义的环境。

## 安装与配置

手工配置适合已有账号或多个数据源。默认值、适用引擎和带注释的三库示例见[配置项说明](docs/CONFIGURATION.md)。

要求 Node.js >= 22、npm；Docker 和 OpenSSL 仅用于隔离集成测试。

以下按源码仓库构建使用，不依赖 npm 已发布版本。先在仓库根目录安装并构建：

```bash
npm ci --ignore-scripts
npm run build
cp -n config.example.json config.json
```

启动前由管理员完成以下准备：

1. 在 `config.json` 中填写实际主机、数据库和账号。模板是单个 MySQL 数据源。其他引擎可参考[配置示例](docs/CONFIGURATION.md#三库只读示例)。使用私有 CA 时添加 `tls.caFile`。
2. 示例的 `access: {}` 使用固定数据库内账号可见的读取范围。需要收窄时添加表/字段、集合或 key 前缀名单。预算、端口和只读权限有默认值。
3. 单文件配置可以把模板里的 `passwordRef` 改为 `password` 并填写实际值。使用引用时，环境变量要传给启动 MCP 的进程，也可用绝对路径引用秘密文件。
4. 先执行配置检查，再用同一配置启动；首次部署前另外验证真实 TLS、原生权限和数据范围。

在仓库根目录检查配置。直接填写凭据时，先设置私有文件权限。

```bash
chmod 600 config.json
node dist/index.js --config "$PWD/config.json" --check
```

`--config` 必须是绝对路径，也可使用 `DB_MCP_CONFIG`；两者同时指定不同路径时拒绝启动。`--check` 检查 schema、引用和 URI，成功时在 stderr 输出 `CONFIG_VALID`，但**不连接数据库、不验证真实权限、TLS 握手或 journal 可用性**。普通启动才初始化 journal（若配置）并连接数据库；服务成功启动后等待 MCP 输入，不打印 stdout 启动文本。

macOS/Linux 上，MySQL 和 Redis 可直接填写 `password`，MongoDB 可填写包含认证信息的 `connectionString`。每个数据源在直接填值和引用中选一种。包含凭据的 `config.json` 须由当前用户拥有、权限为 `0600` 或更严，使用普通文件并避免末级符号链接。权限过宽时会报 `CONFIG_SECRET_FILE_UNSAFE`，可用 `chmod 600 config.json` 修正。请勿将含凭据的配置提交到 Git。

使用独立秘密文件时，MySQL 和 Redis 填 `passwordRef`，MongoDB 填 `connectionStringRef`。文件引用示例：

```json
{ "passwordRef": "file:/run/secrets/db-mcp-reader" }
```

Unix 秘密文件须为当前 UID 拥有的常规文件、权限 0600 或更严、无末级符号链接、最大 64 KiB，非空。会移除一个末尾换行，不 trim 密码空格。Windows 首版仅支持 env 引用。不要把用户无法直接读取的秘密文件放在 Agent 可直接读取的位置。

用绝对路径替换下列示例路径。接受 JSON 格式的 MCP 客户端可以合并这个启动项。

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

在 Codex 中，把对应的启动项写进 `~/.codex/config.toml`。[Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

```toml
[mcp_servers.db-mcp]
command = "node"
args = ["/absolute/path/db-mcp/dist/index.js", "--config", "/absolute/path/db-mcp/config.json"]
```

在图形界面添加 stdio 服务时，启动命令填 `node`，逐项添加入口绝对路径、`--config` 和配置文件绝对路径。客户端找不到 `node` 时，可以用 `command -v node` 查询出的绝对路径。若配置使用环境变量引用，可在 Codex 启动项中用 `env_vars = ["DB_MCP_MYSQL_PASSWORD"]` 传递已设置的变量。保存后重载 MCP 客户端。

## 数据源

### 同一连接访问多个库

每个只读 source 只填一份连接参数。工具调用省略 `database` 时使用源中配置的默认库。要开放其他库，在该源中添加：

```json
{
  "databaseScope": "visible",
  "excludeDatabases": ["internal", "audit"]
}
```

MySQL 和 MongoDB 的 `list_databases` 返回连接账号可见且未被排除的库。MySQL 库名可包含连字符，例如 `reporting-archive`。Redis 使用数字库编号，开启多库后用 `"databases": [1, 2]` 指定额外编号，`excludeDatabases` 也填写数字。Redis 默认库仍由 `database` 指定。切换需服务端支持所选库编号，并允许此账号选择该库。

黑名单可省略。被排除的库会从 `list_databases` 隐藏，指定该库读取也会返回 `SCOPE_DENIED`。默认库不能加入黑名单。启用多库的源继续使用一个 `sourceId`，只读工具可传 `database` 选择目标库。每个库仍受原账号权限和此源配置的表、集合、字段或 key 前缀限制。分页和 Redis 分段续读须沿用目标库。MongoDB 连接串使用默认库路径和原账号认证库。

旧配置或未开启多库的源只开放默认库。Redis 每个开放的库预留一条连接额度，按需开连接。MySQL 和 MongoDB 多库读取沿用该源的连接预算。

### 读取范围

`access.readScope` 支持 `database` 与 `allowlist`。未指定它且没有任何范围属性时，默认为 `database`；存在 `tables` / `columns`、`collections` / `fields` 或 `keyPrefixes` 范围属性时，继续推断为 `allowlist`，空名单也必须通过名单校验，不会意外放宽。显式 `database` 不能同时带非空名单，只允许只读 source；写入必须使用明确的 `allowlist`。

`access.readScope: "database"` 允许在所选库中执行已启用的读取工具，仍受账号原生权限、查询和字节预算约束。MySQL/MongoDB 可读该库内可见的表、集合与字段。Redis 可直接读取已知 key，扫描需要单独开启。

MySQL 名单模式可配置 `"access": {"tables":["v_report_safe"],"columns":{"v_report_safe":["id","name"]}}`。省略 `columns` 会授权该表的全部列。MySQL 在 `tls.mode: verify_identity` 下要求使用匹配证书的数据库 DNS 主机名。

Redis source 示例（放入 `sources` 数组）：

```json
{
  "id": "cache", "engine": "redis", "host": "redis.internal.example", "port": 6379,
  "username": "mcp_reader", "passwordRef": "env:DB_MCP_REDIS_PASSWORD", "database": 0,
  "tls": { "mode": "verify_identity", "caFile": "/absolute/path/ca.pem" },
  "access": { "tier": "read_only", "readScope": "allowlist", "keyPrefixes": ["reports:"], "allowKeyspaceScan": false }
}
```

MongoDB source 示例：

```json
{
  "id": "documents", "engine": "mongodb", "database": "reporting",
  "connectionStringRef": "env:DB_MCP_MONGO_URI",
  "tls": { "mode": "verify_identity", "caFile": "/absolute/path/ca.pem" },
  "access": { "tier": "read_only", "readScope": "allowlist", "collections": ["reports"], "fields": { "reports": ["_id", "name"] } }
}
```

Redis 只读 source 的 `username` 省略时为 `default`，也可填写已有专用 ACL 用户。写 source 须专用非 `default` 用户及完整写授权。`database` 是默认库编号。只读多库模式可显式选择已开放的编号。扫描默认关闭。

MongoDB 秘密 URI 必须包含非空用户名/密码及匹配 `database` 的路径。首版仅支持单主机固定连接，不支持 SRV、自动拓扑发现/故障转移；URI 只允许 `authSource`、`replicaSet`、`directConnection=true`，不允许 URI 改写 TLS/重试/池配置。TLS 开关由配置决定。名单模式下每个集合必须显式声明字段；允许父对象字段意味着也允许其子字段。需要更强字段边界时使用脱敏视图。

所有 source 默认 `required: true`，首次初始化失败会拒绝启动。SSH source 设置 `required: false` 后，在必需源及可选直连源完成启动探测后从后台连接，不延迟 MCP 握手。`list_sources` 在后台首连和临时断线恢复期间显示 `reconnecting`，数据库探测通过后显示 `ready`。凭证、CA 或固定目标变更仍需重启加载。

## 工具契约

| 工具 | 范围 |
| --- | --- |
| `list_sources` / `server_runtime_status` | 数据源的可用状态、启用工具、读取范围和行数上限 / 实例级并发队列 |
| `list_databases` | 分页列出已启用多库读取的源可选择的数据库 |
| `mysql_list_tables` | 分页列出所选库的表和视图名称，名单模式限于允许范围 |
| `mysql_select` | 读取所选库的授权表和字段，支持参数化等值或 NULL 过滤以及字段排序。JSON 列返回数据库 JSON 文本以保留精度 |
| `mysql_describe_table` | 分页读取所选库内的列名、类型和可空性，名单模式限于允许的表和字段 |
| `redis_get` / `redis_get_range` | 有界 GETRANGE 字节片段，base64 编码；不是无界 GET |
| `redis_type` / `redis_memory_usage` | 精确授权 key，内存估算固定 SAMPLES 5 |
| `redis_keys` | 分页扫描 key。默认不注册，启用后名单模式用配置字面量前缀，全库模式用空 prefix |
| `mongodb_find` / `mongodb_find_one` | 读取所选库，名单模式强制字段投影，支持等值标量或 `$oid` 和字段排序 |
| `mongodb_list_collections` | 分页列出所选库的集合名称，名单模式限于已配置的集合 |
| `mysql_prepare_write` / `mongodb_prepare_write` / `redis_prepare_write` | 仅非生产显式 write profile：单目标预览、真实主键/`_id`/精确 key、版本/值/TTL 条件 |
| `commit_write` / `operation_status` | 执行绑定操作 ID 一次 / 查询持久状态；未知不自动重放，预览不是人工审批 |

每个 source 可配置 `access.allowedTools` 进一步收窄 engine 工具/写流程，不能将只读 source 升为可写；同一工具对不同 source 的权限不同。允许 `*_prepare_write` 表示在完整写授权下允许该受控写流程及其 commit/status，不是「只预览禁止提交」；全局 `commit_write`/`operation_status` 不作为 source 白名单项。Redis ACL 的 key pattern **不隔离 SCAN 返回的 key 名称**，应用过滤是补充，不是数据库侧租户隔离。`SCAN COUNT` 不是严格回复大小上限，共享生产数据库默认关闭扫描。

调用前可用 `list_sources` 根据 `purpose`、`status` 和 `enabledTools` 选择数据源。`readScope` 与 `maxRows` 描述当前 source 的读取范围和单次行数上限。`tools/list` 中的 `sourceId` 候选值来自配置权限，`status` 反映当前连接状态。仅启用了 `redis_keys` 的 source 返回 `scanPrefixes`。白名单扫描须传其中一个前缀，全库扫描可省略 `prefix` 或传空字符串。

`mysql_select` 参数：

```json
{ "sourceId": "reports", "table": "v_report_safe", "columns": ["id", "name"], "where": { "id": 1 }, "limit": 10 }
```

`mongodb_find` 参数：

```json
{ "sourceId": "documents", "collection": "reports", "filter": { "_id": { "$oid": "507f1f77bcf86cd799439011" } }, "fields": ["name"], "limit": 10 }
```

数据读取工具在 MCP text content 中返回 `rows` 和 `truncated`。触及行数或字节预算时，响应还会给出 `reason`。多行、非分页查询到达行数上限时保守标记截断。`mongodb_find_one` 和 Redis 单结果工具成功返回一条记录时无需继续读取其他行，字节超限仍会标记截断。全局状态及写入工具使用各自的返回结构。

`mysql_list_tables`、`mysql_describe_table`、`mongodb_list_collections` 和 `redis_keys` 接受可选的 `limit` 和 `cursor`。发起第一页时省略 `cursor`，后续请求把响应中的 `nextCursor` 原样传给同一工具，沿用同一个 `sourceId` 和表名或 Redis 前缀。以 `nextCursor` 消失作为结束条件。Redis 触及单次请求的 `maxScanPages` 时会返回 `reason: "scan_pages"` 和续页游标，这一页的 `rows` 可以为空。

游标只在当前服务进程内有效。每次续页受原有权限和时间、数量及字节预算约束。MySQL 使用稳定排序，MongoDB 原生列表按服务器枚举顺序续页，Redis 使用原生 SCAN 位置。并发增删或索引、目录和键空间变化可能导致跨页重复或遗漏。MongoDB 原生列表的深页需要重新流式跳过先前位置，仍受请求时间预算约束。

`redis_keys` 返回的 `key` 可原样传给精确读取工具。UTF-8 key 返回字符串，非 UTF-8 key 返回 `{ "base64": "..." }`，按原始字节去重和匹配白名单前缀。只读工具支持最多 4096 字节的 key，并受请求和响应预算限制。扫描遇到超过 key 长度或无法在请求预算内表达的匹配项时返回 `BUDGET_EXCEEDED`。

`redis_get` 和 `redis_get_range` 继续返回 Base64 片段及 `bytes`、`offset`、`complete`。`complete` 表示从偏移 0 返回了整值。若 `hasMore: true`，将 `nextOffset` 传给同一个 key 的 `redis_get_range`。读到末尾时返回 `hasMore: false`，尾片的 `complete` 在非零偏移仍为 false。空值和缺失 key 都可能返回空片段，分段读取不提供并发修改下的快照。

`maxItemBytes` 按单条记录的 JSON 编码计量，`maxResponseBytes` 按序列化后的 MCP 工具结果计量，包含 UTF-8 字节、text content 转义和截断元数据。Redis 字符串查询遇到其他 key 类型时返回 `REDIS_WRONG_TYPE`，可用 `redis_type` 查询实际类型。Redis 命令长时间无响应时会关闭共享读连接。SSH source 会转入 `reconnecting`，直连 Redis 会标为 `unavailable`。

MySQL JSON 列返回数据库提供的 JSON 文本字符串，而非自动解析的对象/数组/数字，以保留高精度小数、大整数及 JSON 类型。JSON `null` 返回字符串 `"null"`，SQL NULL 返回 `null`。调用方需要结构化处理且要求数字保真时，应使用无损 JSON 解析器，不能直接用普通 `JSON.parse` 将这些数字转为 JavaScript `number`。文本编码后的字节同样计入预算。

MySQL 和 MongoDB 的等值过滤及写入键和值会拒绝超出 JavaScript 安全整数范围的 JSON 数值。工具返回 `INVALID_ARGUMENT`，`details.reason` 为 `UNSAFE_INTEGER`，并标明所属参数，例如 `$.where.*`。

工具错误继续使用 `isError: true` 和包含 `code`、`message`、`requestId` 的文本 JSON。已识别的场景可能附带脱敏的 `details.reason` 和 `details.path`。只读工具还可返回 `details.nextAction`，例如 `invalid_cursor` 提示重读同一列表的首页，`queue_full` 提示稍后再读。诊断不回显原始数据库错误或输入值。

## 开发/测试受控写入

使用独立实例、账号和真实隔离数据库，按 [config.write.example.json](examples/config.write.example.json) 及 [写入指南](docs/WRITES.md) 配置。不要把生产库标为 test 绕过限制，也不要仅把两处 tier 改成 `read_write` 就尝试上线。

管理员须提前建立仓库之外的 journal 目录：当前 UID 所有、真实目录、权限 0700 或更严，整个路径受可信运维控制且支持可靠 rename/fsync。不要使用未经验证的共享/NFS 文件系统；`--check` 不会建立或验证该目录。

- MySQL：InnoDB 完整 PRIMARY KEY、整数版本、管理员审查的固定 metadata guard；MongoDB：固定副本集主节点、`_id`、版本和事务；Redis 7+：精确字符串 key、预期值/TTL 条件及固定原子脚本。无任意 SQL/脚本、DDL、批量或 upsert。
- 调用对应 `*_prepare_write` 获取默认 60 秒有效的服务端 `operationId`；预览不修改业务数据，不是人工审批或备份。
- 每次预览会持久登记一个新操作，相同参数也产生新 ID 并占用 journal 容量；因此预览标注为非只读、非幂等、非破坏性工具。
- `commit_write` 只接收绑定的 `sourceId` 和 `operationId`，不能修改预览参数；重复提交同 ID 不重放。检查返回 `state` / `effect` / `journalDegraded`，不能只看 `isError`。
- 超时/确认丢失可能是 `unknown_outcome`，不代表没执行。先查 `operation_status`，不要换 ID 重试、自动补偿或删除记录；存在未知结果的 source 会阻断新写入。
- journal 不健康时关闭尚未发送的写入；已确认成功而最终记录失败时仍报告真实成功并标记降级。journal 容量、私有目录权限、崩溃锁、凭证轮换和管理员恢复步骤见写入指南。

不承诺通用自动回滚、跨库事务、跨实例去重或 exactly once。生产写入、可信人工审批、Keychain、短期云凭证和热轮换不在当前支持范围。

## 预算与运行边界

source 的 `budgets` 默认：maxRows 200、maxResponseBytes 65536、maxItemBytes 16384、maxRequestBytes 32768、maxConcurrent 2、maxQueued 20、maxConnections 2、connectTimeoutMs 10000、queueTimeoutMs 2000、queryTimeoutMs 5000、maxScanPages 50。

实例默认 maxSources 4、maxConcurrent 4、maxQueued 40、maxConnections 8、maxRequestBytes 65536。连接预算计算为 MySQL 并发连接数 + Redis 每个开放库一条（写 profile 另加 maxConcurrent 条独立写 socket）+ MongoDB pool 数与每固定主机 2 条监控连接。MySQL 每次操作后丢弃连接，避免残留会话或未消费结果。

队列等待也计入查询总期限；取消等待任务不会随后执行，运行任务清理完成前仍占应用额度。驱动取消不保证服务器立即停算。读取路径中，MySQL 使用 read-only transaction、流式 prepared execute 和服务器 MAX_EXECUTION_TIME；MongoDB batchSize 1/maxTimeMS/cursor cleanup/禁用 retryReads/retryWrites；Redis 禁用离线队列和自动重连，并限制内部队列。受控写入使用前述独立事务/原子操作，不在只读事务内执行 DML。

实例与 source 的执行额度同时取得；等待 source 的请求不会预占实例执行额度，其他有额度的 source 可以继续运行。一个等待请求同时计入实例与 source 的 queued 数量，任一队列满均拒绝新增等待；queueTimeoutMs 覆盖这一次联合等待。

预算是响应和获取控制，**不是任意大行/文档/Redis SCAN 回复的硬 RSS 上限**。驱动可能先解码单项；只暴露经审查的小字段/视图，结合容器内存、数据库侧超时及资源限额。stdio 在 JSON 解析前逐条限制消息大小，未完成消息使用固定上限缓冲区；多条合法消息合并到达不会因合计大小被拒绝。stdout backlog 达到 2 MiB 关闭传输；stderr 背压或接收端关闭时会丢弃审计记录，不因日志管道断开终止正常 MCP，不能作为无损审计系统。持久写 journal 不依赖 stderr。

## 从 1.x 迁移

1. 管理员创建独立原生只读账号，审查并缩小表/集合/key 授权；历史凭证若曾进入仓库/对话须轮换。
2. 将目标与范围改为 v2 配置，用专用账号的密码或 MongoDB 连接串。可以填进私有配置文件，或使用环境变量和文件引用。
3. 更新客户端启动参数及工具调用：新增必填 `sourceId`；MySQL raw SQL 改为 `mysql_select`，MongoDB 操作符过滤改为等值过滤，Redis GET 改为片段契约。
4. 删除对 `*_connect`、`*_disconnect`、`mysql_query`、旧写入工具、`set_security_mode`、无界 HGETALL/排行/聚合的依赖；没有兼容别名。开发/测试确需写入时，单独部署上述受控写 profile，不复用旧动态写接口。
5. 执行配置检查，再在测试库验证权限/TLS/响应契约，最后由管理员部署；失败时停止服务，不能回退恢复不安全默认值。

旧 `DB_MCP_CONFIG_PATH`、`DB_MCP_SECURITY_MODE`、MYSQL/REDIS/MONGODB 连接环境变量及旧预算环境变量不再改变配置。1.x 模块与其专属测试已隔离到 `legacy/`，不被新入口加载，也不打包为发布模块；现役并发和超时工具及测试仍在 `src/`。`config.json.example` 已被新模板替换，旧本地配置不自动迁移或读取。

## 配置诊断与编辑器提示

`npm run build` 自动生成 `dist/config/config.schema.json`，供编辑器补全并随 npm 包发布。日常只编辑 `config.json`。其中的 `$schema` 可省略，复制到其他目录后也可改成 Schema 的绝对路径。需要查看 Schema 时运行 `node dist/index.js --print-config-schema`。

`--check` 成功后列出每个数据源启用的工具。失败时输出脱敏字段路径和稳定原因码，例如 `sources[0].ssh`。权限、预算及跨字段条件以运行时校验为准。

密码只支持单行。向导启用终端 bracketed paste 模式，在完整粘贴结束前保持隐藏，带换行的粘贴会取消；请使用支持该模式的终端，不粘贴多行秘密。

MongoDB 的 `find/find_one` 返回 canonical Extended JSON：ObjectId 为 `{"$oid":"..."}`，整数保留 BSON 类型标记，非有限数、正则、二进制 subtype 等不会静默丢失。旧版 BSON Undefined 为 `{"$undefined":true}`。读取到超出 JavaScript Date 范围的 BSON 日期时返回 `BSON_DATE_OUT_OF_RANGE`。调用方应按 Extended JSON 解码。等值过滤支持标量或 `{"$oid":"..."}`。MySQL JSON 列按上述文本契约返回；Redis 使用有界 base64 片段。

MongoDB source 可设置 `"requireIndexedReads": true`（默认关闭），读取前检查同一授权查询的 winning plan；集合扫描或无法确认的计划返回 `QUERY_REQUIRES_INDEX`。预检不会扩大字段/集合权限，也不返回内部执行计划；它不能锁住预检后的索引或计划变化。开启前先在目标版本和只读账号上验证所需索引与权限。

## 开发与验证

CI 在构建后用 `npm run schema:check` 核对生成的 Schema 与配置定义。

```bash
npm test
# 单独查看现役或历史回归：npm run test:current / npm run test:legacy
npm run schema:check
npm run test:integration
npm audit --omit=dev --registry=https://registry.npmjs.org
npm pack --dry-run --ignore-scripts
npm run verify:artifact
```

普通测试包括单测和真实 MCP 子进程冒烟，默认跳过两个 Docker 聚合；`npm run test:integration` 单独执行读取及写入聚合。使用 mysql:8.4.8 / redis:7.4.7 / mongo:7.0.31，随机 loopback 端口、独立账号、临时测试 CA 与证书；测试最后只清理本次容器及其匿名卷/临时文件，保留镜像缓存，不连接现有数据库。权限对照包含「同一数据库账号原生 CRUD 成功，但显式/缺省只读 MCP 拒写且数据不变」。

最新测试环境、通过数量、实际产物与未覆盖项目统一维护在 [验证记录](docs/VALIDATION.md)。`--check` 是离线校验，不能代替真实 SSH/VPN、数据库 TLS/权限、客户端或远程 CI 验收。

## 支持与许可

[支持项目](docs/SPONSOR.md) · MIT · 欢迎 Issue / Pull Request。
