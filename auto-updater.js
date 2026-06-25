// 自动更新管理：基于 electron-updater + electron-log
// 用法（在 main.js 中）：
//   const { initAutoUpdater } = require('./auto-updater.js')
//   app.whenReady().then(() => {
//     createWindow()           // 先建好 mainWindow
//     initAutoUpdater(mainWindow)  // 再传入主窗口引用
//   })

const { ipcMain } = require('electron')
const log = require('electron-log')

let updater

function getAutoUpdater() {
  if (!updater) {
    updater = require('electron-updater').autoUpdater
    updater.logger = log
    updater.logger.transports.file.level = 'info'
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.forceDevUpdateConfig = true
  }
  return updater
}

let eventsBound = false
let manualCheck = false  // 标记本次检查是否由用户手动触发
let pendingUpdate = null // 最近一次发现的新版本信息 { version, notes }
let downloading = false

function notifyRenderer(getWindow, channel, payload) {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload)
  }
}

function bindEvents(getWindow) {
  if (eventsBound) return
  eventsBound = true
  const updater = getAutoUpdater()

  updater.on('checking-for-update', () => {
    log.info('Checking for update...')
    notifyRenderer(getWindow, 'updater:status', { state: 'checking', manual: manualCheck })
  })

  // 发现新版本：仅缓存 + 通知渲染端点亮按钮，不再自动弹原生 dialog
  updater.on('update-available', (info) => {
    const notes = info.releaseNotes || '暂无更新说明'
    const noteText = Array.isArray(notes) ? notes.join('\n') : notes
    pendingUpdate = { version: info.version, notes: noteText }
    notifyRenderer(getWindow, 'updater:status', {
      state: 'available', manual: manualCheck, version: info.version
    })
    manualCheck = false
  })

  updater.on('update-not-available', (info) => {
    log.info('No update:', info)
    notifyRenderer(getWindow, 'updater:status', {
      state: 'not-available', manual: manualCheck
    })
    manualCheck = false
  })

  updater.on('download-progress', (progress) => {
    log.info('Download progress:', progress)
    notifyRenderer(getWindow, 'download-progress', progress)
    notifyRenderer(getWindow, 'updater:status', {
      state: 'downloading', percent: progress && progress.percent
    })
  })

  updater.on('update-downloaded', (info) => {
    log.info('Update downloaded:', info && info.version)
    downloading = false
    pendingUpdate = null
    notifyRenderer(getWindow, 'updater:status', { state: 'downloaded', manual: true })
    updater.quitAndInstall()
  })

  updater.on('error', (err) => {
    log.error('Update error:', err)
    downloading = false
    notifyRenderer(getWindow, 'updater:status', {
      state: 'error', manual: manualCheck, message: (err && err.message) || String(err)
    })
    manualCheck = false
  })
}

function bindIpc(getWindow) {
  const updater = getAutoUpdater()
  // 手动检查更新（来自渲染进程的标题栏按钮）
  // 不 await checkForUpdates —— 错误统一通过 'error' 事件上报，避免 IPC 与事件双重 toast
  ipcMain.handle('updater:check', async () => {
    if (process.argv.includes('--squirrel-firstrun')) {
      return { skipped: true, reason: 'first-run' }
    }
    manualCheck = true
    updater.checkForUpdates().catch(() => {
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
  // 改为 invoke 以便前端获取下载启动结果
  ipcMain.handle('updater:start-download', async () => {
    if (!pendingUpdate) return { ok: false, reason: 'no-pending' }
    if (downloading) return { ok: false, reason: 'already-downloading' }
    try {
      downloading = true
      // 通知前端开始下载（manual 标记为 true，让前端显示反馈）
      notifyRenderer(getWindow, 'updater:status', { state: 'downloading', manual: true })
      await updater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      downloading = false
      log.error('downloadUpdate failed:', err)
      notifyRenderer(getWindow, 'updater:status', {
        state: 'error', manual: true, message: (err && err.message) || String(err)
      })
      return { ok: false, reason: (err && err.message) || String(err) }
    }
  })
}

/**
 * 初始化自动更新
 * @param {BrowserWindow|() => BrowserWindow} winOrGetter 主窗口实例，或返回主窗口的函数
 */
function initAutoUpdater(winOrGetter) {
  const updater = getAutoUpdater()
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
    updater.checkForUpdatesAndNotify()
  }, 3000)
}

module.exports = { initAutoUpdater }
