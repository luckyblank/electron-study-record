# GSAP 动画系统重设计计划

> 实施日期：2026-06-30
> 状态：已实施

## 一、背景与目标

### 当前动画系统现状（改造前）
- **CSS 驱动**：30+ 个 `@keyframes` 循环动画（宠物呼吸/眨眼/学习/暂停等，spin，呼吸点），数百个 hover 微过渡
- **JS 驱动**：一次性动画使用脆弱模式：`classList.remove/add` + `void offsetWidth` 强制重绘 + `setTimeout` 清理
  - Modal 弹窗（只有进入动画，**无退出动画**）
  - Toast 提示
  - 宠物庆祝/升级/粒子效果
  - 徽章解锁
  - 进度环更新

### 当前系统问题
1. `setTimeout` 时序脆弱 - CSS 和 JS 时长可能不同步
2. `void offsetWidth` 是 hack 手段强制重绘
3. 不可中断 - 无法在动画中反转、加速或修改
4. 时序编排是手动的（嵌套 setTimeout）
5. Modal 没有退出动画（直接 hidden）

### GSAP 重设计目标
- 用 GSAP 替代 JS 驱动的关键动画时刻（保持 CSS hover 和循环 keyframes 不变）
- 提供可中断、可编程、时序可靠的动画
- 添加 Modal 退出动画（当前缺失）
- 增强宠物粒子效果的时序编排
- 统一 easing 曲线：使用 GSAP 的 `power2.out`（匹配现有 `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`）

## 二、技术方案

### GSAP 加载策略（无 bundler 环境）
项目无 webpack/vite，且 `webPreferences` 只设 `preload`（`nodeIntegration` 关闭），`require('gsap')` 在渲染端不可用；CSP 为 `script-src 'self' 'unsafe-inline'`，不能用 CDN。

解决方案：
1. `npm install gsap` —— 安装到 node_modules
2. 复制 `node_modules/gsap/dist/gsap.min.js` → `vendor/gsap.min.js`（UMD 构建，暴露全局 `gsap`）
3. `index.html` 中 `renderer.js` 之前插入 `<script src="vendor/gsap.min.js"></script>`
4. 新建 `animations.js` 作为 GSAP 动画工具模块

> gsap 置于 `devDependencies`（避免打包进 asar 膨胀），新增 `npm run sync-gsap` 用于升级后刷新 vendor 文件

### 重设计范围（聚焦高价值时刻）
✅ **重写为 GSAP**：Modal 进出、Toast、宠物 celebrate/levelup/粒子/EXP、徽章解锁、进度环
❌ **保留 CSS 不变**：所有 hover 状态 transition、宠物循环动画（呼吸/眨眼/摇尾）、spin 旋转、呼吸点

## 三、实施步骤

1. **GSAP 基础设施**：`package.json` 添加 gsap（devDep）、`vendor/gsap.min.js`（73KB）、`index.html` 插入 script、新建 `animations.js`
2. **Modal 动画重写**：`showModal/hideModal` 用 `gsap.timeline()`，**新增退出动画**，支持动画中途打断/重入（`dataset.hiding` 标记防止计数错乱）
3. **Toast 动画重写**：`showToast` 用 GSAP timeline，移除嵌套 setTimeout；autoAlpha 目标 0.96（匹配设计）
4. **宠物动画升级**：`playAnimation('celebrate'/'levelup')`、`spawnParticles`、`spawnExpPop` 全部 GSAP 驱动，CSS keyframe 作降级
5. **徽章解锁升级**：图标弹跳 + 文字 stagger 入场
6. **进度环平滑**：GSAP tween `stroke-dashoffset` + 百分比数字计数动画
7. 设置 `gsap.defaults({ ease: 'power3.out' })`（匹配 `--ease-out`）

## 四、关键文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `package.json` | 修改 | gsap 置于 devDependencies，新增 `sync-gsap` 脚本 |
| `vendor/gsap.min.js` | 新增 | GSAP 3.15.0 UMD 构建 |
| `index.html` | 修改 | 插入 gsap + animations.js 脚本标签 |
| `animations.js` | 新增 | GSAP 动画工具模块（暴露 `window.Anim`），含降级 |
| `renderer.js` | 修改 | showModal/hideModal、showToast、pet、showBadgeUnlock、updateProgressRing 改用 Anim API |
| `styles.css` | 少量修改 | 移除被 GSAP 接管的 bfade/min keyframe 及冲突的 transition |

## 五、注意事项
- 所有 GSAP 驱动的元素都临时关闭/移除其 CSS `transition` 和 `animation`，避免逐帧更新与 CSS 过渡打架
- `prefers-reduced-motion` 适配：`fast()` 工具函数在用户开启减弱动画时返回 0 时长
- GSAP 加载失败不影响应用核心功能（`window.Anim` 退化为 no-op Proxy）

## 六、后续演进
此方案中的 Toast 动画（`Anim.toast`，应用内胶囊 toast）仍在使用；但记录相关事件的**系统级通知**后来被替换为独立的自定义 Toast 窗口（见《自定义系统级 Toast 通知窗口实施计划.md》），不再走应用内 `showToast`。
