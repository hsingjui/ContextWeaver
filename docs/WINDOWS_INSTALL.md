# Windows 安装指南

适用于无 Visual Studio Build Tools 的 Windows 环境。

## 快速配置（3 步）

### 步骤 1：安装依赖

```bash
npm install --ignore-scripts
```

### 步骤 2：配置预编译文件

下载 2 个必需文件并复制到对应目录：

| 包 | 下载地址 | 目标位置 |
|---|---|---|
| **better-sqlite3** | [ Releases](https://github.com/WiseLibs/better-sqlite3/releases) | `node_modules/better-sqlite3/build/Release/better_sqlite3.node` |
| **tree-sitter** | [ Releases](https://github.com/tree-sitter/node-tree-sitter/releases) | `node_modules/tree-sitter/build/Release/tree_sitter_runtime_binding.node` |

**复制命令：**
```bash
# 创建目录并复制文件
mkdir -p node_modules/better-sqlite3/build/Release
mkdir -p node_modules/tree-sitter/build/Release

# 复制（重命名 tree-sitter 文件）
cp /path/to/better_sqlite3.node node_modules/better-sqlite3/build/Release/
cp /path/to/tree-sitter-win32-x64.node node_modules/tree-sitter/build/Release/tree_sitter_runtime_binding.node
```

### 步骤 3：构建

```bash
npm run build
npm link  # 可选：创建全局链接
```

✅ 完成！

---

## 可选：配置语法包

根据项目需要配置对应语言的语法包：

### 语法包清单

| 语言 | 常见文件名 | 目标目录 |
|---|---|---|
| TypeScript | `typescript.node` | `node_modules/tree-sitter-typescript/build/Release/` |
| JavaScript | `javascript.node` | `node_modules/tree-sitter-javascript/build/Release/` |
| Python | `tree_sitter_python_binding.node` | `node_modules/tree-sitter-python/build/Release/` |
| Go | `parser.node` 或 `go.node` | `node_modules/tree-sitter-go/build/Release/` |
| Java | `java.node` | `node_modules/tree-sitter-java/build/Release/` |
| C++ | `cpp.node` | `node_modules/tree-sitter-cpp/build/Release/` |
| Rust | `rust.node` | `node_modules/tree-sitter-rust/build/Release/` |

### 配置示例（以 Python 为例）

```bash
# 1. 下载语法包
# 访问：https://github.com/tree-sitter/tree-sitter-python/releases
# 下载对应 Node.js 版本的 .node 文件

# 2. 创建目标目录
mkdir -p node_modules/tree-sitter-python/build/Release

# 3. 复制文件（文件名可能不同，以下载的为准）
cp /path/to/tree_sitter_python_binding.node node_modules/tree-sitter-python/build/Release/

# 4. 重新构建
npm run build
```

> **提示**：未配置语法包的语言会自动使用基于行的分块方式，功能正常。

---

## 常见问题

### 错误：Cannot find module './build/Release/xxx'

**原因**：文件路径或文件名不正确。

**解决**：
```bash
# 检查文件是否存在
ls node_modules/[package-name]/build/Release/

# 确认文件名是否正确（常见命名：parser.node, [language].node, tree_sitter_xxx_binding.node）
```

### 错误：was compiled against a different Node.js version

**原因**：预编译文件的 Node.js 版本不匹配。

**解决**：
```bash
# 检查您的版本
node -p "process.versions.modules"

# 下载匹配的版本：
# NODE_MODULE_VERSION 127 → Node.js v22.x
# NODE_MODULE_VERSION 121 → Node.js v20.x
```

### 警告：Grammar not found for [language]

**原因**：该语言语法包未配置。

**影响**：自动使用 fallback 分块，不影响基本功能。

**解决**：无需处理，或按需配置语法包以启用语义分块。

---

## 替代方案

### 方案 A：安装 Visual Studio Build Tools

```
1. 下载：https://visualstudio.microsoft.com/downloads/
2. 安装 "Build Tools for Visual Studio 2022"
3. 勾选 "使用 C++ 的桌面开发"
4. 运行 npm install
```

### 方案 B：使用 WSL2

```bash
wsl
sudo apt install -y nodejs npm build-essential
cd /mnt/c/Users/26069/Desktop/ContextWeaver
npm install
npm run build
```
