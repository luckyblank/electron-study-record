# 自定义系统级 Toast 通知窗口实施计划

> 实施日期：2026-06-30 ~ 2026-07-01
> 状态：已实施

## 一、背景与目标

### 用户需求
- 开始/结束记录通知：**系统级别**（不在 app 内弹），完全**美化**，符合 app 主题
- 结束记录逻辑：**只有用户点击结束按钮或按 Ctrl+Alt+E 才弹通知**；用户直接关闭窗口或 Ctrl+Alt+Q 安全退出时，不弹通知
- 文件选择器（`dialog.showSaveDialog`）和启动错误弹窗（`dialog.showErrorBox`）保持原生，无需美化

### 选型
原生 Electron `Notification` 无法用 CSS 美化（只能设图标和文字，会进 Windows 操作中心）。
经与用户确认，采用 **A 方案：自定义美化的 Toast 窗口** —— 一个独立的无边框透明、始终置顶的 `BrowserWindow`，完全用 CSS 定制外观，看起来像系统弹窗但不进操作中心。

### 中间方案（已废弃）
曾实现过「应用内顶部横幅」（Variant A）替代 OS 通知，但用户明确要求"不要在 app 里面弹，需要系统弹窗"，因此移除该方案的全部代码（`#notification-banner` 容器、`.notification-banner` CSS、`Anim.banner`、`showNotification` 函数），改为本文档描述的自定义系统级窗口。

## 二、架构

主进程（`main.js`）维护一个独立的 `BrowserWindow`（`toastWindow`，全局单例）：
- `frame: false` / `transparent: true` —— 无边框，透明背景
- `alwaysOnTop: true`（层级 `screen-saver`）—— 始终置顶，系统级体验
- `skipTaskbar: true` —— 不显示在任务栏
- `show: false` —— 创建时不立即显示
- `resizable: false` / `movable: false` / `closable: false` / `focusable: false` —— 禁用交互
- 尺寸 `288 × 76`，定位到**屏幕右下角**（`screen.getPrimaryDisplay().workArea`）

### 窗口复用策略
- 全局单例，重复使用
- 已展示中的通知：清旧计时器 → 快速淡出 → 展示新的（串行，不叠加）
- 通知展示固定时长后 `hideThemedToast()`（不销毁，保留实例复用）
- 失败时 `fallbackNativeToast()` 回退原生 `Notification`

## 三、具体实施

### 1. `main.js` 新增/修改
- 顶部解构增加 `screen`
- 全局变量：`toastWindow` / `toastShowTimer` / `toastHideTimer` / `currentTheme`
- `createToastWindow()`：创建窗口、定位右下角、`loadFile('toast.html')`、`did-finish-load` 时推送当前主题
- `showThemedToast({ type, title, subtitle, duration })`：清计时器 → IPC `toast:show` → `showInactive()` → 定时 `hideThemedToast()`
- `hideThemedToast()`：IPC `toast:hide` → 320ms 后 `hide()`（保留实例）
- `fallbackNativeToast(title, body)`：原生 `Notification` 回退
- 改造 `ipcMain.handle('app:notify', ...)`：原 `new Notification` → 改为 `showThemedToast()`，支持 `type`/`duration` 参数
- `app:set-theme` 同步推送 `toast:theme` 到 toast 窗口；启动时从 DB 读取持久化主题赋给 `currentTheme`

### 2. `toast.html`（新增独立文件）
极简结构，完全内联 CSS，三主题（亮/暗/护眼）自动适配：
- **背景不透明纯色**：亮 `#ffffff` / 暗 `#2a3048` / 护眼 `#f2faee`（早期用 `rgba` 半透明会透出背后内容，已改为不透明）
- 左侧主色渐变条（4px，`#6a84e6→#936ae6`）
- 图标圆 + inline SVG（success/info/warning 各自配色）
- 标题 14px semibold + 副标题 12px，过长省略号收尾
- 圆角 14px，阴影 `0 18px 50px ...`
- 入场 `translateX(24px)→0` + scale，退场反向，`cubic-bezier(0.16,1,0.3,1)` 缓动
- `prefers-reduced-motion` 适配
- `nodeIntegration: true` + `contextIsolation: false`（该窗口专用），内联 CSP `script-src 'self' 'unsafe-inline'`

### 3. `renderer.js` 修改
- `showToast(text, type, duration, useSystemNotify)`：`useSystemNotify=true` 时向 `app:notify` 转发 `type`/`duration`（之前只传 title/body）
- 3 个记录事件改用 `showToast(..., true)`：
  - 开始记录：`showToast('已开始记录', 'success', 2800, true)`
  - 结束记录：`showToast('已结束记录 · 今日累计 XX', 'info', 2800, true)`（仅 `!silent` 时）
  - 超 2h 提醒：`showToast('已学习超 Nh，请休息一会哦~', 'info', 4500, true)`

### 4. 结束记录通知逻辑（核心）
`endSession({ silent = false } = {})` 新增 `silent` 参数。4 个调用点：

| 调用点 | 位置 | 传参 | 行为 |
|--------|------|------|------|
| 结束按钮点击 | `bindMainButtons` `addEventListener('click', endSession)` | MouseEvent 解构 → silent=false | **通知 ✅** |
| Ctrl+Alt+E | `bindGlobalShortcuts` action==='end' | `endSession()` → silent=false | **通知 ✅** |
| 安全退出 Ctrl+Alt+Q | action==='end-and-quit' | `endSession({ silent: true })` | **静默 ✅** |
| 更新安装 | `prepareForUpdateInstall` | `endSession({ silent: true })` | **静默 ✅** |

## 四、视觉规格
- 窗口 288×76，卡片 64px 高，margin 6px
- 玻璃拟态（不透明纯色 + `backdrop-filter`，因背景已不透明 backdrop 实际不生效但保留兼容）
- 左侧 4px 主色渐变条 + 34px 图标圆 + 文字区（flex 自适应）
- 入场从右侧滑入，退场向右滑出

## 五、清理（移除上一轮应用内横幅）
- `index.html`：移除 `#notification-banner` 整块
- `styles.css`：移除 `.notification-banner` 及 `.nb-*` 全部 CSS
- `animations.js`：移除 `Anim.banner` 对象
- `renderer.js`：移除 `showNotification` 函数及相关全局变量

## 六、验证清单
1. `npm start` 干净启动无报错
2. 点击「开始记录」/ Ctrl+Alt+S → 屏幕右下角出现主题通知，2.8s 淡出
3. 点击「结束记录」/ Ctrl+Alt+E → 通知出现，副标题带"今日累计"
4. Ctrl+Alt+Q 安全退出 → **不弹**结束通知
5. 关闭窗口（X）→ 隐藏到托盘（本就不通知）
6. 超 2h 提醒 → warning 类型通知
7. 切换主题 → 下一条通知自动使用对应配色
8. 连续触发 → 旧通知快速淡出，新通知干净展示，不叠加

## 七、已知限制 / 回退
- 透明窗口在个别 Windows 版本/显卡驱动下可能失效 → `app:notify` catch 中 `fallbackNativeToast()` 回退原生通知
- 自定义 Toast 不进 Windows 操作中心（区别于原生 `Notification`）；如需进入操作中心，需切回原生方案
