# Toast 窗口增强：宠物形象 + 进度条 + 悬停暂停 + 关闭按钮

> 实施日期：2026-07-01
> 状态：已实施
> 前置方案：`自定义系统级Toast通知窗口实施计划.md`（建立自定义 Toast 窗口）

## 背景
基于已落地的自定义系统级 Toast 窗口，用户提出一系列增强需求：
1. **暂停/恢复记录也要弹系统通知** — 此前只在应用内弹 toast
2. **弹窗显示当前宠物形象** — 此前只有小图标
3. **消失时间 5 秒，带消失进度条** — 此前为固定 setTimeout，无进度条
4. **鼠标悬停弹窗时暂停倒计时，移出后续跑** — 此前无此交互
5. **移除左侧彩色边框** — 左侧主色渐变条与边框冗余
6. **弹窗标题去重** — title 与 app 名标签都显示「学习时间记录」
7. **右上角关闭按钮** — 此前无法手动关闭

## 实现方案

### 1. 暂停/恢复通知改为系统级（renderer.js）
- `pauseSession()` → `showToast('已暂停记录', 'warning', 5000, true)`
- `resumeSession()` → `showToast('已继续记录', 'success', 5000, true)`
- 开始/结束/超 2h 时长统一 5000ms

### 2. 宠物形象注入（renderer.js）
- 新增 `buildCurrentPetSvg()`：从 `petManager.petState` 取 `activePetId` + `pet.level` → `getPetStage` → `renderPetSvg` 生成 SVG，注入通知 payload 的 `petSvg` 字段
- toast.html 左侧 `.toast-pet`（56px 圆 + soft 背景色）渲染该 SVG；无 SVG 时兜底小圆点
- SVG 使用的 CSS 变量（`--warning`/`--success`/`--accent`/`--accent-2`）在 toast.html `:root` 已定义，颜色自动匹配三主题

### 3. 进度条 + 悬停暂停（toast.html + main.js）
**倒计时从主进程移到 toast.html 内部**，用 CSS animation 驱动进度条 + JS 计时驱动 hide：
- 入场动画 320ms 后开始 5000ms 倒计时
- 底部进度条 `scaleX 1→0` 的 CSS animation，5s 线性，与倒计时同步
- `mouseenter` → `pauseCountdown()`：暂停 JS 计时器 + 进度条 `animation-play-state: paused`
- `mouseleave` → `resumeCountdown()`：按剩余时间续跑（用 `Date.now()` 记 elapsed，剩余 = total - elapsed）
- 倒计时走完通过 `toast:request-hide` IPC 通知主进程触发退场
- main.js 新增 `ipcMain.on('toast:request-hide', () => hideThemedToast())`，移除原 `toastShowTimer`

### 4. 标题去重（renderer.js）
**根因**：`showToast` 把 title 硬编码「学习时间记录」（app 名），而 toast.html 顶部又有固定 app 名标签——两行重复，事件消息被挤进副标题。

**修复**：app 名标签作品牌标识（小字灰色），`title` 承载事件消息：
- `showToast(text, type, duration, useSystemNotify, subtitle='')` 新增第 5 参数
- payload：`title: text`（消息）、`body: subtitle`
- 结束记录拆两行：`showToast('已结束记录', 'info', 5000, true, '今日累计 XX')`

层级：
```
学习时间记录          ← 品牌标签（小字、灰色）
已结束记录            ← 标题（加粗）
今日累计 01:23:45    ← 副标题（次要）
```

### 5. 右上角关闭按钮（toast.html）
- 绝对定位 `top:7px; right:7px`，20px 圆形 × 图标
- 默认透明度 0.45，hover → 1 + `accent-soft` 背景 + `accent` 色（与 modal/titlebar 关闭按钮一致）
- 点击 → 清计时器 + `toast:request-hide` 立即隐藏，`stopPropagation` 防冒泡干扰悬停逻辑
- 文本区 `padding-right: 20px` 给按钮留空间

### 6. 左侧彩色边框移除（toast.html）
删除 `.toast-accent` 主色渐变条（CSS + HTML 元素），卡片只保留整体 `1px solid var(--border)` 边框。

### 视觉调整
- Toast 窗口尺寸：288×76 → **332×108**（宠物需要更大空间）
- 卡片高度 64→96px

## 关键文件修改

| 文件 | 修改点 |
|------|---------|
| `renderer.js` | 1. `showToast` 新增 `subtitle` 参数，title 改为承载消息<br>2. 新增 `buildCurrentPetSvg()`<br>3. pause/resume 改系统级，duration 5000<br>4. start/end/over-2h duration 统一 5000 |
| `main.js` | 1. 窗口尺寸 332×108<br>2. `app:notify` 透传 `petSvg`，默认 duration 5000<br>3. 新增 `toast:request-hide` IPC listener<br>4. 移除 `toastShowTimer`（倒计时下放 toast.html） |
| `toast.html` | 1. HTML：宠物区 + 文本区(app名/标题/副标题) + 右上角关闭按钮 + 底部进度条<br>2. CSS：新布局、进度条 animation、关闭按钮<br>3. JS：可暂停/续跑倒计时、mouseenter/mouseleave、关闭按钮点击<br>4. 移除 `.toast-accent` |

## 验证清单
1. 点击「开始记录」→ 右下角通知，左侧有宠物，底部进度条从满到空
2. 鼠标悬停 → 进度条暂停、倒计时停；移开 → 继续
3. 5 秒后通知向右滑出消失
4. 暂停/继续/结束都应弹系统通知
5. 标题不再重复显示「学习时间记录」；app 名作小字品牌标签
6. 右上角 × 按钮，点击立即消失
7. 切换主题 → 通知配色与宠物颜色自动跟随
