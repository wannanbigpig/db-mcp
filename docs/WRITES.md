# 开发/测试受控写入与恢复

仅用于管理员明确隔离的 development/test 数据库、独立 stdio 实例和独立写账号。生产 `read_write`、`admin`、原始 SQL、DDL、批量、动态连接和模型提交脚本均不支持。不要把生产库标成 test 来绕过限制。模型能调用 prepare/commit，**这不是可信人工审批**；生产写入专项与独立审批仍不在本次交付范围。

## 配置与上线前准备

以 [写入示例](../examples/config.write.example.json) 为模板，实例/source 同时显式声明 `read_write`，并配置 `access.writes`。每个创建、更新、删除分别默认关闭。只读 source 不能声明写策略。可写字段必须属于允许读取的字段，定位键和版本字段不能被任意赋值。未配置对象、任意过滤、upsert 和批量操作都会被拒绝。

两层 tier 若省略均默认 `read_only`，账号的原生写能力和 `allowedTools` 均不能自动升权。只有完整显式的应用写授权才开放对应流程；不要求把所有动作同时打开，也不存在万能 `full_access`/admin 模式。省略/只读模式却保留写策略或只读实例的 journal 属于矛盾配置，拒绝启动，不静默转换为可写或忽略错误。[应用授权矩阵](SECURITY.md#应用权限先于数据库权限)

只读配置现在可默认 `readScope:"database"`，但不能直接把 tier 改成 `read_write`：可写 source 必须改为 `readScope:"allowlist"` 并声明明确对象/字段或 key 前缀，完整写策略与动作授权仍必需。Redis 写 source 还必须使用非 `default` 的专用 ACL 身份。

journal 目录必须由管理员提前建立，位于仓库和发布目录之外，是当前 UID 所有的真实目录、0700 或更严；整个路径由可信运维控制。仅支持提供 `getuid`/Unix 文件语义的环境，Windows 不开放 write profile。不要放在不能提供可靠 rename/fsync 的共享/NFS 文件系统。本次验证的是本机 macOS 文件系统，不证明所有容器/磁盘故障下的 durability。

`--check` 只做配置/秘密引用/URI 检查，不连接数据库，不证明 journal 可写或原生权限合规。普通启动打开 journal 后再连接固定数据库；必需 source 失败则关闭实例。既有 journal 的 instance name 必须匹配，变更名称需管理员管理已有记录，不能覆盖记录重新开始。

### MySQL 8.4 / mysql2 3.24.5

只支持 InnoDB **完整 PRIMARY KEY**：显式声明 `keyColumns` 的顺序必须与真实主键一致，键不可 NULL，只支持整数（JS 安全整数）或 char/varchar 字符串类型；不支持部分、可空、表达式、前缀或其他唯一索引定位。手动传入完整键，新建不使用 auto_increment/隐式生成键。`versionColumn` 必须为非空整数，服务端从 0 开始并按协议 +1；上限为 JS 安全整数和数据库列范围的交集。

管理员审查并安装 [mysql-write-guard.sql](mysql-write-guard.sql)，由可信、能完整观察触发器及跨 schema 外键的 **DEFINER** 持有；MCP 账号只获得该例程的 EXECUTE 和指定表所需 SELECT/INSERT/UPDATE/DELETE。不授全库写、TRIGGER、DDL、FILE、管理权限或其他 EXECUTE。这个固定例程仅用于元数据读取；安装脚本不会自动执行，也不会自动创建账号。`READS SQL DATA` 不能替代管理员审查例程源码/DEFINER。元数据可见性不足、修改该例程或账号授权均需重新审核，不能用直接查 information_schema 的不完整结果证明没有触发器。

预览与提交各使用独立连接和事务；先在目标获取 metadata/row lock，再调用固定 guard 检查引擎、全部列/索引、外键和触发器。返回集合数量/规模异常失败关闭。提交重新计算 schema 指纹并比较预览，拒绝这些元数据的漂移。指纹只覆盖 guard 返回的指定字段，不涵盖全部 DDL，例如 CHECK 定义、分区及其他未返回的表选项；原生 CHECK 仍在 DML 时执行。管理员修改未覆盖的结构或业务约束后，应停止实例并废弃既有预览，再重新审核配置。触发器、自动 ON UPDATE 列、可写/版本字段的外键，以及涉及这些字段的 CASCADE/SET NULL 更新不支持；CASCADE/SET NULL 父记录删除不支持。只报告直接影响数量，不宣称总影响。正常外键约束由服务器检查；未经支持的业务副作用交给专用工具，不放宽 guard。

读取与 DML 使用参数化值。事务启用严格 sql_mode、REPEATABLE READ、有界锁等待；版本及无变化检查、DML、COMMIT 使用同一连接，不复用污染会话的池。目标缺失/版本冲突不提交；无变化不推进版本。最多直接修改 1 行，失败回滚，所有连接最终销毁。COMMIT 确认丢失保持未知，不能因后续 ROLLBACK 返回成功就推断原 COMMIT 未执行。没有应用层断线重试。

更新使用**单条单表 UPDATE**，业务字段赋值在前、条件版本赋值在最后，比较数据库赋值/转换后的实际值，而不是用 `_ci` 排序规则把大小写或重音变化误当无变化。这样业务字段和版本一起接受原生 `CHECK` 检查，不产生拆成两次 UPDATE 的中间态。专用提交连接关闭 `CLIENT_FOUND_ROWS`；无变化回滚且不推进版本，真实变化还须读回版本确实 +1 才提交。数据库列版本上限只拒绝真实变化，不因相同赋值而溢出。[MySQL UPDATE 语义](https://dev.mysql.com/doc/refman/8.4/en/update.html)

提交在既有行锁内先检查**本次更新涉及字段**的原值二进制表示总长度，不超过 source `maxItemBytes` 才用固定会话变量保存；超限为 DML 前 `not_started / BUDGET_EXCEEDED`，即使新值很小也不绕过。原字段内容不返回 Node、不做摘要落盘、不进入日志或 journal，连接销毁后释放变量；这不是整行大小或服务器 RSS 的保证。变量只在独立 SELECT 中写入，UPDATE 中只读。数值/字符串/二进制/时间/JSON 类型按存储表示比较：FLOAT/DOUBLE 先提升 DOUBLE，ENUM/SET 比较序号/位集，TIMESTAMP 使用原生 UNIX_TIMESTAMP 而非受时区影响的显示文本；geometry 和未知类型的 update 失败关闭，不宣称支持全部字段类型或物理存储字节等价。代表性原生测试范围见 [VALIDATION.md](VALIDATION.md)。会话变量不构成数据库管理员或持有 Performance Schema 观察权限者的秘密隔离，仍须限制管理/诊断权限。[会话变量](https://dev.mysql.com/doc/refman/8.4/en/user-variables.html)、[UNIX_TIMESTAMP](https://dev.mysql.com/doc/refman/8.4/en/date-and-time-functions.html#function_unix-timestamp)

### MongoDB 7.0 / driver 6.21.0

仅固定单主机、可写主节点的副本集支持写入；standalone/mongos/view/time-series/clustered collection 不支持。仍不提供自动发现和故障转移。只接受 `_id` 精确定位，不把声明唯一的其他字段或 partial/sparse 唯一索引当作唯一证明。

普通 `mongodb_find` / `mongodb_find_one` 的读取结果使用 canonical Extended JSON，整数为 `{"$numberInt":"42"}`，ObjectId 为 `{"$oid":"0123456789abcdef01234567"}`，旧版 BSON Undefined 为 `{"$undefined":true}`。驱动可表示的 BSON 日期保留精确毫秒。日期超出 JavaScript Date 范围时，读取返回 `BSON_DATE_OUT_OF_RANGE`。字节预算按转换后的结果计算。写入的 `expectedVersion` 仍使用 JSON 安全整数，业务值使用标量，定位 `_id` 额外接受 `$oid`。

写策略形态：

```json
{"tier":"read_write","collections":["items"],"fields":{"items":["_id","version","name"]},
 "writes":{"collections":{"items":{"versionColumn":"version","writableColumns":["name"],
 "allowInsert":true,"allowUpdate":true,"allowDelete":false}}}}
```

在固定 collection 授予必要 find/insert/update/remove/listIndexes，数据库授予 listCollections 用于真实 UUID/对象元数据；不授 dbOwner/root/dropCollection 等管理能力。元数据仅内部使用，不通过普通列表工具枚举其他集合。应用字段白名单不能替代 MongoDB 原生集合权限。

MySQL/MongoDB 的整数版本是业务合作协议，不是永久记录身份：所有其他修改方也须推进版本，不能在有效预览期间删除重建、复用同一定位键并把版本重置（ABA）；MCP 自身的 delete + insert 重用同键也可能产生该风险。默认示例关闭 delete。管理员若不能保证版本协议/键代次，就不要开放对应更新/删除，应使用带不可复用 generation token 的业务专用工具，而不是把相同整数当作“必定是原来那条记录”的证明。

MongoDB 的版本字段须存为 BSON Int32、Int64，或值为整数的 Double，且在 0 至 `Number.MAX_SAFE_INTEGER` 之间。预览和提交均检查实际存储类型，非法类型或超限返回 `SCHEMA_UNSAFE`。

校验真实 `_id` 索引、collection UUID/options/indexes。提交开启 snapshot 事务，在目标开始快照后再次校验元数据指纹；drop/recreate 或索引漂移拒绝，不把同名新 collection 当作预览目标。无变化通过服务端 `$expr` 标量比较，只返回版本/定位标识，不拉回待覆盖的大字段。顶层标量字段 `$set` 和服务端版本 `$inc`，单文档 insert/delete；无 upsert、pipeline、数组、任意操作符或嵌套字段覆盖。

write concern 为 majority + journal，提交和 socket 时间有限。不使用 withTransaction 或业务/DML 重试，`retryReads=false`、`retryWrites=false`。**官方 session.commitTransaction 仍可能对同一事务的 commit 重试一次**，这属于确认相同事务而非重新执行 DML；deadline/确认仍失败则未知。清理时可能再次发送 abort，不重放 DML；不能把 driver abortTransaction 的忽略错误语义当作确认回滚。支持范围以锁定驱动及真实副本集测试为准。[官方事务规范](https://github.com/mongodb/specifications/blob/master/source/transactions/transactions.md)

### Redis 7+ / node-redis 4.7.1

仅精确前缀内字符串 key；值及 expectedValue 最大 min(4096, maxItemBytes) UTF-8 字节。创建/覆盖/删除分别允许，覆盖和删除强制 expectedValue + expectedTtl，禁止“先 GET 后单独写”的比较竞态。创建必须选择 clear/expire，覆盖明确 keep/clear/expire，删除不接受 value/ttl；expire 秒数不超管理员 maxTtlSeconds（默认 86400）。

写策略形态：

```json
{"tier":"read_write","keyPrefixes":["dev:"],"allowKeyspaceScan":false,
 "writes":{"allowCreate":true,"allowReplace":true,"allowDelete":false,"maxTtlSeconds":86400}}
```

读 client 预览仅观察现状，取值本身也用有界 GETRANGE，避免 STRLEN 与读取间的扩容竞态；真正提交用 **固定的服务端 Lua** 原子检查类型、长度、预期字节值和执行时 PTTL，并 SET/DEL。脚本是程序常量，所有参数通过 ARGV，不接受模型脚本。TTL 条件 persistent 要求 PTTL=-1；expiring 要求执行瞬间 minMs≤PTTL≤maxMs，区间会随自然倒计时失效。replace + 相同值 + keep 返回 no_change，否则 TTL 调整也算修改。过期/并发覆盖返回 VERSION_CONFLICT。`keep` 使用 KEEPTTL，不隐式清除原 TTL。[Redis 脚本/ACL 语义](https://redis.io/docs/latest/develop/programmability/lua-api/)

专用 ACL：除实际需要的读取外，内部需要 ping、info|server、type、eval。replace/delete 的预览及比较还需要 strlen、getrange、get、pttl；create/replace 需要 set，delete 需要 del，全部限定 `~dev:*`；非 0 DB 另需 select。不授 flush/config/acl/function 等。Redis 7+ 在脚本内部检查调用者的命令与 key 权限，不能扩大账号 ACL。授予 EVAL 后，该数据库身份通过其他渠道可以提交脚本，因此 OS 凭证隔离和原生精确 ACL 仍重要。

以下为三个动作全部开放时的完整权限模板，在管理员的 Redis 交互终端执行。`db_mcp_writer` 应事先通过管理员秘密管理流程创建、启用并设置强密码；这里仅收紧权限，不包含密码或修改身份认证。只开放部分动作时按上段删去不需要的命令；同时在 MCP 配置中关闭相应动作。

```text
ACL SETUSER db_mcp_writer resetkeys resetchannels -@all ~dev:* +ping +info|server +type +strlen +getrange +get +pttl +eval +set +del
```

使用非 0 DB 时在同一规则后追加 `+select`。普通读取工具若另需 `scan` 或 `memory|usage`，单独审查并授权；模板默认不授予它们，`redis_get` / `redis_get_range` 使用已有的 `getrange`。

启动 INFO server 验证 Redis>=7，已确认执行的级别是 Redis 回复，不承诺持久化/跨节点 majority，备份/AOF/副本由管理员配置。每次提交使用独立 socket，连接预算额外保留 maxConcurrent 条；禁用 offline queue、自动重连和 driver AbortSignal。明确的 `EVAL` 或脚本内部 ACL 拒绝返回 `failed / WRITE_REJECTED`。取消/退出销毁写 socket，命令送入驱动后无法确认结果即未知，不自动重放。

## 操作协议

1. 调用相应 `mysql_prepare_write` / `mongodb_prepare_write` / `redis_prepare_write`，参数不含凭证/地址。只有条件匹配才产生服务端 UUID `operationId`，默认 60 秒有效；返回单目标及状态摘要，不保存参数正文到磁盘。
2. 调用 `commit_write`，仅 `{sourceId,operationId}`，不能修改参数。条件/元数据在执行时重新校验；并发重复调用同 ID 不重新发写入。
3. 检查返回 `state`，不能只看 MCP isError。目标不存在为 `TARGET_NOT_FOUND`，条件冲突为 `VERSION_CONFLICT`，数据库明确拒绝且确认未生效为 `WRITE_REJECTED`。排队超时返回 `not_started / REQUEST_CANCELLED`，队列满返回 `not_started / BUDGET_EXCEEDED`。提交可能为 `not_started`、`success`、`failed` 或 `unknown_outcome`，直接数量仅 0/1。无变化返回 `success` 和 `effect: no_change`。
4. 查询 `operation_status`。超时先保守报告 unknown；同一进程晚到的明确确认可以修正为 success/failed，并清除过时错误码；最终持久化已故障时也在内存中如实报告确认结果并标注 journalDegraded，重启只信任磁盘记录。重复 commit 只返回已有状态。重启后不会靠读回猜测修正未知，更不会恢复执行。**存在 unknown 的 source 拒绝新的预览/提交**，不能换 ID 盲目重试；读取/状态查询保留，`server_runtime_status.writeBlockedSources` 给出受阻 ID。晚到确认若持久成功可解除该 source 的阻断，磁盘未知仍需管理员核查。

预览不修改业务数据，但会持久登记新操作；相同参数再次预览也会产生新 ID、消耗 journal 容量。其 MCP annotations 为 `readOnlyHint:false`、`destructiveHint:false`、`idempotentHint:false`。读取与状态查询仍标注只读；这些提示不改变服务端写授权，也不把预览变成人工审批。

MySQL 和 MongoDB 的 `expectedVersion` 接受到 `Number.MAX_SAFE_INTEGER`。达到该版本后，无变化更新仍返回 `no_change`，已授权删除仍可执行。需要继续递增的更新返回 `VERSION_LIMIT_REACHED`，数据库内容不变。

MySQL 示例：

```json
{"sourceId":"dev-mysql","table":"items","action":"update","key":{"id":1},"expectedVersion":0,"values":{"name":"next"}}
```

Redis 示例：

```json
{"sourceId":"dev-cache","key":"dev:item:1","action":"replace","expectedValue":"old",
 "expectedTtl":{"mode":"expiring","minMs":1000,"maxMs":60000},"value":"next","ttl":{"mode":"keep"}}
```

操作记录仅保存 UUID、已知 source/tool、状态、时间、随机启动代次、稳定结果码及直接数量/版本。无原始 key、表过滤、值、SQL、URI或参数 hash；低熵值不会因简单摘要落盘。精确参数和 schema 指纹仅保存在当前进程的限额预览上下文中。记录目录/文件权限不能隔离同用户 Agent，也不提供独立防篡改审计。保护范围是该实例/source，不是跨实例的业务全局去重；不要用不同 source 别名或 journal 同时写同一目标来绕开未知阻断，管理员须协调目标归属。

## journal 故障、容量和恢复

记录文件最大 4 MiB，默认最多 1000 条、保留 7 天，最多 20 个有效预览；配置上限 10000 条/90 天/100 个预览。已完成或未开始且超过 retainUntil 的记录仅在新建时清理；pending/unknown **永不被普通清理移除**。容量满停止新写入，不能删除未核查未知项腾空间。ID 由服务端生成，不接受未登记 ID 作为新操作，也不承诺无限保留去重。

每次 snapshot 使用 0600 临时文件、fsync、原子 rename、目录 fsync；读回验证 ownership、权限、大小、schema，损坏文件拒绝启动，不静默清空。进入驱动前必须持久 pending；该步骤失败不发写入。两层队列获准后以及首条 DML 发送前都再次同步检查 journal 健康、取消和 source 未知状态；连接/元数据等待期间发生降级，也不能迟到发送尚未执行的写入。最终记录失败但数据库已确认成功：如实返回 success + journalDegraded，关闭尚未发送的写入，不把成功伪装成未执行；已发送的操作仍等待真实确认，磁盘旧 pending 重启仍视为未知。

状态查询在快照保存完成后才显示新的持久状态。确认结果处于未知时立即阻断该 source 的后续写入，即使记录仍在等待保存。晚到确认只有在成功持久化后才解除阻断。

单目录单实例，通过 O_EXCL writer.lock 防重复 writer，不共享多个进程。正常退出停止新提交、取消排队、关闭连接、等在途真实清理后释放锁。5 秒退出上限可能留下 pending/锁；崩溃锁不按 PID 猜测自动删除。

恢复步骤（管理员执行，MCP 没有解锁/重放工具）：

1. 停止并确认该 journal 的 **所有**实例已经退出；保留目录和 operations.json 备份，检查磁盘/权限，不打印数据到聊天。
2. 只移除该私有目录的 `writer.lock`；不要删除整个目录、operations.json 或 unknown 记录。不能在旧实例仍运行时解锁。
3. 使用同名实例、当前受控配置/新秘密启动；prepared 因丢失内存上下文成为 not_started，pending 成为 unknown_outcome。没有自动重放。
4. 经授权查询 operation_status 及数据库/业务审计。仅值相同、目标不存在或版本变更不能证明此操作执行了；没有可靠操作标识时保留未知。不要自动补偿、自动重试或创建新的幂等表。
5. 将已核查结果及备份交给受控运维流程管理；本版不提供修改未知状态或强制删记录的模型工具。容量不足时换目录前先停旧实例并保留未知记录、核查清单；新实例不能继承“旧操作未执行”的假设。

凭证轮换同样先处理 pending/unknown、停止旧实例并关闭旧会话，再启动新身份；账号改密/off 不证明旧数据库会话已撤销。不得重放旧 journal。应用没有通用自动回滚、exactly once 或跨库事务承诺。
