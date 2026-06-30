# 学习时间记录APP



## 描述

这是一由AI编写，基于ElectronV36.2.1+SqliteV5.1.7实现的记录学习时间的APP。支持自定义当日的学习时间区间、查看学习历史、每日寄语等功能。

ps：该APP纯属于心血来潮，临时想记录一下每天的学习时间。大约耗时5-6小时完成。

## 功能

|                            主页面                            |                           设置面板                           |
| :----------------------------------------------------------: | :----------------------------------------------------------: |
| ![image-20260626070658495](https://qny.luckyblank.cn/image-20260626070658495.png) | ![image-20260626070722493](https://qny.luckyblank.cn/image-20260626070722493.png) |
|                           迷你小窗                           |                         导出学习数据                         |
| ![image-20260626070745862](https://qny.luckyblank.cn/image-20260626070745862.png) | ![image-20260626070812936](https://qny.luckyblank.cn/image-20260626070812936.png) |
|                           我的宠物                           |                           我的徽章                           |
| ![image-20260626070846716](https://qny.luckyblank.cn/image-20260626070846716.png) | ![image-20260626070859660](https://qny.luckyblank.cn/image-20260626070859660.png) |



## 环境

### node版本

nodejs：V20.12.1

### 项目依赖

```json
  "dependencies": {
    "sqlite3": "^5.1.7",
    "electron-log": "^5.4.4",
    "electron-updater": "^6.8.9"
  },
  "devDependencies": {
    "electron": "^36.2.1",
    "electron-builder": "^26.0.12",
    "electron-rebuild": "^3.2.9",
    "gsap": "^3.15.0",
    "nodemon": "^3.1.10"
  }
```

> GSAP 的 UMD 构建已复制到 `vendor/gsap.min.js` 随包发布（渲染端通过 `<script>` 引入，无需 `require`）。升级 gsap 后运行 `npm run sync-gsap` 刷新该文件。



## 运行

### 整体脚本

```json
  "scripts": {
    "start": "nodemon --exec electron . --dev",
    "sync-gsap": "node -e \"require('fs').copyFileSync('node_modules/gsap/dist/gsap.min.js','vendor/gsap.min.js')\"",
    "prepare-notes": "node scripts/prepare-release-notes.js",
    "build": "npm run prepare-notes && electron-builder",
    "rebuild-native": "npx electron-rebuild -f -w sqlite3 -v 36.2.1 --arch=x64",
    "dist": "npm run rebuild-native && npm run build",
    "upload": "node scripts/upload-release.js",
    "release": "npm run dist && npm run upload"
  }
```

### 运行命令

```shell
# 安装依赖
npm i
# 以 nodemon 形式运行，修改立即自动编译生效（自动使用 outer/study_time.dev.db）
npm run start
```

### 打包命令

```shell
# 只打包，不上传
npm run dist

# 打包 + 上传到 config.deploy.uploadUrl
npm run release
```



## 快捷键

| 序号 | 快捷键     | 描述         |
| ---- | ---------- | ------------ |
| 1    | Ctrl+Alt+S | 开始记录     |
| 2    | Ctrl+Alt+P | 暂停/继续    |
| 3    | Ctrl+Alt+E | 结束记录     |
| 4    | Ctrl+Alt+1 | 显示窗口     |
| 5    | Ctrl+Alt+2 | 关闭窗口     |
| 6    | Ctrl+Alt+Q | 退出程序     |
| 7    | Ctrl+Alt+M | 切换迷你模式 |
| 8    | Ctrl+Alt+T | 切换主题     |



## 待发布改动（v1.0.3 候选）

### 🎬 GSAP 动画系统重设计

引入 GSAP 3.15.0 重写关键动画时刻，替代原先 `setTimeout` + `void offsetWidth` + class 切换的脆弱模式。

- **新增 `animations.js` 动画工具模块**（暴露 `window.Anim`，GSAP 未加载时降级为 no-op）
- **Modal 退出动画**：补齐此前缺失的关闭动画，支持动画中途打断/重入
- **Toast / 宠物 celebrate·levelup / 徽章解锁 / 进度环** 全部改为 GSAP timeline 驱动
- 进度环支持百分比数字计数动画
- `prefers-reduced-motion` 适配
- 保留 CSS 负责的 hover 微过渡与循环 keyframes（呼吸/眨眼/spin）不变
- gsap 作为 `devDependencies`，UMD 构建复制到 `vendor/gsap.min.js`，新增 `npm run sync-gsap` 用于升级后刷新

详见 `plan/GSAP动画系统重设计计划.md`

### 🔔 自定义系统级 Toast 通知窗口

开始/结束记录通知从原生 OS 通知改为**自定义美化的系统级浮层**，完全复刻 app 主题（蓝紫渐变 + 玻璃拟态 + 三主题适配）。

- **独立无边框透明窗口**：`alwaysOnTop` 置顶、`skipTaskbar` 不进任务栏，定位屏幕右下角，单例复用
- `toast.html` 单独文件，内联 CSS + inline SVG 图标，亮/暗/护眼三主题自动适配
- 入场从右滑入、退场向右滑出，`cubic-bezier(0.16,1,0.3,1)` 缓动
- 失败自动回退原生 `Notification`
- **结束记录通知逻辑**：`endSession({ silent })`，仅「结束按钮点击 / Ctrl+Alt+E」弹通知；「Ctrl+Alt+Q 安全退出 / 更新安装」静默不弹
- 文件选择器（`dialog.showSaveDialog`）与启动错误弹窗（`dialog.showErrorBox`）保持原生

详见 `plan/自定义系统级Toast通知窗口实施计划.md`

### 🐾 Toast 窗口增强：宠物形象 + 进度条 + 悬停暂停 + 关闭按钮

在自定义 Toast 窗口基础上进一步完善通知体验：

- **暂停/恢复记录也走系统通知**：此前只在应用内弹 toast，现统一为系统级 Toast（5000ms）
- **弹窗显示当前宠物形象**：左侧渲染当前宠物 SVG（`renderPetSvg` 注入 payload），颜色随主题自动适配
- **5 秒倒计时 + 底部进度条**：`scaleX 1→0` CSS animation 与倒计时同步
- **鼠标悬停暂停**：`mouseenter` 暂停倒计时与进度条，`mouseleave` 按剩余时间续跑（JS `Date.now()` 记 elapsed）
- **标题去重**：app 名作品牌小字标签，`title` 承载事件消息（如「已结束记录」），副标题承载「今日累计 XX」
- **右上角关闭按钮**：× 按钮，hover 走 accent 反馈，点击立即隐藏
- **窗口尺寸** 288×76 → 332×108，卡片高度 64→96px
- 倒计时从主进程下放到 `toast.html` 内部，主进程通过 `toast:request-hide` IPC 接收隐藏请求

详见 `plan/Toast窗口增强-宠物进度条悬停暂停关闭按钮.md`

### 🐛 问题修复

- **任务栏 thumbar 图标丢失**：窗口从托盘恢复（`win.show()`）后任务栏缩略图按钮被系统清空且不自动重建，在 `'show'` 事件中重新调用 `updateThumbarButtons(win)` 修复
- **通知背景透字**：Toast 卡片背景由半透明 `rgba` 改为不透明纯色，避免透出背后内容



## v1.0.2 改动清单

### 🐾 学习宠物系统

宠物会随着学习成长——开始学习时前倾专注，暂停时歪头疑惑，结束时跳跃撒星星庆祝。三种宠物逐步解锁，四项属性持久化。

- **学霸猫**（默认）→ **努力汪**（累计 10h / 连续 7 天）→ **智慧鸮**（5 徽章 / 累计 50h）
- 学习 1 分钟 = 1 EXP，`升级 EXP = 100 + (等级-1) × 50`；等级/心情/能量/亲密度自动更新
- 点击宠物心形飘出互动（每日上限 20 次），能量学习时消耗、暂停时恢复，超 2h 疲惫提醒
- 设置面板「我的宠物」入口查看与切换已解锁宠物

### 🆕 新增功能

- **暂停/继续记录**：计时中随时暂停（快捷键 `Ctrl+Alt+P`），暂停期间不计入学习时长；`study_sessions` 表新增 `paused_at` / `paused_duration` 字段持久化暂停状态
- **自定义确认弹窗**：所有删除操作（记录/标签/寄语）改用应用内确认弹窗，替换浏览器原生 `confirm()`
- **时间区间预设**：统计时间区间新增自然日 / 学习日 / 工作日 / 自定义预设，选择预设后自动填充时间
- **图表悬浮提示**：最近 7 天柱状图和 35 天热力图支持 hover 查看日期与精确学习时长
- **更新下载进度展示**：下载更新时显示进度条和百分比

### 🎨 体验优化

- **设置面板重新分组**：重新组织功能入口，新增「我的宠物」卡片，分组更清晰
- **设置面板固定头部**：标题与关闭按钮固定不滚动，只有中间内容区滚动
- **设置面板滚动体验**：每次重新打开设置面板或弹窗时，滚动位置自动回到顶部；底部增加安全留白
- **暂停状态全面强化**：计时数字弱化、暂停按钮切换为”继续”图标与渐变色反馈；标签栏”已暂停”标记（柔和脉冲+警告色）；迷你窗口边框呼吸光效；托盘菜单标注”暂停中”
- **按钮显隐优化**：开始/暂停/结束按钮根据会话状态智能切换（CSS `control-hidden` 类）

### 🔨 基础设施改进

- **数据库迁移 v002**：自动为 `study_sessions` 表添加 `paused_at` 和 `paused_duration` 列
- **宠物状态持久化**：宠物数据通过 `user_config.pet_state` JSON 存储，重启不丢失
- **electron-log 日志**：主进程异常 + IPC 错误自动落盘，打包后也能排查
- **生产环境 DB 路径修复**：安装版数据库从只读 `Program Files/asar.unpacked` 迁移到可写 `%APPDATA%/study-time-record/`，首次启动自动拷贝种子库
- 补充警告色、柔和状态色、遮罩色、动画时长和间距变量，宠物样式完全复用主题 CSS 变量
- 适配浅色 / 深色 / 护眼绿三套主题



## v1.0.1 改动清单（按类型归类）

### 🆕 新增功能

- **会话备注**：`study_sessions.note` 字段 + 卡片底部 popover（textarea + 字数计数 + 保存/取消），`Ctrl+Enter` 保存
- **会话↔标签 绑定**：多对多关系 (`session_tags`)，卡片底部弹多选浮层逐个点击即增量保存
- **检查更新功能**：标题栏圆底向上箭头按钮，发现新版本变主题色 + 柔光晕呼吸；自渲染 markdown 弹窗替代系统 `dialog.showMessageBox`
- **徽章成就系统**：8 种徽章（初学/连续打卡/累计学习等）+ 解锁动画
- **数据统计**：累计时长 / 总记录数 / 最长连续天数 / 7 天柱状图 / 35 天热力图
- **数据导出**：CSV / JSON 两种格式
- **寄语管理**：迁移到 `study_quotes` 表，支持增删改 + 预置 16 条
- **主题切换**：浅色 / 深色 / 护眼绿
- **每日激励系统**：跨过 1h/2h/4h/8h 触发庆祝粒子动画 + 提醒 toast

### 🔨 重构

- **迁移脚本折叠为单一基线**：原 v001-v005 合并为 `sql/migrations/v001_initial.js`,新装机器一次性建齐所有表 + 索引 + 默认数据
- **建表逻辑统一管理**：删除 `main.js` 的 `createBaseTables()`,所有 schema 由迁移脚本唯一声明
- **自动更新独立模块**：抽出 `auto-updater.js`,关闭自动下载/自动安装,所有动作走用户确认
- **更新弹窗自渲染**：不再用系统原生 dialog,改用项目现有 `modal-root` 体系 + 内置小型 markdown 渲染器(支持 `#/##/###` / 列表 / `**粗体**` / `` `代码` `` / `[链接](url)` / `---`)
- **统计数据实时聚合**：累计时长 / 总记录数 / 最长连续从 `study_sessions` 表 SQL 聚合,不再依赖 `user_config` 累加缓存（删记录后数据立即正确）
- **时间字段格式统一**：`study_sessions.start_time` / `end_time` 改为 `YYYY-MM-DD HH:mm:ss`（中国时间无后缀）
- **删除 `outer/word.txt`**：寄语迁移到 `study_quotes` 表
- **删除 `images/*.png`**：改用 inline SVG

### 🎨 设计系统重构

- **Type Scale 系统**：80+ 处散乱字号（28 档）收敛到 7 档 token（`--fs-micro` ~ `--fs-display`）
- **Spacing 系统**：6 档 spacing token（`--sp-1` ~ `--sp-6`，基于 4px 网格）
- **Toast 重新设计**：弱化为胶囊形 + 5px 彩色小圆点
- **标签 popover / 备注 popover 视觉同构**：圆角小卡 + 顶箭头 + 翻转动画
- **检查更新按钮**：圆底设计，区别于其他标题栏按钮
- **导出页面**：CSV / JSON 改为两列卡片网格
- **标题栏品牌信息**：左侧显示「学习时间记录 vX.X.X」
- **会话标签区整行可点**：hover 时整行高亮提示

### 🐛 问题修复

- **多 modal 子页面底部 footer 被遮挡**：`modal-root` 从 `inset: 0 + padding` 改为 `top:30 left:8 right:8 bottom:8` 直接限定盒子尺寸；`modal-panel` 改用 `display: flex; max-height: 100%`,`.modal-body` 改用 `flex: 1; min-height: 0; overflow-y: auto`
- **设置面板 + 迷你模式切换空白 bug**：进入迷你模式前强制复位设置面板状态
- **时间字段被 V8 当 UTC 解析**：新增 `parseChinaTime()` / `parseDbTime()` 帮助函数,统一处理
- **迁移器版本判定 bug**：原 `getCurrentVersion` 在无 `db_schema_version` key 时返回 1 导致 v001 不会执行,改为返回 0；迁移循环改为 `for v = currentVersion+1; v <= finalTarget; v++` 闭区间
- **双 toast bug**：自动更新错误同时通过 IPC reject 和事件触发两次 toast,改成只通过事件单路上报
- **迷你模式按钮难点击**：从 16×16 放大到 22×22
- **检查更新文案友好化**：404 / ENOENT 显示「暂无可用更新源」而不是原始堆栈

### 🔔 通知频率治理

- **1h 激励 toast 按日持久化**：写入 `user_config.celebrated_milestones_state`,重启不重弹
- **2h 后自动让位**：跨过 2h 后 1h toast 自动屏蔽,把提醒权交给「每 2 小时提醒休息」系统通知,避免同一时段两条提醒
- **每 2 小时提醒按日去重**：`notified_over_2h_state` 写入 db
- **里程碑庆祝去重**：避免重启后重复弹动画

### 🚀 发版工作流

- **动态 release notes**：`scripts/prepare-release-notes.js` 在打包前读 `package.json.version`,从 `release-notes/v{version}.md` 拷贝到根目录 `release-notes.md`（electron-builder 读取），找不到对应版本 `process.exit(1)` 防止误带旧说明
- **一键打包上传**：`scripts/upload-release.js` 一次 POST 把 `dist/学习时间记录 Setup X.X.X.exe` + `latest.yml` + `version` 发到服务器；零依赖（Node 18+ 自带 fetch / FormData / Blob）
- **后端示例 Controller**：`server/ReleaseUploadController.java`（Spring Boot）+ `server/CorsConfig.java`,支持 IP 白名单（精确 / CIDR / 通配符）+ 原子写防止半截 latest.yml
- **开发 / 生产数据库分离**：开发 `outer/study_time.dev.db`（已加入 `.gitignore`）/ 生产 `outer/study_time.db`（作为出厂初始库随包发布）
- **备份文件命名优化**：`backup_v4_2026-06-23T06-37-24`（UTC + 冒号替换）→ `backup_v4_202606231437`（中国时间紧凑形式）



## 开发维护注意事项

### 时间字段
- `study_sessions.start_time` / `end_time` 统一为 **`YYYY-MM-DD HH:mm:ss`（中国时间，无时区后缀）**
- **不要直接 `new Date(row.start_time)`** —— V8 会把无后缀字符串当 UTC 解析，造成 8 小时偏移
  - 渲染进程用 `parseChinaTime(s)`（`renderer.js`）
  - 主进程用 `parseDbTime(s)`（`main.js`）
- 写入也不要用 `new Date().toISOString()`，统一调用 `toChinaTimeString(date)`
- 两个解析函数都向后兼容旧格式（`T` 分隔 + `+08:00` / `Z` / 无后缀）

### 新增数据库迁移
1. 在 `sql/migrations/` 下新建 `v{NNN}_xxx.js`，文件名前缀数字（如 `v002`）必须与文件内 `module.exports.version` 字段一致
2. 把 `config.js` 的 `db.targetSchemaVersion` 改为该数字（这是「准备好让它生效」的显式开关，半成品不会被自动跑）
3. 迁移脚本会被**自动扫描加载**，无需在 `database-migrator.js` 里手动 `require`
4. 启动时会自动备份到 `outer/study_time.db.backup_v{旧版本}_{中国时间YYYYMMDDHHMM}`，30 天后清理
5. **建表逻辑唯一来源是迁移脚本**，不要再在 `main.js` 写 `CREATE TABLE`

### 发版流程
1. 在 `release-notes/` 下新建 `v{当前版本}.md` 写本次更新说明（用户会看到，要面向用户）
2. 改 `package.json.version` 为该版本号
3. 改 `config.js` 的 `deploy.uploadUrl`（如服务器变更）
4. `npm run release` —— 等价于 `npm run dist && npm run upload`，会自动：
   - `rebuild-native`（重编 sqlite3 针对 Electron ABI）
   - `prepare-notes`（按 version 路由对应的 md）
   - electron-builder 打包
   - 上传 exe + latest.yml 到 `config.deploy.uploadUrl`
5. **找不到 `release-notes/v{version}.md` 时打包会失败**（避免带旧说明）

### 窗口行为（容易破坏的不变量）
- 主窗口 `frame: false` + `titleBarStyle: 'hidden'` + `alwaysOnTop: true` + 菜单栏移除，关闭只是隐藏到托盘，**只有 `safeQuit`（托盘菜单 / `Ctrl+Alt+Q`）会真正退出**，且退出前会先发 `global-shortcut: 'end'` 让渲染进程把进行中的 session 写入数据库
- `.titlebar` 元素是窗口拖拽区，编辑 DOM 时不要删
- 迷你模式的按钮显隐由 `body.mini-mode` 的 CSS 选择器控制，新增标题栏按钮时记得在 `styles.css` 的迷你模式段加 `display: none !important` 隐藏列表

### Modal 子页面（容易出 bug）
- `modal-root` 用 `top:30 left:8 right:8 bottom:8` 定下盒子尺寸（让出 26px 标题栏），**不要改回 `inset: 0 + padding`** —— flex item 的 `max-height: 100%` 在 padding 容器里不一定能可靠约束
- `modal-panel` 必须 `display: flex; flex-direction: column; max-height: 100%`，并让 `.modal-body` `flex: 1; min-height: 0; overflow-y: auto`，否则底部 footer 会被裁

### Type Scale / Spacing 系统
- **不要直接写 `font-size: 0.78rem` 这种硬编码值**，用 7 档 token：`--fs-micro` / `--fs-xs` / `--fs-sm` / `--fs-base` / `--fs-lg` / `--fs-xl` / `--fs-display`
- 间距用 `--sp-1` ~ `--sp-6`（4px 网格）
- 一个组件需要新档位时，先评估是否能就近映射到已有 token；只有真的不够才加新 token

### Toast / 通知
- `showToast(text, type, duration, useSystemNotify, subtitle)` —— `useSystemNotify=true` 走系统级 Toast（开始/结束/暂停/恢复 session、跨过 2h 等需要离开窗口也看得到的）；`subtitle` 为可选副标题（如「今日累计 XX」）
- **标题层级**：app 名「学习时间记录」作 toast 顶部小字品牌标签，`title` 承载事件消息，`subtitle` 承载次要信息——不要再用「学习时间记录」做 title，否则与品牌标签重复
- **当前宠物形象**：`showToast(..., true)` 时自动调用 `buildCurrentPetSvg()` 注入 `petSvg`，toast 左侧渲染。SVG 用的 CSS 变量在 `toast.html :root` 已定义，三主题自动适配
- 同一时段避免重复弹两条：1h toast 在 `sec >= 2h` 时**自动屏蔽**，把提醒权交给 `maybeNotifyHourly`（每 2h 一次，按日去重）
- **系统级 Toast 倒计时**：5s 倒计时 + 底部进度条，**倒计时逻辑在 `toast.html` 内部**（非主进程），鼠标悬停暂停、移出续跑；走完发 `toast:request-hide` IPC 触发主进程隐藏。右上角 × 按钮可立即关闭
- **结束记录通知逻辑**：`endSession({ silent })` —— 仅「结束按钮 / Ctrl+Alt+E」(`silent=false`) 弹通知；「安全退出 Ctrl+Alt+Q / 更新安装」(`silent=true`) 静默。**改动 endSession 调用点时务必确认 silent 取值**
- 动画走 `animations.js` 的 `window.Anim`（GSAP）；GSAP 未加载时降级为 CSS 过渡
- 任务栏 thumbar 按钮在窗口 `hide()` 到托盘后会被系统清空，恢复时需在 `'show'` 事件重新 `updateThumbarButtons(win)`

### GSAP 动画 / vendor
- GSAP 作为 `devDependencies`，UMD 构建复制到 `vendor/gsap.min.js` 随包发布（渲染端 `<script>` 引入）
- 升级 gsap 后必须运行 `npm run sync-gsap` 刷新 `vendor/gsap.min.js`，否则渲染端仍是旧版本
- 动画工具集中在 `animations.js`（`window.Anim`）；新增动画优先复用已有 `Anim.modal/toast/badge/pet/progressRing` 方法

### 自动更新
- 入口在 `auto-updater.js`，使用 `electron-updater`。**禁用自动下载和退出时自动安装**，所有动作走用户确认
- 发现新版本 → 通过 IPC 通知渲染端点亮按钮 + 缓存 pendingUpdate；用户点击 → 渲染自渲染 markdown modal → 用户确认 → 调 `autoUpdater.downloadUpdate()`
- 不要在主进程用 `dialog.showMessageBox` 弹原生窗，否则视觉风格不统一且在迷你窗口下错位

### 文件位置
- `outer/study_time.db` 是**生产** db，作为出厂初始数据随包发布；`outer/study_time.dev.db` 是**开发** db，已加入 `.gitignore`
- 靠 `package.json` 的 `build.asarUnpack` 在打包后保持可读写。**不要把它移出 `outer/`**，否则要同步改 `getDatabasePath()` 以及 `asarUnpack` 配置
- `sql/*.sql` 是参考性 schema，不在运行时执行，**真正生效的是迁移脚本**
- 寄语（每日鼓励语）存在数据库 `study_quotes` 表里，启动时通过 `loadWordsFromDB()` 加载到内存。旧版本的 `outer/word.txt` 已弃用
