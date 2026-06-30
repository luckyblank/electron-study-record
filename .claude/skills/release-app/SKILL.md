---
name: "electron-study-record:release-app"
description: "一键发版工作流：保存计划文件到 plan/、更新 README 更新日志、写入 release-notes 版本文档、执行 npm run release 打包上传。每次发版时调用，确保所有文档与版本同步。"
---

# electron-study-record:release-app

一键发版工作流。在上下文中有改动/计划时调用，自动完成文档同步和打包发布。

## 工作流

### 1. 保存计划文件到 `plan/`

如果对话上下文或 `C:\Users\lucky\.claude\plans\` 目录下存在本次改动对应的计划文件（`.md`），将它们拷贝到项目根目录的 `plan/` 下。确保每次发版时，对应的设计/实施计划随版本归档。

### 2. 更新 README.md

将当前所有改动（代码变更 + 计划文件）提炼为更新内容，追加或更新到 README.md 的更新日志区域。

### 3. 写入 release-notes

- 读取 `package.json` 的 `version` 字段
- 将本次更新的内容提炼为面向用户的版本说明，写入 `release-notes/v{version}.md`
- 同时更新根目录的 `release-notes.md`（项目打包时 `scripts/prepare-release-notes.js` 会读取该文件）

### 4. 打包发布

在项目根目录执行：

```bash
npm run release
```

该命令等价于 `npm run dist && npm run upload`，会自动：
- `rebuild-native`（重编 sqlite3 针对 Electron ABI）
- `prepare-notes`（按 version 路由对应的 md —— 确保第 3 步已写入）
- electron-builder 打包为 NSIS 安装包
- 上传 exe + latest.yml 到 `config.deploy.uploadUrl`

如果第 3 步未执行或 `release-notes/v{version}.md` 不存在，`npm run release` 中的 `prepare-notes` 步骤会失败。

## 注意事项

- 调用前确认 `package.json` 的 `version` 已更新到目标版本
- 如果 `config.deploy.uploadUrl` 不可达，上传步骤会失败，可单独执行 `npm run dist` 仅打包
- 第 1 步只拷贝 `.md` 计划文件，不处理二进制或图片附件
- 第 2 步写入 README 时，保留原有架构/功能/快捷方式等不变内容，只更新变更日志部分
