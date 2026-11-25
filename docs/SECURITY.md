# 安全部署、能力边界与运维

本文件描述 v2 默认安全只读运行时；开发/测试独立 write profile 已实现，见 [写入与恢复指南](WRITES.md)。生产写入、可信审批 token、远程网关仍不支持。部署前以 [验证记录](VALIDATION.md) 核对已测范围。

内网数据源可配置 [SSH 通道](SSH.md)。启动时固定跳板机和数据库目标，校验 SSH 主机密钥。数据库连接使用该数据源配置的 TLS 模式，数据库操作仍受读取范围和写入权限约束。

## 信任边界

管理员配置与可信数据库对象定义属于可信控制面；MCP 工具参数、数据库文档/值/名称属于数据面。数据不能更改配置、连接目标、秘密引用或权限。

本服务是本机 stdio 子进程，不是多用户 HTTP 网关。无远程认证、OAuth、多用户 session 或用户到 source 的映射；不要直接用 stdio 转 HTTP 后暴露公网。同用户 Agent 若有 shell/文件读取权限，可以访问进程环境/秘密文件，这不在 MCP 工具隔离所能保证的范围内。需要真正隔离时使用专用 OS 用户/容器、只向 MCP 进程挂载秘密、网络 egress 白名单及独立数据库账号；还须核对 Agent 是否具有相同容器、进程、主机或密钥管理权限。

数据库凭据及连接信息由管理员配置，MCP 工具只接收数据源 ID。日志不得记录完整配置、URI、参数、结果或 raw exception；关闭 Node/驱动 debug、生产 core dump 和不受控进程环境收集。应用 audit 记录不等同于不可篡改安全日志，也不证明数据库执行完成。

## 秘密与配置

- 配置必须由管理员维护，设置为不可由 Agent 改写；所有 source 有稳定 ID 和用途。服务不执行配置热重载。
- 本机单文件配置可使用数据库 `password` 或 `connectionString`。含凭据的配置按私有文件读取，要求当前 UID 拥有、权限为 0600 或更严、无末级符号链接。
- env：启动器从秘密管理系统注入父环境；不要把实际密码写到 shell 历史、MCP JSON、源码或日志。
- file：绝对路径、常规文件、当前 UID、0600 或更严、最大 64 KiB；拒绝末级符号链接。**不保证祖先目录无符号链接**，部署必须控制整条路径、目录 ownership 和 mount。容器/平台的符号链接型 projected secret 需管理员安全复制到私有 regular-file mount，不能为了兼容关闭检查。
- file resolver 去除一个尾随换行，不 trim 空格。env 不作 newline 修剪。不支持空值、NUL 或无效 UTF-8 文件内容。
- 不提供秘密枚举接口，也不自动请求 Keychain/云凭证。JS 字符串无法保证安全擦除，内存驻留仍是进程权限边界。
- `--check` 无数据库连接，只核对配置、引用及 URI；不能当作 TLS/权限验收。

### 轮换流程

1. 管理员按数据库/秘密系统策略生成新独立身份/凭证；不把新值发给模型。
2. 更新受控秘密及配置，重启 MCP 子进程，关闭全部旧连接。Redis `ACL SETUSER ... off` 不能被视为已撤销所有既有会话；必要时由管理员在服务端撤销/终止会话。
3. 以无敏感参数的受限读取核对新身份与范围；撤销旧凭证，检查数据库审计及残留会话。
4. 若新配置失败，停止服务修复；仅可回到已满足同等安全边界的构建/凭证，不恢复动态全权连接。

运行账号不得具有修改其他用户、查看所有秘密或变更自身权限的管理能力。历史提交如果曾保存真实凭证，删除/ignore 不能撤销泄露，必须轮换并另行处理 Git 历史。

## 应用权限先于数据库权限

实例 `instance.tier` 和每个 source `access.tier` 分别缺省为 `read_only`，并在启动解析后冻结。数据库账号拥有 INSERT/UPDATE/DELETE、SET/DEL 或 MongoDB 写角色，**不会自动给 MCP 开启写权限**。只读 source 不构造 writer，不列出写工具；直接伪造写工具调用也由 Dispatcher/Operations/写策略校验在 DML 之前拒绝，不等待数据库报权限错误。客户端工具参数、旧 `DB_MCP_SECURITY_MODE=full_access` 或查询结果不能更改模式。

应用写授权是必要条件的交集：非生产实例显式 `read_write` + 有效 journal + 该 source 显式 `read_write` + 完整对象/字段/定位/版本或值条件策略 + 对应动作显式允许 + engine 工具允许范围。少一层都不获得写能力；`read_write` 不代表任意 SQL、DDL、管理或全部操作。新增、更新、删除默认各自关闭，按需开启，不为“全部权限”同时打开不需要的删除能力。

### 默认读取范围

只读 source 未设置对象、字段或 key 前缀范围时，`access.readScope` 默认为 `database`，允许读取所选库中账号可见的数据。默认只开放配置中的数据库。显式开启 `databaseScope: "visible"` 后，可选择账号可见且未被排除的 MySQL/MongoDB 库，或已配置的 Redis 逻辑库编号。读取仍受原生授权和响应、时间、并发预算限制。视图和函数可能间接访问其他数据库，需由管理员审查。

旧配置已有 `tables`/`columns`、`collections`/`fields` 或 `keyPrefixes` 时，省略 `readScope` 仍推导为 `allowlist`，不自动扩大范围；显式空名单依然失败。`database` 与非空限制名单冲突时拒绝启动。需要最小披露时设置 `readScope:"allowlist"` 和具体范围；MySQL 未配置该表的 columns 时允许其全部列，MongoDB 则要求逐集合声明 fields。`read_write` source 必须使用明确白名单，不能沿用全库读取模式。

`allowKeyspaceScan` 默认关闭。显式开启后，database 范围的 `redis_keys` 使用空 prefix，有界扫描所选库。MySQL `mysql_list_tables` 和 MongoDB `mongodb_list_collections` 列出所选库中的表或集合，名单模式进一步限制结果。

| 配置情况 | 应用行为 |
| --- | --- |
| 实例/source 都省略 tier，或都为 read_only | 仅授权范围内读取/元数据/状态；写工具无入口，强行调用仍拒绝 |
| 实例 read_write，但 source 省略 tier/为 read_only 且不带写策略 | 该 source 仍只读，不继承实例的写能力 |
| 两层显式 read_write、完整写策略，只开启更新 | 只允许授权更新；新增/删除仍拒绝 |
| 只读/缺省 source 带 writes，或只读/缺省 instance 带 journal，source 权限高于实例，或写前置配置缺失 | 拒绝启动，不静默升级或忽略矛盾配置 |

`allowedTools` 是 engine 工具/写流程的收窄，不是提权开关。允许 `*_prepare_write` 时，对其登记操作可调用 commit/status；不能用它表达“允许准备但永远禁止提交”。全局 commit/status 不作为 source 白名单项；记录绑定的 source 与 prepare 工具在操作时重新授权。

三库隔离回归先证明同一 named 身份的原生 CRUD 确实成功，再证明缺省/显式只读 MCP 正常读取、拒绝所有直接写入口且原生读回未变。该测试证明本工具的应用边界，不建议生产复用高权限账号；最小原生权限仍作为第二道防线，防护代码漏洞、进程被攻破或通过其他渠道使用凭证。应用只读也不能隔离具有同用户 shell/文件权限的 Agent，或证明受信数据库视图/函数不存在间接副作用。

## 原生只读权限（第二道防线）

运行时的固定结构化工具和 read_only 声明**不是原生账号权限证明**。启动只进行连接和非破坏性 ping/SELECT 1，不自动赋权，不自动执行写探测。管理员必须维护下列验证证据，并在权限/视图/函数定义变化后重新检查。

### MySQL

通过管理员的秘密工作流创建专用 `mcp_reader`，非 root，不复用业务写账号。对经审查的视图授权，例如：

```sql
GRANT SELECT ON reporting.v_report_safe TO 'mcp_reader'@'approved-host-pattern';
SHOW GRANTS FOR 'mcp_reader'@'approved-host-pattern';
```

核对没有 global SELECT、写入/DDL、FILE、EXECUTE、GRANT OPTION 或可激活的高权限角色；逐项核对 role membership/effective grants。禁止 MCP 运行身份因“自动验证”而获得管理权限。视图应明确列/行脱敏，审查 DEFINER/SQL SECURITY、函数和跨 schema 依赖；不要授权未知副作用例程。

读取值使用原生 prepared statement，不依赖反斜杠转义/SQL 关键词检查。表和列必须通过标识符校验，在 allowlist 模式还须匹配固定名单；等值查询不接收 SQL 片段。连接使用只读 transaction，完成/取消/提前截断后销毁，不把残留结果或会话放回池。`MAX_EXECUTION_TIME` 的支持范围取决于实际数据库版本，不能仅靠 hint 保证服务端停止；客户端超时和销毁连接是补充。

MySQL JSON 列保留为数据库返回的 JSON 文本字符串，避免高精度小数在驱动解析为 JavaScript number 时静默舍入；JSON null 与 SQL NULL 仍可区分。应用按编码后的文本计算字节预算，调用方需要解析时须自行采用无损数字表示。

在一次性测试库，用同等级账号证明 INSERT/UPDATE/DELETE/ALTER 及越界表读取被原生拒绝，不能在生产试写做探测。数据库生产账号及真实负载尚需管理员实测。

### Redis

推荐专用 ACL user，不授 `+@all` 再减危险命令。为兼容旧密码认证，只读 source 可省略 username（默认为 `default`，发送旧式密码认证）；这不证明原生账号只读，更不授予 MCP 写能力。`read_write` 拒绝 `default`，仍要求专用身份。固定读取命令允许表：

```text
user mcp_reader on #<strong-password-sha256> ~reports:* -@all +ping +getrange +type +memory|usage
```

以上为 ACL 文件格式的管理员模板，不要把 placeholder 当作实际配置；原始密码由受控秘密流程生成并注入。扫描默认关闭，确需扫描且接受 keyspace 风险时另加 `+scan` 并设置 `allowKeyspaceScan:true`；database 非 0 时认证后 SELECT 需要相应 `+select` 权限。只读账号不授 SET/DEL/FLUSH/CONFIG/SWAPDB/EVAL/FUNCTION 等。

`~reports:*` 限制显式 key 参数，**不自动过滤 SCAN 返回的其他租户 key**。allowlist 模式只接受配置的字面量前缀并过滤每个返回 key；database 模式显式开启扫描后允许固定逻辑 DB 内全部 key 名称。两种模式都去重，并限制页数、时间和数量。Redis COUNT 只是提示，服务端一页仍可能很大；共享租户环境建议禁用扫描，严要求元数据隔离时使用独立实例，逻辑 DB 不是完整 ACL 租户隔离。

GETRANGE 请求片段最大值受 maxItemBytes 预算进一步压缩，base64 避免多字节切片破坏 JSON。`complete` 为片段信号，不是快照；空值与不存在不可区分。不开无界 GET、HGETALL、自动前缀发现或整库内存排行。MEMORY USAGE 固定 SAMPLES 5，不接受遍历型参数。

一次性库验证 SET/FLUSH 与越界 key 原生拒绝，并单独证明 SCAN ACL 的元数据边界。不得把应用过滤结果当成原生 ACL 隔离证明。

### MongoDB

按固定集合授予自定义 find 角色，例如管理员在 reporting 数据库创建以下 role 后将其授给专用 reader：

```json
{
  "createRole": "mcp_read_reports",
  "privileges": [{ "resource": { "db": "reporting", "collection": "reports" }, "actions": ["find"] }],
  "roles": []
}
```

如授权全库读取可用 read 角色，但部分集合要求自定义角色；不要授 readWrite/root/dbOwner。字段隔离使用服务端投影和经审查的脱敏视图，原生 collection 授权不能保证字段隔离。父对象投影会返回子字段，需要管理员明确授权范围。

filter 只接受等值标量和 `$oid`，不接受 `$where`、任意聚合/operator/JavaScript。database 模式可有界列出原生授权可见的集合；allowlist 模式仅返回配置名称。batchSize 1、cursor close、maxTimeMS、固定 pool 和禁用 retries 控制资源与重试。首版固定单主机 directConnection，不支持 SRV 或拓扑自动发现；额外监控连接纳入预算。不应把生产副本集故障转移能力假定为已支持。

## TLS 与版本能力

每个数据源显式选择 `tls.mode`。只读源可将其设为 `disabled` 使用明文端口。写入源使用明文时，目标必须是开发或测试环境的回环地址。

| 组件 | 锁定版本 | 当前实现 |
| --- | --- | --- |
| MCP TypeScript SDK | 1.32.2 | stdio、取消 signal；自有逐帧有界传输使用 SDK 编解码，无 HTTP |
| Zod | 4.6.7 | 配置/工具/journal 校验均使用 v4，JSON Schema 使用原生转换 |
| mysql2 | 3.24.5 | `verify_identity` 使用可信 CA 和匹配证书的 DNS 主机名，使用 prepared stream |
| node-redis | 4.7.1 | CA + checkServerIdentity(source.host)，DNS/IP；离线队列/重连关闭，内部队列有上限 |
| MongoDB Node driver | 6.21.0 | CA + DNS/IP 验证，不接受 URI 安全覆盖；单主机固定 pool + 监控保留 |

不能为了连接方便使用 rejectUnauthorized:false、tlsInsecure 或允许无效证书/hostname。CA 缺省使用系统信任，私有 CA 必须配置绝对路径 caFile。CA/证书文件由管理员维护；不能由模型指定。

MySQL 驱动 IP SAN 路径无法按 DNS 验证逻辑推定，当前 fail closed；使用真实 DNS/受控解析与证书 SAN，不通过临时关闭证书校验绕过。证书过期、错误 DNS、错误 IP SAN、不可信 CA 的验收以实际驱动和隔离数据库为准，见验证记录。

## 资源、取消与日志

source 的 maxConcurrent 还受 maxConnections 限制，实例总并发/队列在数据库执行前生效。排队取消会移出队列；query deadline 包含排队/建立读连接/执行/获取。超时及时返回，但底层实际 cleanup 未结束不释放应用槽位。驱动取消或 socket close 不保证远端立即结束计算，也不证明执行结果。

读取、写预览与提交均联合获取实例/source 执行额度：不为等待 source 的请求预留实例执行名额。等待项同时受两级队列上限约束；取消或 queueTimeoutMs 到期时从两级队列一起移除，不能迟到执行。active 表示已同时取得额度的操作，queued 包括等待任一级额度的请求。

MySQL 最多使用 maxConnections 个应用连接。Redis 每个开放库预留一个读连接，write profile 另预留 maxConcurrent 个独立提交连接。MongoDB 单主机使用 maxPoolSize 加两个监控连接。实例预算预先计入全部配置源。启动串行探测必需源和可选直连源，可选 SSH 源随后在后台连接。

MongoDB 读取在类型提升前保留 BSON，再转换为 canonical Extended JSON；编码后再计算单项/响应字节预算。可选 requireIndexedReads 只检查读取前的 winning plan，拒绝集合扫描/未知计划；不锁定预检后的索引或计划变化。

单项/响应预算是在解码后检测；JSON 转换可能暂时放大内存。Redis SCAN 一页、MySQL 大行、MongoDB 大文档不是硬 RSS 有界路径。生产只暴露小字段/视图，搭配 container memory/CPU/pids、数据库超时、索引与并发限制。当前没有任意大数据硬内存上限或生产容量压测结论。

node-redis 4.7.1 的 AbortSignal 经失败路径验证会污染已完成命令的队列，本适配器不使用它。取消会停止下一次获取，但已发出的有界命令等待真实结束，期间不释放应用额度；单条共享读命令到期后关闭连接，由驱动清空队列，随后释放实际额度。SSH 数据源通过重建隧道和数据库连接恢复，只接收新的工具请求。MySQL 取消明确销毁结果 stream 与连接；connect/control-command 等待也有应用取消边界，不依赖 driver destroy 一定完成 promise。

stdout backlog 达到 2 MiB 关闭 stdio；stderr 超过背压阈值停止写新审计，不承诺无损记录。并发/队列限制不等于累计读取配额或速率限制；没有多用户计费/租户配额功能。模型对已授权读取结果的后续处理，以及客户端其他工具可能的外发/文件访问，不在此数据库只读边界内。

读取审计固定白名单，无参数/结果日志。不记录未知用户输入 sourceId/工具名。日志接收方须设置配额、轮换和留存，避免 stderr 堆积；只读审计不提供 exactly-once、完整操作记录或崩溃恢复证明。`list_sources` 报告本进程观察到的状态，初始化和恢复成功后为 `ready`。SSH 数据源的临时连接故障显示为 `reconnecting`，直连 Redis 的持久连接关闭和需要人工处理的错误显示为 `unavailable`。

## 发布与安全回滚

先通过 schema/单测/MCP 冒烟/原生权限/TLS/隔离三库测试及打包文件审查，再由管理员部署。`npm audit` 只表示已知公开依赖漏洞扫描，不代表无漏洞；固定版本和 lockfile 不代替安全更新流程。发布前需要补足验证记录中的未测项。

发布 whitelist 不包含 1.x handler/connector/security/config-loader、测试、`.env`、本地配置或秘密。旧模块仍在仓库供回归测试，不能被误当作 v2 API 使用。write profile 默认关闭，生产组合拒绝；已验证 W 子集和故障证据见验证记录，不能把开发/测试通过视为生产批准。
