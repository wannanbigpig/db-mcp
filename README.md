# db-mcp

一个 Model Context Protocol (MCP) 服务器，用于连接和查询 MySQL、Redis 和 MongoDB 数据库。

## 使用效果截图

### Redis 查询示例

![Redis 查询示例](screenshots/redis-query-example.png)

### MySQL 统计查询示例

![MySQL 统计查询示例](screenshots/mysql-statistics-example.png)

### MongoDB 统计查询示例

![MongoDB 统计查询示例](screenshots/mongodb-count-example.png)


## 功能特性

- ✅ **MySQL 支持**: 连接、查询、执行 SQL 语句
- ✅ **Redis 支持**: 键值操作、哈希操作、模式匹配
- ✅ **MongoDB 支持**: 文档查询、插入、更新、删除
- 🔒 **安全模式**: 支持只读模式、限制模式、完全开发模式三种安全级别

## 安装

### 前置要求

- Node.js >= 18.0.0
- npm >= 9.0.0 或 yarn >= 1.22.0

### 安装步骤

```bash
# 克隆仓库
git clone git@github_pig:wannanbigpig/db-mcp.git
cd db-mcp

# 安装依赖
npm install

# 构建项目
npm run build
```

### 验证安装

构建完成后，可以运行以下命令验证安装：

```bash
# 开发模式运行（测试）
npm run dev

# 或直接运行构建后的文件
node dist/index.js
```

如果看到 "db-mcp 服务器已启动" 的提示，说明安装成功。

### 配置数据库连接（可选）

安装完成后，可以选择配置数据库连接：

1. 复制示例配置文件：
```bash
cp config.json.example config.json
```

2. 编辑 `config.json`，填入你的数据库连接信息

详细配置说明请参考[数据库连接配置](#数据库连接配置)部分。

### 故障排查

如果安装或运行遇到问题：

1. **检查 Node.js 版本**：
```bash
node --version  # 应该 >= 18.0.0
```

2. **清理并重新安装**：
```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```

3. **检查构建输出**：
```bash
ls -la dist/  # 应该看到编译后的 .js 文件
```

## 使用方法

db-mcp 是一个标准的 MCP (Model Context Protocol) 服务器，可以在任何支持 MCP 的客户端中使用，包括但不限于：

- **Cursor** - AI 代码编辑器
- **Claude Desktop** - Anthropic 的 Claude 桌面应用
- **其他支持 MCP 的客户端**

### 配置 MCP 服务器

在你的 MCP 客户端配置文件中添加 db-mcp 服务器配置。配置格式因客户端而异：

#### Cursor 配置示例

在 Cursor 的设置文件（通常是 `~/.cursor/mcp.json` 或 Cursor 设置中的 MCP 配置）中添加：

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_MCP_SECURITY_MODE": "read_only",
        "DB_MCP_CONFIG_PATH": "/path/to/config.json"
      }
    }
  }
}
```

#### Claude Desktop 配置示例

在 Claude Desktop 的配置文件（通常是 `~/Library/Application Support/Claude/claude_desktop_config.json`）中添加：

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_MCP_SECURITY_MODE": "read_only"
      }
    }
  }
}
```

**注意**：请将 `/path/to/db-mcp/dist/index.js` 替换为你的实际安装路径。

### 预配置数据库连接

支持通过 `config.json` 或环境变量预配置数据库连接。复制 `config.json.example` 为 `config.json` 并编辑即可。

环境变量示例：`MYSQL_HOST`、`MYSQL_USER`、`MYSQL_PASSWORD`、`REDIS_HOST`、`MONGODB_URL` 等。

### 运行时保护参数

除了数据库连接信息，还支持通过环境变量配置运行时保护策略：

- `DB_MCP_OPERATION_TIMEOUT_MS`: 单次工具调用超时时间，默认 `30000`
- `DB_MCP_MAX_RESULT_ITEMS`: 响应中数组结果最多保留多少项，默认 `200`
- `DB_MCP_MAX_RESPONSE_BYTES`: 响应文本最大字节数，默认 `65536`
- `DB_MCP_DEFAULT_MONGO_LIMIT`: `mongodb_find` 默认 `limit`，默认 `100`
- `DB_MCP_MAX_MONGO_LIMIT`: `mongodb_find` 允许的最大 `limit`，默认 `500`
- `DB_MCP_MYSQL_SELECT_LIMIT`: MySQL 会话级 `SQL_SELECT_LIMIT`，默认 `500`
- `DB_MCP_MAX_CONCURRENT_MYSQL`: MySQL 工具最大并发数，默认 `4`
- `DB_MCP_MAX_CONCURRENT_REDIS`: Redis 工具最大并发数，默认 `16`
- `DB_MCP_MAX_CONCURRENT_MONGO`: MongoDB 工具最大并发数，默认 `6`

这些限制会帮助服务避免被大结果集、慢查询或突发并发拖垮。

### 安全模式

通过 `DB_MCP_SECURITY_MODE` 环境变量或 `set_security_mode` 工具设置：

- **read_only** (默认): 只允许查询操作
- **restricted**: 允许查询和部分修改，禁止危险操作（DROP、TRUNCATE、ALTER TABLE 等）
- **full_access**: 允许所有操作，包括表结构变更

### 开发模式

```bash
npm run dev
```

## 数据库连接配置

### 预配置连接（推荐）

通过 `config.json` 或环境变量预配置数据库连接，服务器启动时自动连接。

**MySQL 配置示例:**
```json
{
  "databases": {
    "mysql": {
      "host": "localhost",
      "port": 3306,
      "user": "root",
      "password": "your_password",
      "database": "mydb",
      "pool": { "min": 2, "max": 10, "idleTimeout": 60000 }
    }
  }
}
```

**Redis 配置示例:**
```json
{
  "databases": {
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": "your_password",
      "db": 0
    }
  }
}
```

**MongoDB 配置示例:**
```json
{
  "databases": {
    "mongodb": {
      "url": "mongodb://localhost:27017",
      "database": "mydb"
    }
  }
}
```

### 动态连接

也可以通过工具动态连接，使用 `*_connect` 工具建立连接，`*_disconnect` 断开连接。

如果你担心凭证暴露给调用工具的 AI，建议优先使用预配置连接，不要把数据库密码作为 `*_connect` 的工具参数传给模型。

## 可用工具

### MySQL 工具

#### `mysql_connect`
连接到 MySQL 数据库（支持连接池）。如果已通过预配置连接，此工具会重新连接。

**参数:**
- `host` (必需): MySQL 主机地址
- `port` (可选): MySQL 端口，默认 3306
- `user` (必需): MySQL 用户名
- `password` (必需): MySQL 密码
- `database` (可选): 数据库名称
- `usePool` (可选): 是否使用连接池，默认 `false`
- `pool` (可选): 连接池配置
  - `min`: 最小连接数，默认 2
  - `max`: 最大连接数，默认 10
  - `idleTimeout`: 空闲超时时间（毫秒），默认 60000

#### `mysql_query`
执行 MySQL SQL 语句（支持所有 SQL 操作，包括表结构变更）。

**参数:**
- `sql` (必需): SQL 语句
- `params` (可选): SQL 参数数组

**示例:**
```json
{ "sql": "SELECT * FROM users WHERE id = ?", "params": [1] }
{ "sql": "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100))" }
{ "sql": "ALTER TABLE users ADD COLUMN age INT" }
```

#### `mysql_insert` / `mysql_update` / `mysql_delete`
更友好的 API，自动构建 SQL，使用参数化查询防止 SQL 注入。

**参数:**
- `table` (必需): 表名
- `data` (insert/update 必需): 数据对象
- `where` (update/delete 必需): WHERE 条件对象

**示例:**
```json
{ "table": "users", "data": { "name": "John", "email": "john@example.com" } }
{ "table": "users", "data": { "name": "Jane" }, "where": { "id": 1 } }
{ "table": "users", "where": { "id": 1 } }
```

#### `mysql_disconnect`
断开 MySQL 数据库连接。

#### `mysql_pool_status`
获取 MySQL 连接池状态（仅在使用了连接池时有效）。

**参数:** 无

**返回:** 连接池状态信息，包括：
- 总连接数
- 活跃连接数
- 空闲连接数
- 排队请求数 `queuedRequests`
- 配置的最大连接数 `configuredMaxConnections`
- 当前会话级 `SQL_SELECT_LIMIT`

### Redis 工具

- `redis_connect`: 连接 Redis（参数: `host`, `port`, `password`, `db`, `url`）
- `redis_get`: 获取键值（参数: `key`）
- `redis_set`: 设置键值（参数: `key`, `value`, `ttl`）
- `redis_keys`: 使用 `SCAN` 查找匹配的键，避免 `KEYS` 阻塞实例（参数: `pattern`, `count`, `limit`）
- `redis_del`: 删除键（参数: `key`）
- `redis_hget`: 获取哈希字段（参数: `key`, `field`）
- `redis_hgetall`: 获取所有哈希字段（参数: `key`）
- `redis_disconnect`: 断开连接

### MongoDB 工具

- `mongodb_connect`: 连接 MongoDB（参数: `url`, `database`）
- `mongodb_find`: 查找文档（参数: `collection`, `filter`, `limit`, `skip`, `sort`）
  默认会应用 `limit`，并且 `limit` 会被限制在运行时配置允许的最大值内
- `mongodb_find_one`: 查找单个文档（参数: `collection`, `filter`）
- `mongodb_insert_one`: 插入单个文档（参数: `collection`, `document`）
- `mongodb_insert_many`: 插入多个文档（参数: `collection`, `documents`）
- `mongodb_update_one`: 更新文档（参数: `collection`, `filter`, `update`）
- `mongodb_delete_one`: 删除文档（参数: `collection`, `filter`）
- `mongodb_count`: 统计文档数量（参数: `collection`, `filter`）
- `mongodb_list_collections`: 列出所有集合
- `mongodb_disconnect`: 断开连接

### 安全配置工具

- `set_security_mode`: 设置安全模式（参数: `mode` - `read_only`/`restricted`/`full_access`）
- `get_security_mode`: 获取当前安全模式
- `server_runtime_status`: 获取服务运行时状态，包括超时、响应限制、并发队列、连接状态和 MySQL 连接池状态

## 运行时观测

可以通过 `server_runtime_status` 工具查看当前服务状态，无需参数。

返回内容包括：

- 当前安全模式
- 操作超时配置
- 响应裁剪限制
- MySQL `SQL_SELECT_LIMIT`
- Mongo 默认/最大 `limit`
- MySQL、Redis、MongoDB 的 limiter 状态
  - `active`: 当前执行中的请求数
  - `queued`: 当前排队中的请求数
  - `maxConcurrent`: 最大并发数
- 当前数据库连接状态
- MySQL 连接池状态

这个工具适合用来排查：

- 为什么查询被截断
- 为什么请求在排队
- 为什么 MySQL 池被打满
- 当前服务的保护阈值是多少

## 使用示例

### MySQL
```json
// 连接
{ "host": "localhost", "user": "root", "password": "pass", "database": "mydb" }

// 查询
{ "sql": "SELECT * FROM users WHERE id = ?", "params": [1] }

// 插入
{ "table": "users", "data": { "name": "John", "email": "john@example.com" } }
```

### Redis
```json
// 连接
{ "host": "localhost", "port": 6379, "db": 0 }

// 操作
{ "key": "user:1", "value": "John Doe", "ttl": 3600 }
{ "key": "user:1" }
{ "pattern": "user:*", "count": 100, "limit": 200 }
```

### MongoDB
```json
// 连接
{ "url": "mongodb://localhost:27017", "database": "mydb" }

// 操作
{ "collection": "users", "filter": { "age": { "$gte": 18 } }, "limit": 10 }
{ "collection": "users", "document": { "name": "John", "age": 30 } }
```

### 运行时状态
```json
{}
```

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 开发模式（使用 tsx）
npm run dev

# 监听模式
npm run watch
```

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
