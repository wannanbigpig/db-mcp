# SSH 通道 / SSH tunnels

## 使用方式

MySQL、Redis、MongoDB 的每个 source 都可以配置可选的 `ssh`。路径为 `db-mcp → SSH 服务器 → 固定数据库`。本机必须能连接 SSH 服务器，该服务器必须能解析和访问数据库地址，并允许 TCP 转发；如果 SSH 服务器本身也只能从 VPN 访问，仍需先连接 VPN。

`npm run setup` 的生产 TLS 流程提供「SSH 通道」。密钥方式只需要一个地址。密码方式额外隐藏输入密码，保存在权限为 0600 的文件中。向导和 `--check` 在离线状态下校验配置、应用管理的秘密引用和 CA 文件。

手工配置时，把 `ssh` 添加到需要走跳板机的数据源。密钥方式可填写 IP、域名或 `~/.ssh/config` 里的 `Host` 别名。见 [只读示例](../examples/config.ssh.example.json)。

```json
{ "ssh": { "host": "reporting-bastion" } }
```

需要密码登录时添加 `passwordRef`。该引用可以用 `file:/absolute/path` 或 `env:NAME`，引用的文件需由当前用户拥有、权限为 0600 或更严。

```json
{ "ssh": { "host": "reporting-bastion", "passwordRef": "file:/absolute/path/ssh-password" } }
```

简化方式依赖 macOS/Linux 的系统 OpenSSH，沿用本机 SSH 配置里的 `HostName`、`User`、`Port`、`IdentityFile` 和可用的 SSH agent。带口令的密钥可先交给 agent，MCP 客户端启动的进程需要能访问该 agent。密码方式使用 SSH password 认证。需要键盘交互或 MFA 的登录流程无法在后台完成。

## 跳板机信任与数据库 TLS

简化方式要求跳板机已在本机 SSH 的已知主机配置中受到信任。第一次使用时，可以在终端运行 `ssh reporting-bastion`，核对管理员提供的主机密钥后再确认。未知或不匹配的主机密钥会返回 `SSH_HOST_KEY_MISMATCH`。

已有的显式 SSH 配置继续使用 `host`、`username`、`hostKeySha256` 和 `auth`，`port` 缺省为 22。显式方式也适用于 Windows，使用环境变量引用。密码用 `auth.method: "password"` 和 `auth.passwordRef`，私钥用 `auth.method: "private_key"` 和 `auth.privateKeyRef`，可另加 `auth.passphraseRef`。

SSH 保护本机至 SSH 服务器的链路。数据源选用 `tls.mode: verify_identity` 时，会额外校验原数据库地址的证书及主机身份。只读数据源选用 `disabled` 时，SSH 服务器至数据库这段链路使用明文。MongoDB 使用单主机 `directConnection`。

## 生命周期与权限

- 每 source 一条独立 SSH 会话，建立通道后再初始化数据库。注册初始化总期限仍为 `budgets.connectTimeoutMs`，SSH 本身也有同值期限。
- 内部监听只绑定 `127.0.0.1` 随机端口，固定转发到该数据库，模型不能指定目标。转发连接数沿用数据库连接预算；SSH 会话另占一个网络连接。
- 转发连接达到额度时会拒绝或限时等待。使用显式指纹配置时，开通超时或本地连接提前关闭会使整个 ssh2 会话失效，防止累积未完成的申请。
- 已运行的 SSH 数据源在临时断线后显示 `reconnecting`。每个数据源一次只尝试重连，间隔约从半秒逐步增加至 30 秒以内，旧连接关闭后再建新会话。连接和数据库探测通过后恢复 `ready`。其他数据源可以继续工作。
- 保活每 5 秒发起一次探测。本机环回实测，空闲会话在双向静默丢包时约 20 秒发现断线。查询、新通道建立各自仍有单独的超时。
- 认证、主机密钥、证书校验或配置错误会停在 `unavailable`，`list_sources` 提供脱敏错误码。重连沿用启动时解析的数据库目标、秘密引用值和 CA。简化方式在建立新 SSH 会话时重新读取本机 SSH 配置。
- `required: true` 数据源首次初始化失败会停止启动。设置 `required: false` 的 SSH 数据源在前台启动探测结束后从后台发起首次连接，MCP 客户端无需等待。后台首连期间显示 `reconnecting`，临时故障继续后台重连。可选直连源仍在启动时完成首次探测。
- 断线会取消旧连接上的排队请求并使旧预览失效。登记新预览时，同一 journal 快照将旧预览标记为 `not_started / PREVIEW_EXPIRED` 并释放预览额度。已发送且未得到明确结果的写入仍标记 `unknown_outcome`，同一操作 ID 只返回已有结果。可以用 `operation_status` 查状态，未知结果未解决前该数据源仍阻断新增写入。
- 退出、初始化失败、超时及迟到回调均清理本次监听、socket 和 SSH 会话。`sourceId`、范围、写入授权和审计脱敏规则保持原契约。
- SSH 不是本机进程间的隔离边界，仍需数据库原生最小权限账号。SSH 账号宜仅允许到所需数据库的转发。

## English

Each MySQL, Redis or MongoDB source accepts an optional `ssh` object. The SSH server must be able to reach the fixed database and allow TCP forwarding. On macOS and Linux, set `ssh.host` to an IP, hostname or OpenSSH alias. Add `ssh.passwordRef` for SSH password authentication. The wizard prompts for the password only when requested and saves it as a private file. Setup and `--check` remain offline. See the [read-only example](../examples/config.ssh.example.json).

The short form uses OpenSSH settings for the remote user, port, identity files, SSH agent and known hosts. Verify the SSH host key before first use. Existing explicit configurations continue to use `username`, `hostKeySha256` and `auth`. Windows can use this form with env references.

Keep the original database endpoint in its source or secret URI. With `verify_identity`, database TLS verifies the original identity and CA across the tunnel. With `disabled`, the link from the SSH server to the database is plaintext. MongoDB remains a single fixed direct connection.

Each source owns one SSH session and a bounded, random, loopback-only listener to its fixed database target. In the pinned-key form, pending and closing channels retain capacity, and a bounded local wait absorbs delayed closure.

A running SSH source recovers from transient failures with one attempt at a time and jittered exponential backoff up to 30 seconds. It reports `reconnecting` until the database probe passes. SSH keepalives run every five seconds and an idle blackhole was detected in about 20 seconds in a loopback test. Authentication, host-key, certificate and configuration failures stay `unavailable` with a sanitized error code. Reconnection uses the startup snapshot of the target, credentials and CA. Restart to load changes. An initial failure on a required source prevents startup. After foreground startup probes finish, an SSH source with `required: false` begins its first connection in the background with status `reconnecting`. The MCP handshake proceeds independently. Optional direct sources still complete their first probe during startup.

Connection loss cancels old queued requests and expires old previews. When registering a new preview, the journal records the expired previews as `not_started / PREVIEW_EXPIRED` and frees their preview slots in the same snapshot. Sent writes without a reliable acknowledgement remain `unknown_outcome`. A repeated operation ID only returns the recorded status, and an unresolved outcome still prevents new writes to that source.

In the pinned-key form, an open timeout or observable local close before completion invalidates the SSH session because ssh2 cannot cancel an individual pending open.
