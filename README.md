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

db-mcp 支持两种配置方式：**配置文件** 和 **环境变量**。配置的连接会在服务器启动时自动初始化。

#### 方式一：使用配置文件（推荐）

1. 复制示例配置文件：
```bash
cp config.json.example config.json
```

2. 编辑 `config.json`，填入你的数据库连接信息：
```json
{
  "databases": {
    "mysql": {
      "host": "localhost",
      "port": 3306,
      "user": "root",
      "password": "your_password",
      "database": "mydb",
      "pool": {
        "min": 2,
        "max": 10,
        "idleTimeout": 60000
      }
    },
    "redis": {
      "host": "localhost",
      "port": 6379,
      "password": "your_password",
      "db": 0
    },
    "mongodb": {
      "url": "mongodb://localhost:27017",
      "database": "mydb"
    }
  },
  "security": {
    "mode": "read_only"
  }
}
```

3. 在 Cursor 配置中指定配置文件路径（可选，默认查找项目根目录的 `config.json`）：
```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/path/to/db-mcp/dist/index.js"],
      "env": {
        "DB_MCP_CONFIG_PATH": "/path/to/config.json"
      }
    }
  }
}
```

#### 方式二：使用环境变量

在 Cursor 配置中直接设置环境变量：

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/path/to/db-mcp/dist/index.js"],
      "env": {
        "MYSQL_HOST": "localhost",
        "MYSQL_PORT": "3306",
        "MYSQL_USER": "root",
        "MYSQL_PASSWORD": "your_password",
        "MYSQL_DATABASE": "mydb",
        "MYSQL_POOL_MIN": "2",
        "MYSQL_POOL_MAX": "10",
        "MYSQL_POOL_IDLE_TIMEOUT": "60000",
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6379",
        "REDIS_PASSWORD": "your_password",
        "REDIS_DB": "0",
        "MONGODB_URL": "mongodb://localhost:27017",
        "MONGODB_DATABASE": "mydb",
        "DB_MCP_SECURITY_MODE": "read_only"
      }
    }
  }
}
```

**注意**：
- 配置文件和环境变量可以同时使用，环境变量的优先级更高
- 如果配置了数据库连接，服务器启动时会自动连接
- 预配置的连接可以在工具中直接使用，无需再次调用 `*_connect`

### 安全模式配置

通过环境变量 `DB_MCP_SECURITY_MODE` 可以设置默认安全模式，也可以通过工具动态切换：

- **read_only** (只读模式，默认): 只允许查询操作，禁止所有修改操作
  - MySQL: 只允许 SELECT、SHOW、DESCRIBE、EXPLAIN
  - Redis: 只允许 GET、KEYS、EXISTS、HGET、HGETALL
  - MongoDB: 只允许 FIND、FIND_ONE、COUNT、LIST_COLLECTIONS

- **restricted** (限制模式): 允许查询和部分修改操作，禁止危险操作
  - MySQL: 允许 SELECT、INSERT、UPDATE，禁止 DROP、TRUNCATE、ALTER TABLE，DELETE 必须包含 WHERE
  - Redis: 允许所有操作（GET、SET、DEL 等）
  - MongoDB: 允许 FIND、INSERT、UPDATE，禁止 DELETE

- **full_access** (完全开发模式): 允许所有操作，无任何限制
  - 所有数据库的所有操作都允许执行

**注意**: 默认模式为 `read_only`，建议在生产环境中使用只读模式或限制模式。

### 开发模式

```bash
npm run dev
```

## 数据库连接配置

db-mcp 支持两种连接方式：**预配置连接**（推荐）和**动态连接**。

### 连接方式

#### 方式一：预配置连接（推荐）

通过配置文件或环境变量预先配置数据库连接，服务器启动时自动连接。适合生产环境和频繁使用的场景。

**优势：**
- 启动即用，无需每次手动连接
- 支持 MySQL 连接池，提高性能
- 配置集中管理，便于维护
- 减少连接开销

#### 方式二：动态连接

通过工具调用动态建立连接，适合临时使用或测试场景。

**使用流程：**
1. 使用 `*_connect` 工具建立连接
2. 执行查询和操作
3. 使用 `*_disconnect` 工具断开连接（可选，会话结束时会自动断开）

**注意：** 如果已通过预配置连接，可以直接使用查询工具，无需再次调用 `*_connect`。

### MySQL 连接配置

使用 `mysql_connect` 工具连接 MySQL 数据库，**支持连接池**。

**必需参数:**
- `host`: MySQL 服务器地址（如：`localhost`、`127.0.0.1`、`192.168.1.100`）
- `user`: MySQL 用户名（如：`root`、`admin`）
- `password`: MySQL 密码

**可选参数:**
- `port`: MySQL 端口号，默认为 `3306`
- `database`: 要连接的数据库名称（可选，可在后续查询中指定）
- `usePool`: 是否使用连接池（布尔值，默认 `false`）
- `pool`: 连接池配置对象
  - `min`: 最小连接数，默认 `2`
  - `max`: 最大连接数，默认 `10`
  - `idleTimeout`: 空闲连接超时时间（毫秒），默认 `60000`（60秒）

**普通连接示例:**
```json
{
  "host": "localhost",
  "port": 3306,
  "user": "root",
  "password": "your_password",
  "database": "mydb"
}
```

**使用连接池的连接示例:**
```json
{
  "host": "localhost",
  "port": 3306,
  "user": "root",
  "password": "your_password",
  "database": "mydb",
  "usePool": true,
  "pool": {
    "min": 2,
    "max": 10,
    "idleTimeout": 60000
  }
}
```

**连接池的优势:**
- 提高并发性能：多个查询可以复用连接
- 减少连接开销：避免频繁创建和销毁连接
- 自动管理：连接池自动管理连接的创建、复用和回收
- 适合高并发场景：生产环境推荐使用连接池

**带端口的远程连接:**
```json
{
  "host": "192.168.1.100",
  "port": 3307,
  "user": "admin",
  "password": "secure_password",
  "database": "production_db",
  "usePool": true,
  "pool": {
    "max": 20
  }
}
```

### Redis 连接配置

使用 `redis_connect` 工具连接 Redis 数据库：

**方式一：使用主机和端口（推荐）**

**必需参数:**
- `host`: Redis 服务器地址

**可选参数:**
- `port`: Redis 端口号，默认为 `6379`
- `password`: Redis 密码（如果设置了密码）
- `db`: Redis 数据库编号，默认为 `0`（Redis 支持 0-15 共 16 个数据库）

**连接示例:**
```json
{
  "host": "localhost",
  "port": 6379,
  "password": "redis_password",
  "db": 0
}
```

**方式二：使用连接 URL**

**必需参数:**
- `url`: Redis 连接 URL

**连接示例:**
```json
{
  "url": "redis://:password@localhost:6379/0"
}
```

**无密码连接:**
```json
{
  "host": "localhost",
  "port": 6379
}
```

### MongoDB 连接配置

使用 `mongodb_connect` 工具连接 MongoDB 数据库：

**必需参数:**
- `url`: MongoDB 连接 URL

**可选参数:**
- `database`: 数据库名称（如果 URL 中未指定）

**连接 URL 格式:**
- 本地连接：`mongodb://localhost:27017`
- 带认证：`mongodb://username:password@localhost:27017`
- 指定数据库：`mongodb://localhost:27017/mydb`
- 副本集：`mongodb://host1:27017,host2:27017/dbname?replicaSet=rs0`

**连接示例:**

**本地连接:**
```json
{
  "url": "mongodb://localhost:27017",
  "database": "mydb"
}
```

**带认证的连接:**
```json
{
  "url": "mongodb://admin:password@localhost:27017",
  "database": "mydb"
}
```

**URL 中已包含数据库名:**
```json
{
  "url": "mongodb://localhost:27017/mydb"
}
```

**远程连接:**
```json
{
  "url": "mongodb://user:pass@192.168.1.100:27017/production?authSource=admin"
}
```

### 连接状态管理

- **连接是会话级别的**：每次工具调用时建立连接，会话结束后连接会自动关闭
- **同一会话中可以复用连接**：连接后可以执行多次查询操作
- **手动断开连接**：使用 `*_disconnect` 工具可以主动断开连接
- **连接错误处理**：如果连接失败，会返回详细的错误信息

### 安全建议

1. **生产环境**：
   - 使用只读模式或限制模式
   - 使用强密码
   - 限制数据库用户权限
   - 使用 SSL/TLS 连接（如果数据库支持）

2. **开发环境**：
   - 可以使用完全开发模式
   - 建议使用本地数据库或测试数据库

3. **密码安全**：
   - 不要在代码中硬编码密码
   - 使用环境变量或密钥管理服务
   - 定期更换密码

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
执行 MySQL SQL 查询。

**参数:**
- `sql` (必需): 要执行的 SQL 语句
- `params` (可选): SQL 参数数组

**示例:**
```json
{
  "sql": "SELECT * FROM users WHERE id = ?",
  "params": [1]
}
```

#### `mysql_disconnect`
断开 MySQL 数据库连接。

#### `mysql_pool_status`
获取 MySQL 连接池状态（仅在使用了连接池时有效）。

**参数:** 无

**返回:** 连接池状态信息（总连接数、活跃连接数、空闲连接数）

### Redis 工具

#### `redis_connect`
连接到 Redis 数据库。

**参数:**
- `host` (必需): Redis 主机地址
- `port` (可选): Redis 端口，默认 6379
- `password` (可选): Redis 密码
- `db` (可选): Redis 数据库编号，默认 0
- `url` (可选): Redis 连接 URL（如果提供则忽略其他参数）

#### `redis_get`
从 Redis 获取键的值。

**参数:**
- `key` (必需): Redis 键名

#### `redis_set`
设置 Redis 键的值。

**参数:**
- `key` (必需): Redis 键名
- `value` (必需): 要设置的值
- `ttl` (可选): 过期时间（秒）

#### `redis_keys`
查找匹配模式的 Redis 键。

**参数:**
- `pattern` (必需): 键的模式，例如 "user:*"

#### `redis_del`
删除 Redis 键。

**参数:**
- `key` (必需): 要删除的键名

#### `redis_hget`
获取 Redis 哈希字段的值。

**参数:**
- `key` (必需): 哈希键名
- `field` (必需): 字段名

#### `redis_hgetall`
获取 Redis 哈希的所有字段和值。

**参数:**
- `key` (必需): 哈希键名

#### `redis_disconnect`
断开 Redis 数据库连接。

### MongoDB 工具

#### `mongodb_connect`
连接到 MongoDB 数据库。

**参数:**
- `url` (必需): MongoDB 连接 URL，例如 `mongodb://localhost:27017`
- `database` (可选): 数据库名称（可从 URL 中提取）

#### `mongodb_find`
在 MongoDB 集合中查找文档。

**参数:**
- `collection` (必需): 集合名称
- `filter` (可选): 查询过滤器（JSON 对象）
- `limit` (可选): 返回文档数量限制
- `skip` (可选): 跳过的文档数量
- `sort` (可选): 排序规则

**示例:**
```json
{
  "collection": "users",
  "filter": { "age": { "$gte": 18 } },
  "limit": 10,
  "sort": { "name": 1 }
}
```

#### `mongodb_find_one`
在 MongoDB 集合中查找单个文档。

**参数:**
- `collection` (必需): 集合名称
- `filter` (可选): 查询过滤器（JSON 对象）

#### `mongodb_insert_one`
向 MongoDB 集合插入单个文档。

**参数:**
- `collection` (必需): 集合名称
- `document` (必需): 要插入的文档（JSON 对象）

#### `mongodb_insert_many`
向 MongoDB 集合插入多个文档。

**参数:**
- `collection` (必需): 集合名称
- `documents` (必需): 要插入的文档数组

#### `mongodb_update_one`
更新 MongoDB 集合中的单个文档。

**参数:**
- `collection` (必需): 集合名称
- `filter` (必需): 查询过滤器（JSON 对象）
- `update` (必需): 更新操作（JSON 对象，使用 $set 等操作符）

**示例:**
```json
{
  "collection": "users",
  "filter": { "id": 1 },
  "update": { "$set": { "name": "新名称" } }
}
```

#### `mongodb_delete_one`
删除 MongoDB 集合中的单个文档。

**参数:**
- `collection` (必需): 集合名称
- `filter` (必需): 查询过滤器（JSON 对象）

#### `mongodb_count`
统计 MongoDB 集合中匹配的文档数量。

**参数:**
- `collection` (必需): 集合名称
- `filter` (可选): 查询过滤器（JSON 对象）

#### `mongodb_list_collections`
列出 MongoDB 数据库中的所有集合。

#### `mongodb_disconnect`
断开 MongoDB 数据库连接。

### 安全配置工具

#### `set_security_mode`
设置安全模式。

**参数:**
- `mode` (必需): 安全模式，可选值：
  - `read_only`: 只读模式
  - `restricted`: 限制模式
  - `full_access`: 完全开发模式

**示例:**
```json
{
  "mode": "restricted"
}
```

#### `get_security_mode`
获取当前安全模式。

**参数:** 无

## 使用示例

以下示例展示了如何通过工具调用连接和操作数据库。

### MySQL 完整示例

**步骤 1: 连接数据库**
使用 `mysql_connect` 工具：
```json
{
  "host": "localhost",
  "port": 3306,
  "user": "root",
  "password": "your_password",
  "database": "mydb"
}
```

**步骤 2: 执行查询**
使用 `mysql_query` 工具：
```json
{
  "sql": "SELECT * FROM users LIMIT 10"
}
```

**步骤 3: 参数化查询（防止 SQL 注入）**
```json
{
  "sql": "SELECT * FROM users WHERE id = ? AND status = ?",
  "params": [1, "active"]
}
```

**步骤 4: 断开连接（可选）**
使用 `mysql_disconnect` 工具（无参数）

### Redis 完整示例

**步骤 1: 连接数据库**
使用 `redis_connect` 工具：
```json
{
  "host": "localhost",
  "port": 6379,
  "password": "your_password",
  "db": 0
}
```

**步骤 2: 设置键值**
使用 `redis_set` 工具：
```json
{
  "key": "user:1",
  "value": "John Doe",
  "ttl": 3600
}
```

**步骤 3: 获取键值**
使用 `redis_get` 工具：
```json
{
  "key": "user:1"
}
```

**步骤 4: 查找匹配的键**
使用 `redis_keys` 工具：
```json
{
  "pattern": "user:*"
}
```

**步骤 5: 断开连接（可选）**
使用 `redis_disconnect` 工具（无参数）

### MongoDB 完整示例

**步骤 1: 连接数据库**
使用 `mongodb_connect` 工具：
```json
{
  "url": "mongodb://localhost:27017",
  "database": "mydb"
}
```

**步骤 2: 查找文档**
使用 `mongodb_find` 工具：
```json
{
  "collection": "users",
  "filter": { "age": { "$gte": 18 } },
  "limit": 10,
  "sort": { "name": 1 }
}
```

**步骤 3: 插入文档**
使用 `mongodb_insert_one` 工具：
```json
{
  "collection": "users",
  "document": {
    "name": "John Doe",
    "age": 30,
    "email": "john@example.com"
  }
}
```

**步骤 4: 更新文档**
使用 `mongodb_update_one` 工具：
```json
{
  "collection": "users",
  "filter": { "email": "john@example.com" },
  "update": { "$set": { "age": 31 } }
}
```

**步骤 5: 断开连接（可选）**
使用 `mongodb_disconnect` 工具（无参数）

### 安全模式切换示例

**查看当前安全模式:**
使用 `get_security_mode` 工具（无参数）

**切换安全模式:**
使用 `set_security_mode` 工具：
```json
{
  "mode": "restricted"
}
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

