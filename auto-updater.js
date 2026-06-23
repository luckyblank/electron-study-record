// 自动更新管理：基于 electron-updater + electron-log
// 用法（在 main.js 中）：
//   const { initAutoUpdater } = require('./auto-updater.js')
//   app.whenReady().then(() => {
//     createWindow()           // 先建好 mainWindow
//     initAutoUpdater(mainWindow)  // 再传入主窗口引用
//   })

const { ipcMain } = require('electron')
const log = require('electron-log')
const { autoUpdater } = require('electron-updater')

// 日志输出到 electron-log
autoUpdater.logger = log
autoUpdater.logger.transports.file.level = 'info'

// 关闭自动下载与退出时自动安装，全部由用户确认
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false

// 强制开发环境也走更新检查（便于调试）
autoUpdater.forceDevUpdateConfig = true

let eventsBound = false
let manualCheck = false  // 标记本次检查是否由用户手动触发
let pendingUpdate = null // 最近一次发现的新版本信息 { version, notes }

function notifyRenderer(getWindow, channel, payload) {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function bindEvents(getWindow) {
  if (eventsBound) return
  eventsBound = true

  autoUpdater.on('checking-for-update', () => {
    log.info('Checking for update...')
    notifyRenderer(getWindow, 'updater:status', { state: 'checking', manual: manualCheck })
  })

  // 发现新版本：仅缓存 + 通知渲染端点亮按钮，不再自动弹原生 dialog
  autoUpdater.on('update-available', (info) => {
    const notes = info.releaseNotes || '暂无更新说明'
    const noteText = Array.isArray(notes) ? notes.join('\n') : notes
    pendingUpdate = { version: info.version, notes: noteText }
    notifyRenderer(getWindow, 'updater:status', {
      state: 'available', manual: manualCheck, version: info.version
    })
    manualCheck = false
  })

  autoUpdater.on('update-not-available', (info) => {
    log.info('No update:', info)
    notifyRenderer(getWindow, 'updater:status', {
      state: 'not-available', manual: manualCheck
    })
    manualCheck = false
  })

  autoUpdater.on('download-progress', (progress) => {
    log.info('Download progress:', progress)
    notifyRenderer(getWindow, 'download-progress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info && info.version)
    autoUpdater.quitAndInstall()
  })

  autoUpdater.on('error', (err) => {
    log.error('Update error:', err)
    notifyRenderer(getWindow, 'updater:status', {
      state: 'error', manual: manualCheck, message: (err && err.message) || String(err)
    })
    manualCheck = false
  })
}

function bindIpc(getWindow) {
  // 手动检查更新（来自渲染进程的标题栏按钮）
  // 不 await checkForUpdates —— 错误统一通过 'error' 事件上报，避免 IPC 与事件双重 toast
  ipcMain.handle('updater:check', async () => {
    if (process.argv.includes('--squirrel-firstrun')) {
      return { skipped: true, reason: 'first-run' }
    }
    manualCheck = true
    autoUpdater.checkForUpdates().catch(() => {
      // 静默：'error' 事件已经发了 updater:status，前端会从那边显示提示
    })
    return { ok: true }
  })

  // 用户点亮态的按钮 → 请求渲染端展示自渲染的 markdown 弹窗（不再用系统 dialog）
  ipcMain.handle('updater:show-prompt', async () => {
    if (!pendingUpdate) return { ok: false, reason: 'no-pending' }
    notifyRenderer(getWindow, 'updater:show-prompt-requested', {
      version: pendingUpdate.version,
      notes: pendingUpdate.notes
    })
    return { ok: true }
  })

  // 渲染端弹窗按钮的回执：true = 立即下载，false = 稍后
  ipcMain.on('updater:prompt-response', (_event, accepted) => {
    if (accepted && pendingUpdate) {
      autoUpdater.downloadUpdate()
    }
  })
}

/**
 * 初始化自动更新
 * @param {BrowserWindow|() => BrowserWindow} winOrGetter 主窗口实例，或返回主窗口的函数
 */
function initAutoUpdater(winOrGetter) {
  const getWindow = typeof winOrGetter === 'function'
    ? winOrGetter
    : () => winOrGetter

  bindEvents(getWindow)
  bindIpc(getWindow)

  // 首次安装跳过自动检查（Squirrel 锁问题），但手动检查仍可用
  if (process.argv.includes('--squirrel-firstrun')) {
    log.info('First run, skip auto update check')
    return
  }

  // 启动 3 秒后自动检查（避开窗口初始化峰值）
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify()
  }, 3000)
}

module.exports = { initAutoUpdater, autoUpdater }
