# v2 本地验证记录

以下按日期记录本地回归、隔离三库及打包验收。每次验证的范围以对应记录为准。

## 2026-11-25 v2.0.0 发布前验证

- Node.js 25.9.0 的现役回归通过 184 项，另有 2 个 Docker 聚合单独运行。历史回归通过 30 项。
- 隔离三库集成通过 41 项，覆盖只读查询、SSH、默认为单库、显式切库、黑名单、带连字符的 MySQL 库名、TLS 证书错误和受控写入恢复。
- 校验了带注释的三库配置、最小配置模板、Codex TOML 与通用客户端 JSON。配置示例执行 `--check` 成功。构建生成的 JSON Schema 与运行时一致。
- 全新目录按锁文件安装成功。npm 打包白名单、凭据检查、隔离安装和配置向导验证通过，产物包含 121 个文件。

## 2026-11-24 本地 SSH 故障修复与自动重连

- 先复现 SSH 已打开通道关闭后的引用/缓冲滞留、Redis 静默命令不释放额度、MongoDB 显式端口 80 被误改、MySQL 预览断线误报，再验证修复。补了同一隧道反复关闭、已有缓冲、容量为 1 时等候关闭确认、MongoDB 默认/非默认端口与 IPv6、URI 离线校验，以及重连继续使用启动快照的回归。
- 真实本机 TCP/SSH 故障代理和 stdio 子进程。突然断开时，测试 Redis 服务应用写入后切断链路，丢失确认。多次重试失败后恢复，原进程可读回值，其他数据源可继续工作；旧操作状态和重复提交仍为 `unknown_outcome`，EVAL 仅发送一次。另一个用例保持已建立 TCP 并丢弃双向 SSH 流量，约 20 秒探测到断线，恢复后在同一进程读取成功。旧队列、预览失效和未发送提交另有独立回归。
- 本机原生 Redis 临时实例另测了数据库独立停止并重启。SSH 服务继续监听，同一 registry 自动恢复该数据源并读取新值。使用隔离回环端口、临时目录和合成数据，结束时清理实例与文件。
- Node 25.9.0 上 `npm test` 现役 150 项通过、2 个 Docker 聚合默认跳过，历史 30 项通过。104 文件发布包白名单、执行模块图、凭证样式、缓存隔离安装和配置检查通过，生成的 JSON Schema 一致。
- Docker Desktop 本轮启动等待超时，三库容器集成未运行。实际 Wi-Fi 切换、休眠唤醒、企业 VPN 和真实 OpenSSH 跳板未现场验证。环回测试未改变主机网络配置。

## 2026-10-26 审查缺陷修复与联合额度调度

MySQL JSON 列改为返回数据库 JSON 文本字符串，保留高精度小数、大整数和 JSON 类型；JSON null 为字符串 `"null"`，SQL NULL 为 `null`。调用方需要无损 JSON 解析器，不再将 JSON 列假定为已解析对象。普通列、等值过滤和权限范围沿用既有契约。

读取、写预览与提交使用共享等待项，同时取得实例/source 执行额度；等待项计入两级队列，取消/排队超时一起移除，运行操作仍等真实清理完成才释放两级额度。写预览明确标注为非只读、非幂等、非破坏性的 journal 登记；业务提交授权和 unknown_outcome 阻断保留。普通 build 不再改写配置 Schema，开发者通过 `npm run schema:generate` 显式更新，现有 CI 的构建后检查可以发现遗漏。

| 验证 | 实际结果与边界 |
| --- | --- |
| 修复前失败证据 | 三个跨 source 的 read/preview/commit 回归、预览 annotations、stale Schema 构建检查共 5 项失败；原生 MySQL JSON 回归另行失败，包含小数舍入、大整数/字符串及 JSON null 类型差异 |
| TypeScript 与现役回归 | 构建通过；Node 22.23.3、24.19.0、25.9.0 各 125 通过、0 失败、2 个 Docker 聚合默认跳过 |
| 联合额度边界 | 实例/source 队列各自满额、取消两级等待、排队超时不迟到执行、任一级容量释放后唤醒、运行取消保持实际额度均通过；既有 journal 故障 gate、未知阻断和晚到确认回归通过 |
| 隔离三库集成 | Node 25.9.0：31/31 通过；新增 MySQL JSON 文本与服务端 CAST 文本逐项一致，保留原生授权、TLS、SSH、CAS/事务、丢确认未知和不重放场景 |
| Schema 工作流 | 隔离真实 TypeScript 构建保留 stale 文件，--check 返回失败；显式生成后检查通过。项目 schema:check 通过；未修改配置字段或依赖 |
| 实际产物与安装 | Node 24.19.0：104 文件 tarball 的白名单、执行模块图、凭证样式、隔离安装、读/写/SSH 离线检查和向导 profile 检查通过；未发布 |

Node 22/24 本轮执行现役回归，三库聚合本轮在 Node 25 实跑。保留原有未提交文件和暂存删除；未读取或修改真实配置/秘密，不连接业务库、不提交发布。真实 OpenSSH/VPN、生产授权/TLS、客户端及远程 CI 未验收。

## 2026-10-24 全量审查修复与配置维护优化

修复 SSH 待开通通道超时后累积、秘密分片粘贴回显、MongoDB BSON 有损序列化、stdio 合并合法消息误拒绝、Redis ACL 文档缺 GETRANGE。新增脱敏配置诊断/有效工具清单、发布 JSON Schema、提前选择 SSH 的向导流程、默认关闭的 MongoDB 索引预检。按数据库整理适配器、将 WritePlan 改为判别联合；1.x 实现和测试移入 legacy，现役并发测试保留。构建清理旧 dist，发布白名单与导入图继续生效。

| 验证 | 实际结果与边界 |
| --- | --- |
| 缺陷回归 | SSH/stdio 新测试修复前 5 项失败；秘密粘贴 3 项和向导顺序先失败；BSON、索引检查先失败，修复后对应专项通过 |
| 构建与配置 schema | TypeScript 构建通过；schema:check 通过，示例使用相同生成 schema；运行时继续执行跨字段安全校验 |
| 现役与历史分组 | Node 22.23.3、24.21.0、25.9.0：现役各 114 通过、0 失败、2 个 Docker 聚合默认跳过；legacy 各 30/30 通过。历史测试不计作 v2 覆盖 |
| 隔离三库 | Node 24.21.0、25.9.0：各 30/30 通过；读取/TLS/权限含 BSON 精确类型及索引预检正反向，写入含文档 ACL 模板、SSH、原子条件、确认丢失和不重放 |
| 实际产物与安装 | 104 文件 tarball 的白名单、执行模块图、凭证样式、隔离安装、离线读/写/SSH 配置、向导 profile 和发布 schema 一致性通过；未发布 |
| 真实终端 | Unix PTY：延迟和分片 bracketed paste 多行拒绝、无秘密回显；单行 UTF-8/首尾空格保持、独立 Enter 提交、正常退出并恢复 ECHO |
| 独立交叉复核 | 配置默认权限/脱敏/离线检查、终端输入、SSH/stdio 生命周期、BSON/索引及写入类型拆分未确认新缺陷；修正旧 README 对合并输入的描述 |
| 生产依赖审计 | 官方 npm registry：0 项公开告警。SDK 1.32.2、Zod 4.6.7；body-parser 2.4.0、fast-uri 3.1.9、ip-address 10.7.4。现役配置/工具/journal 已迁移 v4，不再导入 zod/v3 |

MongoDB find/find_one 现在返回 canonical Extended JSON；整数、ObjectId 等具有类型包装，调用方须按新响应契约解码，过滤输入仍限制等值标量/`$oid`。索引检查只做执行前预检，不冻结后续索引或执行计划；未识别计划保守拒绝。秘密粘贴保护依赖终端 bracketed paste 标记，无标记的延迟输入无法与下一次正常回答区分。

未连接实际业务数据库、未修改用户真实配置或秘密、未提交或发布。真实跳板/OpenSSH/VPN、生产 TLS/授权及客户端验收仍未完成；Node 22 本轮未重复 Docker 聚合，Windows 未验证。版本安装曾遇到 npm 子进程下载停滞，改用官方 npm registry 的平台包并校验 SHA-512 后运行 Node 24；不修改系统默认 Node。

## 2026-10-24 固定数据源的可选 SSH 通道

三种数据库共用 SSH 通道生命周期管理，每 source 固定一个目标，支持密码及加密/无口令私钥引用，强制 SHA256 主机指纹校验，保留数据库 TLS 原身份、范围与写入策略。新增中文向导选项、[配置示例](../examples/config.ssh.example.json) 与[中英文说明](SSH.md)。断线关闭数据库连接并标记 unavailable，不自动直连或重放写入。

| 本轮检查 | 结果与证据范围 |
| --- | --- |
| 测试先行 | 最初新增 4 个配置行为测试：旧实现 2 通过、2 失败，确认缺少可选 SSH 契约；再实现并补失败与资源边界 |
| TypeScript 构建与完整默认测试 | Node 25.9.0，128 项中 126 通过、0 失败、2 个 Docker 聚合默认跳过；含真实 stdio、SSH 子进程离线 `--check`、向导密码/私钥及旧功能回归 |
| 本地真实 SSH | 临时 `ssh2` 服务与真实 TCP 数据流；密码、加密私钥认证、主机指纹在认证前拒绝、错误凭证、超时、中途关闭、转发拒绝、连接上限、断线及重复关闭等待完整清理均通过 |
| 隔离三库读取/TLS/权限聚合 | Node 25.9.0、Docker 29.3.1；14/14 通过。MySQL 8.4.8、Redis 7.4.7、MongoDB 7.0.31 经真实 SSH 转发读取；原身份 TLS 校验生效，错误主机名拒绝，策略不放宽，断线状态变 unavailable |
| 隔离受控写入聚合 | 15/15 通过。三库经 SSH 的预览、提交、重复提交保护和管理员读回；确认包在 SSH 内丢失后保持 unknown_outcome，重复提交不重放；保留原有事务、版本/TTL、漂移、轮换及协议回归 |
| 实际产物与隔离安装 | 87 个文件，通过 whitelist、执行模块导入图、凭证样式检查、隔离安装、原读取/写入及新增私钥 SSH `--check`；setup/database/allowlist profile 检查通过，未发布 |
| 改动复核 | `git diff --check` 通过。保留既有未提交改动，不读取或修改真实配置/秘密；测试仅使用一次性账号、证书、容器和随机 loopback 端口，结束后无本次测试容器 |

新增 `ssh2@1.17.0` 及开发类型 `@types/ssh2@1.15.6`，禁用安装脚本的安装路径亦已验证。官方 npm registry 的生产依赖审计仍报告 4 个既有依赖包：`body-parser`（high，[公告](https://github.com/advisories/GHSA-27r3-jxmh-p828)）、`fast-uri`（moderate）、`ip-address`（moderate，[公告](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5)）、`zod`（high，[公告](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)）。前三者来自既有 MCP SDK 链，Zod 也是既有直接依赖；新增 SSH 依赖链未命中。未评估全部可达性或声称无风险，本次未扩大范围执行 Zod 4 迁移或无关依赖升级。

真实跳板机、OpenSSH 服务配置、VPN 路由、生产 TLS/原生授权、用户客户端重启均未验收；未在本轮重跑 Node 22/24 或 Windows。SSH agent/MFA/多级跳板和 MongoDB 自动故障转移不在首版范围。测试使用的 SSH 服务是本地协议 fixture，不能代替用户服务器验收。

## 2026-10-15 默认固定数据库全读与本地配置迁移

用户明确默认全部可读后，未设置范围的只读 source 默认 `readScope:"database"`；保留已有范围的 allowlist 推断与限制，显式空旧名单不放宽，database 与非空名单冲突失败。全库模式可读取敏感字段，不自动脱敏；不开放跨库参数、任意 SQL/脚本、写入或移除预算。Redis default 仅兼容只读密码认证，扫描仍默认关闭；写 source 仍要求明确白名单和非 default Redis 身份。向导默认选全库，可另选名单；原秘密终端输入保护未改。

| 本轮检查 | 结果与证据范围 |
| --- | --- |
| 测试先行 | 新范围测试旧实现 2 通过/8 失败，向导 11/8，适配器最初 1/4；实现后全部通过，没有删除旧范围/安全断言。另补原生大小写元数据回归：原实现通过，疑点不成立，未做推测性 SQL 修改 |
| `npm run build` | TypeScript 全 src 构建通过；新增适配器测试两处 TS7022 通过显式类型修正 |
| Node 22.23.3 / 24.21.0 单元及真实 stdio | 两版各 110 通过、0 失败、2 个 Docker 聚合默认跳过；含 database/allowlist 推断与往返、直接隐藏写拒绝、全字段/列表/取消及三库向导默认问答。stdio 显式/缺省 tier 及无范围配置均保持只读 |
| Node 24.21.0 隔离读取/TLS/权限聚合 | 13/13 通过，真实 MySQL 8.4.8 / Redis 7.4.7 / MongoDB 7.0.31；既有名单不放宽，同身份 database 可读新增/敏感字段、Mongo `_id`、原生可见列表、Redis default 真认证；同一原生可写身份 MCP 拒写且读回未变，扫描仍须另开 |
| MySQL 原生元数据边界 | `lower_case_table_names=0`，同一账号同时可见 `test.reports`、`test.Reports`、`TEST.reports`；database 仅列固定 schema 两表，allowlist 只列精确表，describe 不串表/库列；maxRows=100 不用截断掩盖越界 |
| Node 24.21.0 隔离受控写入聚合 | 13/13 通过；复核原有三库 CAS/版本/TTL/事务、schema 漂移、丢确认未知/不重放、轮换与真实写协议，本轮不将全库读取范围用于写 source；未重跑 Node 22 Docker 聚合 |
| 本地真实配置迁移（离线） | 先保留仓库之外的0700目录/0600原始备份，再把密码/URI提取为0600 file秘密，原子替换同路径 config 为0600 v2，三 source 固定database全读、RO、verify_identity，无journal/writer。Mongo保留原认证库语义；密码空格/尾LF/CRLF/单CR及显式authSource经一次性fixture验证。schema/引用/adapter仅构造并关闭与实际CLI `--check`通过，没有connect/ping/read用户数据库 |
| 迁移脚本交叉复核 | 修复独占创建失败时可能清理既存候选文件的问题，只清理由本次实际创建的临时文件；文件和相关目录fsync、rename前比对旧bytes、读回验证。真实路径别名导致CLI未执行被`--check`发现，新增子进程fixture先失败、按realpath识别入口后通过，未把空输出/exit0当迁移成功 |
| `node scripts/verify-artifact.mjs` | 实际tarball 81文件 whitelist/import graph/凭证样式、隔离安装、原读/写`--check`、安装包生成名单及三库database profile后`--check`，Redis default/扫描关闭与客户端参数校验通过；非TTY setup拒绝，不发布 |
| 独立复审 | schema/policy与driver/native fixture分别交叉检查；修正README扫描行与database空prefix说明矛盾，当前无剩余已确认缺陷。不把静态复核说成全部驱动故障时序已测 |

私有秘密文件及旧备份仍是明文、不是同UID Agent隔离或加密保险箱；同一用户的shell/文件工具仍可读取。实际数据库的TLS支持/私有CA、原生账号权限与视图依赖、客户端重启及生产部署均未验证；没有自动修改真实客户端，也没有降级远程TLS。目录fsync和原子替换不代表断电/NFS/全部介质故障已实测。依赖未变，未重做公开advisory扫描，不宣称历史结果持续有效。仅清理本次一次性测试容器/卷/fixture及Node临时缓存，保留真实配置、秘密、原始备份和镜像缓存。

## 2026-10-14 新手只读配置向导

以下为当日历史记录；当前默认全库、名单可选的契约以上方2026-10-15章节为准。

新增 `npm run setup` / `--setup [--directory /absolute/private/path]`，独立于 MCP 入口，仅接受本机交互终端及 Unix UID/文件权限。中文引导生成单 source 三库只读配置、0700 新 profile、0600 秘密文件及客户端 JSON 启动示例；不覆盖旧资料或真实客户端，不新增 MCP 工具，不主动连接数据库。密码隐藏、不 trim、不存 readline history；对象/字段/字面前缀显式填写，扫描/写入关闭，生产 TLS 不降级。多数据源与高级配置保留手工方式；Windows 保留手工 env 配置，不伪称自动向导可用。

| 本轮检查 | 结果与证据范围 |
| --- | --- |
| 测试先行 | 新模块尚不存在时两新 test 文件均因缺模块退出 1；不是声称各 case 已执行。模块实现后独立复跑配置/保存/问答 15 项通过；秘密终端模拟 6 项通过 |
| 密码粘贴失败回归 | 独立复审复现多行秘密尾部在下一问题公开回显；同 chunk / 同步缓冲跨 chunk 两项旧实现均失败。最终在 readline 前检查秘密 batch，当前输入轮次保持静音并拒绝多行/余项，取消输入、恢复 raw mode 和清理监听；两个回归及独立复验通过 |
| `npm run build` | TypeScript 全 src 构建通过 |
| Node 22.23.3 / 24.21.0：`node --test --test-reporter=spec dist/tests/*.test.js` | 两版各 89 通过、0 失败、2 个 Docker 聚合默认跳过；含正常 MCP stdio 的目录/错误脱敏及关闭 stderr 回归。数据访问实现未改，未重跑三库聚合，不把 skip 当新集成证据 |
| 配置/文件负向矩阵 | 三库只读且字段/前缀完整；密码特殊字符/首尾空格、Mongo URI 编码及整体 64 KiB 上限、TLS/IP/loopback、重复生成不覆盖、权限/symlink 拒绝、缺失 CA 清理、已取消不建目录、确认 n/EOF/Ctrl-C 静态错误 |
| 真实 PTY | 最终构建执行完整本机开发 MySQL 问答，密码不回显、首尾空格保留，生成配置/secret/client 权限及只读标志读回通过；真实多行秘密 paste 返回 1 且首行/尾部均未出现于输出，没有多建 profile。仅一次性 fixture，不连接 MySQL，也不是跨终端/所有粘贴分包时序穷尽证明 |
| `node scripts/verify-artifact.mjs` | 最新实际 tarball 81 文件 whitelist、import graph、凭证样式、隔离安装、原读/写 `--check`，安装包内生成 setup profile 后 `--check` 与客户端启动参数均通过；非 TTY setup 拒绝，不发布 |
| 独立复审 | 复核只读/TLS/显式范围、文件权限/不覆盖、密码隐藏/history/取消、URI 编码、setup 与 MCP 协议隔离，发现的多行粘贴缺陷修复后再次独立复验通过 |
| 文档/差异/清理 | 中英文 20 个仓库链接、9 个 JSON 围栏、8 个 shell 围栏语法及 10 个 npm script 引用离线校验通过；tracked/staged 及本轮新增源码/测试/脚本/验证文档无空白诊断。仅清理本次已分配的 PTY fixture 和私有 Node 缓存目录，旧配置、原 npm 缓存及数据库未动 |

Node 矩阵最初在开始测试前因默认镜像缓存 ENOENT 失败；随后只用本次私有临时缓存及公开 npm registry 拉取精确 Node 版本并通过，没有修改用户 npm 配置或删除原缓存。依赖未变，未重新做公开 advisory 扫描；不宣称扫描结果永远有效。三库原生读取/写入证据仍是下方 2026-10-10 记录，生产授权/连接/TLS 与远程 CI 未验证。向导的 file 引用是本机明文秘密文件，不是加密存储或同 UID Agent 隔离；准备真实数据库 scope/TLS 信息仍由管理员负责。

## 2026-10-10 默认只读与独立应用授权补强

实例和 source 的 `tier` 分别省略时默认 `read_only`，不根据数据库账号权限或实例写模式继承写能力。只有非生产实例/source 双重显式写配置、有效 journal、完整写策略及具体动作授权的交集才允许写；增改删各自默认关闭，不要求为了启用更新而同时开放删除。非法模式、矛盾配置及缺失写前置条件仍拒绝启动。

先新增失败回归，再修改共享 tier schema 的缺省值。修改前，缺省模式的配置/真实 stdio/可写 adapter/读写实例下缺省 source 四类测试失败；修改后全部通过。已有显式只读、配置失败关闭和具体动作授权校验无需放宽。

| 最新检查 | 结果与证据范围 |
| --- | --- |
| `npm run build` | TypeScript 全 src 构建通过 |
| Node 22.23.3 / 24.21.0：`node --test --test-reporter=spec dist/tests/*.test.js` | 两版各 68 通过、0 失败、2 个 Docker 聚合默认跳过；两个聚合已在 Node 24 单独真实执行 |
| 配置与授权负向矩阵 | 两层分别缺省只读；null/false/空值/full_access/admin 等不被转换为模式；8 类不完整或矛盾写配置拒绝。注入可写 adapter 与写工具 allowlist 仍零预览/零写入；读写实例、有真实 journal 和已登记操作 ID 的只读 source 仍拒绝 prepare/commit/status |
| 单动作正反向矩阵 | MySQL/MongoDB/Redis 各自仅开启一项动作，其余标志省略；授权动作通过策略检查，其他两项被拒绝。不是原生账号拒写作为通过依据 |
| 真实 stdio | 显式/缺省只读均正常启动，写工具不列出；强行调用写工具、旧工具和模式切换拒绝。旧 `DB_MCP_SECURITY_MODE=full_access` 不提升权限 |
| Node 24.21.0：`DB_MCP_DOCKER_TESTS=1 node --test dist/tests/integration.test.js` | 11/11；新增三库同身份原生 CRUD 正向对照成功，随后显式/缺省只读 MCP 正常读取、合法形状的直接写请求被应用拒绝、原生读回不变；保留 TLS/原生低权限/取消/扫描/投影回归 |
| Node 24.21.0：`DB_MCP_DOCKER_TESTS=1 node --test dist/tests/write-integration.test.js` | 13/13；显式 opt-in 的受控写入仍可用，保留存储转换/CHECK/预算、漂移、越权、未知结果/不重放、轮换和写协议回归；本次未重新运行 Node 22 的 Docker 聚合 |
| 独立交叉复审 | 复核 schema 默认值、应用早期门禁、真实 journal 绑定、动作独立默认关闭及三库原生可写正向对照；未发现隐式权限继承或把原生拒写误当应用授权的测试漏洞 |
| `node scripts/verify-artifact.mjs` | 最新运行代码实际 tarball 77 文件 whitelist、相对 import graph、凭证样式扫描、隔离安装及安装后读/写 profile `--check` 通过；不发布 |
| 差异/清理 | tracked/staged `git diff --check` 及本次未跟踪源码/测试/文档的 no-index 检查无空白诊断；隔离测试标签下无残留容器，保留镜像缓存 |

本次未修改依赖，沿用同日公开生产依赖 advisory 扫描 0 项的结果，不视为未知漏洞保证。测试中的可写 named 身份只用于私有隔离数据源的权限对照，不推荐生产使用高权限账号；数据库原生最小权限仍为第二道防线。生产写入仍不支持，远程 CI、生产 grants/视图/网络/秘密挂载与其他部署边界不因这些本地测试视为已验证。

## 2026-10-10 全代码审查修复与交叉验证

本轮修复五项有失败证据的缺陷，没有扩展生产写权限、连接范围或任意 SQL/脚本入口：

1. journal 降级后，已持久 pending 的另一 source 排队写入仍可能执行。现队列获准及首条 DML 发送前均同步复查健康/取消/未知状态；覆盖「尚在队列」和「已进 driver setup 但尚未发送」两个真实目录 rename 故障时序，均为 `not_started / JOURNAL_UNAVAILABLE / journalDegraded`，writer 不产生写副作用。已发送操作仍保留真实确认或未知，不盲目重试、不提前释放额度。
2. MySQL `_ci` 排序规则会把 `old → OLD`、重音等真实变化误报 no_change。改为行锁内有界服务端原值捕获、业务字段与条件版本推进**单条 UPDATE**、原生 changed-row 计数及后置版本校验。原生回归覆盖大小写/重音/VARCHAR 尾空格、CHAR/INT/DECIMAL 转换、NULL、严格转换拒绝回滚、跨字段 CHECK 与其 no_change、SMALLINT 上限、旧值超预算 pre-DML 拒绝、FLOAT 相邻可存值、ENUM/SET 序号/位集与 TIMESTAMP(6) 微秒。没有拉回旧字段或新增权限。
3. MongoDB 授权字段的父子路径及 `_id` 子路径会产生服务器投影冲突。仅去掉显式已选父路径下的冗余子项，不把只授权子项扩大成父项；真实独立低权限角色验证父子混选、仅子项、`_id` 子项，并拒绝越权父字段/隐藏子项/filter。
4. stderr 接收端关闭会以异步 EPIPE 终止 MCP。日志统一为有界 best-effort，隔离 stderr 错误；真实子进程关闭该管道后连续三次 MCP 工具调用成功。stdout 协议及真正的 uncaughtException/unhandledRejection 退出行为未被吞掉，journal 不依赖日志。
5. Redis 写预览在 TYPE/STRLEN/GETRANGE/PTTL 等待期间取消后仍继续获取。每次 await 返回即检查应用信号，四个边界分别精确验证不发后续命令；仍不向 node-redis 4.7.1 传 driver AbortSignal，保留已发送命令的实际容量与原有有界取值竞态保护。

| 本轮检查 | 结果与证据范围 |
| --- | --- |
| `npm run build` | TypeScript 全 src 构建通过 |
| Node 22.23.3 / 24.21.0：`node --test --test-reporter=spec dist/tests/*.test.js` | 两版各 61 通过、0 失败、2 个 Docker 聚合默认跳过；聚合已另行真实执行，不用 skip 代替集成证据 |
| Node 24.21.0：`DB_MCP_DOCKER_TESTS=1 node --test dist/tests/integration.test.js` | 10/10；真实只读权限/TLS、取消/扫描边界及新增 MongoDB 投影正反向场景 |
| Node 22.23.3 / 24.21.0：`DB_MCP_DOCKER_TESTS=1 node --test dist/tests/write-integration.test.js` | 两版各 13/13；真实三库及新增 MySQL 存储/约束/预算场景，保留 schema 漂移、原生越权拒绝、确认丢失/不重放、凭证轮换和 MCP 写协议 |
| 独立交叉复审 | 实施者之外复核最终日志、投影/取消、两层 journal gate 与 MySQL 更新/回滚语义；静态复核不冒充运行证据 |
| `npm audit --omit=dev --registry=https://registry.npmjs.org` | 本轮公开生产依赖 advisory 扫描 0 项；不是未知漏洞保证 |
| `node scripts/verify-artifact.mjs` | 最终运行代码的实际 tarball 77 文件 whitelist、相对 import graph、凭证样式扫描、隔离安装及安装后读/写 profile `--check` 通过；不发布 |
| 差异/清理 | tracked/staged `git diff --check` 无诊断；本轮未跟踪源码/测试/文档以 `git diff --no-index --check` 检查无空白诊断（新增文件 exit 1 正常）；隔离测试标签下无残留容器，未删除镜像缓存 |

每项修复都有旧路径失败与最终通过证据。MySQL 中间方案的两次 UPDATE 被新 CHECK 回归拒绝，未保留；最终表达式的 `+ NOT (...)` 被原生 1064 错误拒绝，隔离最小 SQL 实验确认后改为 `+ IF(...,0,1)`，完整 Node 22/24 三库回归再通过，没有弱化断言或隐藏失败。

新增兼容性/证据边界：更新涉及原字段的二进制快照总量受 source `maxItemBytes` 限制，旧值超限即拒绝，即使新值小；geometry/未知类型 update 失败关闭。JSON、DST 重叠、重复 ENUM 标签以及其余字段类型未逐项原生验证，不宣称全类型矩阵通过。预算不保证服务器转换临时内存或硬 RSS。详见 [WRITES.md](WRITES.md)。远程 CI、生产授权/部署及其余部署验收仍未执行。

## 2026-10-09 重构基线证据

| 检查 | 环境/命令 | 结果与范围 |
| --- | --- | --- |
| 改动前基线 | npm test | 34/34，通过原有回归测试 |
| 构建 | npm run build；TypeScript 5.9.3 | 通过，全部 src 类型检查 |
| 单测与真实协议 | Node 22.23.3 / 24.21.0 / 25.9.0，node --test --test-reporter=spec dist/tests/*.test.js | 56 通过、0 失败、2 个 Docker 聚合默认跳过；含 stdio、严格配置、预算、journal、SIGKILL/锁恢复、提交去重/队列取消/最终记录失败、晚到确认及 Redis 预览竞态 |
| 三库读取集成 | Node 25.9.0 / 24.21.0，DB_MCP_DOCKER_TESTS=1 node --test dist/tests/integration.test.js | 9/9，通过；只读权限、TLS、取消/扫描预算；Node 22.23.3 在前阶段亦通过 9/9，该读取逻辑未改变 |
| 三库写入集成 | Node 22.23.3 / 24.21.0，DB_MCP_DOCKER_TESTS=1 node --test dist/tests/write-integration.test.js | 8/8，通过；单目标事务/CAS、原生越权拒绝、schema/触发器/级联、响应丢失/未知源阻断、凭证轮换、真实 MCP、MySQL 唯一冲突回滚及锁等待取消 |
| 生产依赖 | npm audit --omit=dev --registry=https://registry.npmjs.org | 公开 advisory 扫描 0 项；不等于无未知漏洞或源码审计结论 |
| 产物 | node scripts/verify-artifact.mjs | 实际 tarball 77 文件 whitelist、相对 import graph、凭证样式检查、临时安装及安装后只读/写 profile --check；不发布 |
| Git 差异 | git diff --check / git diff --cached --check | 通过；保留已有未提交修复及 config_local.json 暂存删除 |

依赖版本由 package.json 和 lockfile 固定；dotenv 仅用于旧配置回归测试，属于 devDependency，不由 v2 入口加载。CI 已配置 Node 22/24 及读取/写入三库/产物检查；两个 Node 版本均已本地验证，**远程 CI 未执行**。Node 24 初次短 deadline 测试因并发 fsync 在发送前超时，不是重复提交；回归改为确认已发送后显式取消，仍严格验证 unknown/槽位保持/只执行一次，没有放宽安全断言。

## 隔离范围

数据库镜像：mysql:8.4.8、redis:7.4.7、mongo:7.0.31。各自独立容器，随机 127.0.0.1 端口、独立临时账号/密码和 CA，配置只指向本次测试实例；没有复用已有数据库/业务容器。测试 finally 清理本次容器、其匿名卷及临时目录，不删除 Docker 镜像缓存，不改生产数据。

### 真实三库覆盖

- MySQL：流式 prepared select、等值注入字符串仍为值、授权字段元数据、超大多字节项截断、read-only transaction、慢视图取消与 stream/连接清理；独立原生账号拒绝 INSERT/UPDATE/DELETE/ALTER 和越界表 SELECT。
- Redis：专用 ACL username、拒绝 SET/FLUSH/越界 GETRANGE；有界 base64 字符串片段；两个租户前缀扫描不外泄；原生 SCAN 确实会返回其他租户名称；单应用槽位及非 0 DB 的 AUTH/SELECT 初始化；1000 个无匹配 key 的稀疏扫描命中页数预算。
- MongoDB：集合级 find 自定义角色、服务器字段投影、超大文档项停止获取；原生拒绝写入和越界集合；固定单主机 URI。
- 三种驱动：有效 DNS 证书与可信 CA 正向连接；不可信 CA、错误 DNS 证书拒绝；Redis/MongoDB 无 IP SAN 拒绝，MySQL IP 配置在 schema 阶段拒绝。

### TLS 证据边界

错误 DNS 证书经过真实数据库 stop/start 后测试，重新解析随机映射端口并等待 TCP ready，避免将连接拒绝当作 TLS 通过。MySQL 驱动可能把 TLS alert 竞态呈现为 PROTOCOL_CONNECTION_LOST：测试先用**仅限一次性库**的非验证控制连接证明同账号/服务器能正常 SELECT 1，再证明严格适配器拒绝；生产实现没有这种 fallback。

MySQL/Redis 过期证书使用真实服务器。MongoDB 拒绝使用过期证书启动，因此其过期校验用受控 Node TLS endpoint 测试同一个 MongoDB 驱动连接路径；要求原生错误包含 certificate 相关证据，不发送 DB 认证。不能将这一条表述为“真实 MongoDB 服务器成功启动后拒绝了客户端”。MySQL 无池和自动重连，Redis 自动重连关闭，MongoDB 不做拓扑发现；完整副本集/SRV/热轮换不在该证据内。

## 实施中发现并修复的真实缺陷

1. Redis 默认 CLIENT SETINFO + AUTH 超过小内部队列：关闭不必需信息上报，为 AUTH/SELECT 留最小容量，不扩张 ACL。
2. MySQL 提前截断后的 command inactivity timer 触发迟到未处理异常：结果流使用 dispatcher 总期限，不重复留下该计时器；结果 stream 明确清理，迟到 teardown error 不传播成进程异常。
3. MySQL 仅销毁 socket 不等于完成 await/stream：connect/control wait 有取消边界，取消同时销毁结果 stream，真实慢视图验证容量最终释放。
4. node-redis 4.7.1 保留已完成命令的 abort listener，预算拒绝后取消污染队列：不向此版本传 driver signal，停止后续获取并保留真实在途额度；稀疏扫描失败后无测试结束异步异常。
5. 初始化与 shutdown 竞态可能留下后生成的适配器：单测证明关闭后不连接、创建出的适配器被关闭。
6. Redis 写预览如果先 STRLEN 再 GET，值可在两者之间扩容；新增失败测试证明旧路径调用无界 GET，现取值本身也为有界 GETRANGE，比较原始字节。固定 Lua 提交的长度检查与 GET 原子完成。
7. 晚到成功后旧 WRITE_OUTCOME_UNKNOWN code 可能残留，失败回归复现后修复；journal 已降级时也保留内存确认结果供 status/重复 commit 查询，明确标注非持久。未知 source 拒绝新的操作 ID，防止提示要求被新预览绕过。
8. 真实三库失败回归证明目标不存在未被正确区分，Redis 对不存在的覆盖还生成预览 ID；修复为 TARGET_NOT_FOUND，固定 Lua 提交也核对不存在/过期，数据库已确认回滚的拒绝为 WRITE_REJECTED。协议审计补时间、操作 ID 和直接影响数量，不记录请求正文。

## 受控写入 W 子集与恢复证据

- W01：生产 write profile/缺失 journal/隐藏写工具不开放；不完整复合键、NULL 键、越界对象/字段、主键/版本任意赋值、跨 source 提交和参数篡改被拒绝。MySQL 只支持完整 PRIMARY KEY（真实主键变更后拒绝），其他唯一索引不作为定位；MongoDB 只支持 `_id`，非唯一/partial/sparse 替代定位没有入口。无 bulk/upsert/任意 SQL/脚本。
- W02：真实 MySQL/MongoDB 版本推进、目标冲突和 no_change，单条 insert/delete；Redis 两个相同预期值并发只能一个成功，执行时原子值/PTTL 比较和 KEEPTTL。删除各自显式授权。MongoDB 的 no_change 比较在服务端，不拉回待覆盖的大字段。
- W03：MySQL 真实 ALTER/PRIMARY KEY 漂移、触发器、CASCADE/SET NULL 删除拒绝；可信 definer guard 可以观察写身份本身不可完整读取的元数据。MongoDB 真实 index 漂移、drop/recreate UUID 变化后拒绝。不宣称已覆盖全部复杂外键拓扑和数据库对象副作用。
- W04：受控 TCP 代理接收服务端的成功响应后丢弃，管理员读回证明三库已修改，但 MCP 为 unknown_outcome；重复 commit 同 ID 不新增命令，换 ID 的新预览也被 source unknown 阻断。MySQL/Redis 各丢 1 个确认，MongoDB 同一事务 commit 确认丢 2 次（锁定官方驱动重试一次），不重跑 DML。应用排队取消不迟到执行，有真实 MySQL 锁等待取消后不修改目标的复验；驱动/服务器所有故障时序不可能据此视为穷尽。
- W05/W06：journal 独占、容量、0600/0700、损坏拒绝、前置持久失败不提交、最终持久失败仍报告已确认 success + journalDegraded 并关闭新写入；真实 SIGKILL 留 crash lock，确认进程退出后仅删除测试锁并恢复，pending 为 unknown。晚到成功可以在同进程修正未知，磁盘恢复不猜测/不重放。未知不会普通轮转丢弃。MySQL 唯一约束错误确认回滚、零新增行，锁等待截止在 DML 前，连接丢弃后不迟到执行。
- 真实隔离凭证轮换：三个库更新专用读身份密码，新建旧秘密连接拒绝；已认证 Redis 会话仍可读，明确关闭旧 registry 后不能继续调用，重启加载新秘密可读取三库。测试不证明生产所有旧会话已经撤销，也未替管理员执行会话清理。
- W07 不适用：生产写入/可信审批未开放，schema 直接拒绝。模型 prepare/commit 不是人工审批，不能把这些测试视为生产授权。

写入测试使用额外独立容器；MongoDB 为单节点 rs0（带 keyFile/auth），不复用生产或既有副本集。代理和实例/journal 均在 finally 关闭/清理。崩溃/持久化测试的故障仅发生在 mkdtemp 私有目录；不是断电/介质损坏证明。

## 部署前仍需管理员验证

- 生产账户 effective grants/roles、视图定义/依赖、host 网络策略及秘密 mount 由管理员验证；--check 与本地角色模板不能替代生产权限证明。
- 可写对象的可信 metadata guard/DEFINER 完整可见性、全部写方维护版本与定位键不重用的业务协议由管理员确认；整数版本不能消除删除重建的 ABA，无法保证时关闭对应更新/删除，改用业务 generation token。Redis 值/TTL 条件验证当前状态，不是永久 key 身份或跨实例去重。
- 真实生产容量、长时间多 source 并发、公平性、网络故障/挂起、MongoDB 真实查询取消、Redis 挂起时的退出，以及跨平台部署仍需补充。当前有相关预算/取消单测，但不是全部真实故障矩阵。
- 已做隔离三库改密/旧连接关闭/新实例加载演练；真实生产凭证撤销、残留会话及远程 CI 仍需管理员验证。
- 扫描是产物路径/样式与测试 sentinel 检查，不是完整 Git 历史/所有秘密形态扫描；如历史存在真实凭证，应由管理员轮换和专项扫描，不把 ignore/删除提交当作撤销泄露。
- 响应/获取有界，不承诺任意大行/文档/SCAN 回复的硬 RSS 上限；stderr audit 可丢，write journal 独立持久、满容量失败关闭。文件系统断电/NFS/跨平台 durability、长期容量与并发负载尚未验证。
- 开发/测试受控写入已完成支持子集；生产写入/独立可信审批、DDL/批量、其他唯一索引定位、任意脚本/SQL、Keychain/云短凭证、热轮换/自动补偿仍不支持，不是可偷偷打开的兼容功能。

## 复现

```bash
npm ci --ignore-scripts
npm test
npm run test:integration
npm run verify:artifact
npm audit --omit=dev --registry=https://registry.npmjs.org
```

测试只使用自己的临时数据源。Docker/OpenSSL 不可用时集成未验证，不能用单测代替；未通过的场景不删除或弱化断言。部署或发布前按上述边界补证据。
