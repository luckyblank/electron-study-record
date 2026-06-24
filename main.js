const {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  Tray,
  Menu,
  nativeImage,
  Notification,
  globalShortcut,
  dialog
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const sqlite3 = require('sqlite3').verbose()
const log = require('electron-log')

const CONFIG = require('./config.js')
const { runMigrations } = require('./database-migrator.js')
const { initAutoUpdater } = require('./auto-updater.js')

// 全局未捕获异常落盘——打包后没 DevTools 时也能看错误
// 日志位置：%USERPROFILE%/AppData/Roaming/study-time-record/logs/main.log
log.transports.file.level = 'info'
log.info('[Startup] electron app booting...')
process.on('uncaughtException', (err) => {
  log.error('[uncaughtException]', err && err.stack || err)
})
process.on('unhandledRejection', (reason) => {
  log.error('[unhandledRejection]', reason && reason.stack || reason)
})

// 包装 ipcMain.handle，让每个 handler 的异常都带通道名 + 完整 stack 落到 main.log
// 这样渲染端看到 "Error invoking remote method 'study:xxx'" 时可以查日志找到根因
const _originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, fn) => {
  _originalHandle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args)
    } catch (e) {
      log.error(`[IPC] ${channel} 失败:`, e && e.stack || e)
      throw e  // 仍然抛出，让渲染端 .catch 拿到
    }
  })
}

let db
let mainWindow = null
let appTray = null
let words = []
let isQuiting = false
let pendingQuitResolve = null

// 把 study_sessions 表里的时间字符串解析为 Date（中国时间语义）。
// 新格式: "YYYY-MM-DD HH:mm:ss"，旧格式带 T 和 +08:00 / Z / 无后缀 也兼容。
function parseDbTime(s) {
  if (!s) return new Date(NaN)
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(.*)$/.exec(s)
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m
    const suffix = tz && tz.trim() ? tz.trim() : '+08:00'
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${suffix === 'Z' ? '+08:00' : suffix}`)
  }
  return new Date(s)
}

// =============== 工具函数 ===============
function runSql(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err)
      else resolve({ lastID: this.lastID, changes: this.changes })
    })
  })
}

function getOne(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err)
      else resolve(row)
    })
  })
}

function getAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err)
      else resolve(rows)
    })
  })
}

// =============== 资源路径 ===============
function getDatabasePath() {
  if (app.isPackaged) {
    // 生产：放到 userData（用户可写目录，每个 Windows 用户独立）
    // 路径示例：%APPDATA%\study-time-record\study_time.db
    // 不能放 app.asar.unpacked/outer：Program Files 默认无写权限，sqlite3 报 SQLITE_READONLY
    const userDbPath = path.join(app.getPath('userData'), CONFIG.db.fileName)

    // 首次启动：把包内自带的"种子 db"拷到 userData
    // 种子位置：resources/app.asar.unpacked/outer/<fileName>
    if (!fs.existsSync(userDbPath)) {
      const seedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'outer', CONFIG.db.fileName)
      try {
        if (fs.existsSync(seedPath)) {
          fs.mkdirSync(path.dirname(userDbPath), { recursive: true })
          fs.copyFileSync(seedPath, userDbPath)
          console.log('[DB] 已从种子库初始化到 userData:', userDbPath)
        } else {
          console.log('[DB] 未找到种子库，将由迁移脚本新建空库:', userDbPath)
          fs.mkdirSync(path.dirname(userDbPath), { recursive: true })
        }
      } catch (e) {
        console.warn('[DB] 拷贝种子库失败，继续用空库:', e.message)
      }
    }
    return userDbPath
  }
  // 开发：用单独的 .dev.db，避免污染将来要打包带出的初始库
  return path.join(__dirname, 'outer', CONFIG.db.fileNameDev)
}

// =============== 词条（从数据库读取） ===============
async function loadWordsFromDB() {
  try {
    const rows = await getAll(`SELECT content FROM study_quotes WHERE enabled = 1 ORDER BY id`)
    words = rows.map(r => r.content).filter(Boolean)
    console.log(`[Quotes] 已加载 ${words.length} 条寄语`)
  } catch (e) {
    console.warn('[Quotes] 加载寄语失败，使用内置默认:', e.message)
    words = [
      '坚持就是胜利',
      '不积跬步，无以至千里',
      '你要悄悄拔尖，然后惊艳所有人'
    ]
  }
}

// =============== 数据库初始化 ===============
async function initDatabase() {
  const dbPath = getDatabasePath()
  console.log('[DB] 数据库路径:', dbPath)

  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(dbPath, async (err) => {
      if (err) {
        console.error('[DB] 打开数据库失败:', err.message)
        return reject(err)
      }
      console.log('[DB] 成功连接 SQLite')

      try {
        // 启用外键约束（迁移之前就要开，确保 v001 里 ON DELETE CASCADE 即时生效）
        await runSql('PRAGMA foreign_keys = ON')

        // 执行迁移：v001 负责所有建表 + 预置数据，全新库由它一次性建好
        const result = await runMigrations(db, dbPath, CONFIG.db.targetSchemaVersion)
        if (!result.success) {
          console.warn('[DB] 迁移失败，但应用可继续使用基础功能')
        } else if (!result.isLatest) {
          console.log(`[DB] 数据库已升级 v${result.migratedFrom} → v${result.migratedTo}`)
        }
        resolve()
      } catch (e) {
        console.error('[DB] 初始化异常:', e.message)
        reject(e)
      }
    })
  })
}

// =============== 窗口创建 ===============
function createWindow() {
  const win = new BrowserWindow({
    width: CONFIG.ui.window.normal.width,
    height: CONFIG.ui.window.normal.height,
    maxHeight: CONFIG.ui.window.maxHeight,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: '学习时间记录',
    alwaysOnTop: true,
    icon: path.join(__dirname, 'logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    },
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden'
  })

  win.setMenuBarVisibility(false)
  win.removeMenu && win.removeMenu()
  win.loadFile('index.html')

  win.once('focus', () => win.flashFrame(false))
  win.flashFrame(true)

  if (app.commandLine.hasSwitch('dev')) {
    win.webContents.openDevTools()
  }

  nativeTheme.themeSource = 'light'

  registerGlobalShortcuts(win)

  win.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault()
      win.hide()
      createTray(win)
    }
  })

  mainWindow = win
}

// =============== 安全退出（确认机制） ===============
function safeQuit(win) {
  if (!win || win.isDestroyed()) {
    app.quit()
    return
  }
  // 设置超时保险
  const timeout = setTimeout(() => {
    console.warn('[Quit] 渲染进程响应超时，强制退出')
    isQuiting = true
    app.quit()
  }, CONFIG.ui.safeQuitTimeout)

  pendingQuitResolve = () => {
    clearTimeout(timeout)
    isQuiting = true
    app.quit()
  }

  // 通知渲染进程结束 session 并发送 'session:ended-for-quit' 确认
  win.webContents.send('global-shortcut', 'end-and-quit')
}

// =============== 托盘 ===============
function createTray(win) {
  if (appTray) return
  const iconPath = path.join(__dirname, 'logo.ico')
  let trayIcon
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
  } catch (err) {
    trayIcon = null
  }

  appTray = new Tray(trayIcon || undefined)
  updateTrayMenu(win)
  appTray.setToolTip('学习时间记录')

  appTray.on('double-click', () => {
    win.show()
  })

  win.on('show', () => {
    if (appTray) {
      appTray.destroy()
      appTray = null
    }
  })
}

// 动态更新托盘菜单（显示今日时长）
async function updateTrayMenu(win) {
  if (!appTray) return
  let todayDurationText = ''
  try {
    const todayInfo = await getTodayStats()
    todayDurationText = `📊 今日: ${formatDurationSimple(todayInfo.totalSeconds)}`
  } catch (e) {
    todayDurationText = '📊 今日学习'
  }

  const contextMenu = Menu.buildFromTemplate([
    { label: todayDurationText, enabled: false },
    { type: 'separator' },
    {
      label: '显示主窗口',
      click: () => win.show()
    },
    {
      label: '退出',
      click: () => safeQuit(win)
    }
  ])
  appTray.setContextMenu(contextMenu)
}

function formatDurationSimple(sec) {
  if (!sec || sec < 0) return '00:00:00'
  const h = String(Math.floor(sec / 3600)).padStart(2, '0')
  const m = String(Math.floor(sec % 3600 / 60)).padStart(2, '0')
  const s = String(sec % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

// =============== 全局快捷键 ===============
function registerGlobalShortcuts(win) {
  const map = [
    [CONFIG.shortcuts.start, () => win.webContents.send('global-shortcut', 'start')],
    [CONFIG.shortcuts.end, () => win.webContents.send('global-shortcut', 'end')],
    [CONFIG.shortcuts.quit, () => safeQuit(win)],
    [CONFIG.shortcuts.closeWindow, () => win.close()],
    [CONFIG.shortcuts.showWindow, () => win.show()],
    [CONFIG.shortcuts.toggleMiniMode, () => win.webContents.send('global-shortcut', 'toggleMiniMode')],
    [CONFIG.shortcuts.toggleTheme, () => win.webContents.send('global-shortcut', 'toggleTheme')]
  ]

  for (const [key, handler] of map) {
    const ok = globalShortcut.register(key, handler)
    if (!ok) console.warn(`[Shortcut] 注册失败: ${key}`)
  }
}

// =============== IPC: 窗口控制（迷你模式） ===============
let miniMode = false
const MINI_SIZE = { width: 300, height: 58 }
const NORMAL_SIZE = CONFIG.ui.window.normal
let savedNormalBounds = null  // 记忆正常模式下的位置和大小
let savedMiniBounds = null    // 记忆迷你模式下的位置

ipcMain.handle('window:set-mini-mode', async (event, enable) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return false
  const target = !!enable
  if (target === miniMode) return true  // 状态相同，无需切换

  if (target) {
    // 进入迷你模式：保存当前位置和大小
    const [x, y] = win.getPosition()
    const [w, h] = win.getSize()
    savedNormalBounds = { x, y, width: w, height: h }

    win.setResizable(true)
    win.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height)
    win.setMaximumSize(9999, 9999)
    win.setSize(MINI_SIZE.width, MINI_SIZE.height)
    win.setResizable(false)

    // 恢复上次迷你模式的位置，否则吸附到屏幕右上角
    if (savedMiniBounds) {
      win.setPosition(savedMiniBounds.x, savedMiniBounds.y)
    } else {
      const screens = require('electron').screen
      const cursor = screens.getCursorScreenPoint()
      const display = screens.getDisplayNearestPoint(cursor)
      const bx = display.bounds.x + display.bounds.width - MINI_SIZE.width - 20
      const by = display.bounds.y + 60
      win.setPosition(Math.round(bx), Math.round(by))
    }
  } else {
    // 退出迷你模式：保存当前迷你模式位置，恢复正常模式
    const [x, y] = win.getPosition()
    savedMiniBounds = { x, y }

    win.setResizable(true)
    win.setMinimumSize(NORMAL_SIZE.width, NORMAL_SIZE.height)
    win.setMaximumSize(9999, CONFIG.ui.window.maxHeight)
    win.setSize(NORMAL_SIZE.width, NORMAL_SIZE.height)
    win.setResizable(false)

    if (savedNormalBounds) {
      // 恢复之前正常模式的位置
      win.setPosition(savedNormalBounds.x, savedNormalBounds.y)
    }
  }

  miniMode = target
  win.setAlwaysOnTop(true)
  win.webContents.send('window:mini-mode-changed', miniMode)
  return true
})

ipcMain.handle('window:get-mini-mode', async () => {
  return miniMode
})

// 最小化到托盘
ipcMain.handle('window:minimize', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) {
    win.hide()
    createTray(win)
  }
  return true
})

// 安全关闭（结束 session 后退出）
ipcMain.handle('window:close', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win) safeQuit(win)
  return true
})

// =============== 辅助：统计区间核心算法 ===============
/**
 * 根据 timeRange 配置，返回 now 所在"统计日"的起止时间
 * timeRange: { start: 'HH:mm', end: 'HH:mm' }
 *   - start === end → 整个 24 小时统计周期（如 05:00-05:00 表示当日 5 点到次日 5 点）
 *   - start < end  → 同一日内的子区间（如 09:00-22:00）
 *   - start > end  → 跨午夜的区间（如 22:00-05:00）
 */
function computeRangeBounds(now, timeRange) {
  const [sh, sm] = timeRange.start.split(':').map(Number)
  const [eh, em] = timeRange.end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  const nowMin = now.getHours() * 60 + now.getMinutes()

  // 跨午夜或满 24 小时：endMin <= startMin
  const crossMidnight = endMin <= startMin

  const startOfDay = new Date(now)
  startOfDay.setHours(sh, sm, 0, 0)
  startOfDay.setMilliseconds(0)

  if (crossMidnight && nowMin < startMin) {
    // 当前时间还没到今天的 start 时刻，归属上一个周期 → start 是昨天
    startOfDay.setDate(startOfDay.getDate() - 1)
  }

  const endOfDay = new Date(startOfDay)
  if (crossMidnight) {
    endOfDay.setDate(endOfDay.getDate() + 1)
  }
  endOfDay.setHours(eh, em, 0, 0)
  endOfDay.setMilliseconds(0)

  return { start: startOfDay, end: endOfDay }
}

/**
 * 返回一个偏移 dayOffset 个统计日的边界
 * dayOffset = 0 是今日；-1 是昨日
 */
function computeRangeBoundsForOffset(now, timeRange, dayOffset) {
  const today = computeRangeBounds(now, timeRange)
  const start = new Date(today.start)
  start.setDate(start.getDate() + dayOffset)
  const end = new Date(today.end)
  end.setDate(end.getDate() + dayOffset)
  return { start, end }
}

async function getTimeRange() {
  const row = await getOne(
    `SELECT value FROM user_config WHERE key = 'stat_time_range'`
  )
  if (row && row.value) {
    try { return JSON.parse(row.value) } catch (e) {}
  }
  return CONFIG.defaults.statTimeRange
}

// =============== 辅助：今日统计 ===============
async function getTodayStats() {
  const timeRange = await getTimeRange()
  const now = new Date()
  const bounds = computeRangeBounds(now, timeRange)

  const rows = await getAll(
    `SELECT start_time, duration FROM study_sessions WHERE end_time IS NOT NULL`
  )
  let totalSeconds = 0
  let sessionCount = 0
  rows.forEach(r => {
    const st = parseDbTime(r.start_time)
    if (st >= bounds.start && st < bounds.end) {
      totalSeconds += r.duration || 0
      sessionCount += 1
    }
  })

  return {
    totalSeconds,
    sessionCount,
    startOfDay: bounds.start,
    endOfDay: bounds.end,
    timeRange
  }
}

// =============== IPC: 学习记录 ===============
ipcMain.handle('study:start-session', async (event, startTime) => {
  const result = await runSql(
    'INSERT INTO study_sessions (start_time) VALUES (?)',
    [startTime]
  )
  return result.lastID
})

ipcMain.handle('study:end-session', async (event, { id, endTime }) => {
  const row = await getOne('SELECT start_time FROM study_sessions WHERE id = ?', [id])
  if (!row) throw new Error('记录不存在')

  const start = parseDbTime(row.start_time)
  const end = parseDbTime(endTime)
  const duration = Math.floor((end - start) / 1000)

  await runSql(
    'UPDATE study_sessions SET end_time = ?, duration = ? WHERE id = ?',
    [endTime, duration, id]
  )

  // 更新累计统计
  await updateAccumulatedStats(duration)

  // 更新连续打卡
  await updateStreak(end)

  // 检查并解锁徽章
  await checkAndUnlockBadges()

  // 更新托盘
  if (appTray && mainWindow) {
    updateTrayMenu(mainWindow)
  }

  return { success: true, duration }
})

ipcMain.handle('study:get-all-sessions', async () => {
  return getAll(`SELECT s.*, GROUP_CONCAT(t.name) AS tag_names, GROUP_CONCAT(t.color) AS tag_colors, GROUP_CONCAT(t.id) AS tag_ids
    FROM study_sessions s
    LEFT JOIN session_tags st ON st.session_id = s.id
    LEFT JOIN study_tags t ON t.id = st.tag_id
    GROUP BY s.id
    ORDER BY s.start_time DESC`)
})

ipcMain.handle('study:delete-session', async (event, { id }) => {
  const result = await runSql('DELETE FROM study_sessions WHERE id = ?', [id])
  return {
    success: result.changes > 0,
    affectedRows: result.changes,
    message: result.changes > 0 ? '删除成功' : '未找到对应记录'
  }
})

ipcMain.handle('study:update-note', async (event, { id, note }) => {
  const text = String(note || '').slice(0, 500) // 上限 500 字
  const result = await runSql(
    'UPDATE study_sessions SET note = ? WHERE id = ?',
    [text, id]
  )
  return { success: result.changes > 0, note: text }
})

// =============== IPC: 词条 ===============
ipcMain.handle('study:get-word', async () => {
  if (!words.length) return ''
  return words[Math.floor(Math.random() * words.length)]
})

// =============== IPC: 寄语管理 ===============
ipcMain.handle('quote:get-all', async () => {
  return getAll(`SELECT * FROM study_quotes ORDER BY id ASC`)
})

ipcMain.handle('quote:add', async (event, content) => {
  if (!content || !content.trim()) throw new Error('内容不能为空')
  await runSql(
    `INSERT INTO study_quotes(content, enabled) VALUES (?, 1)`,
    [content.trim()]
  )
  // 刷新内存缓存
  await loadWordsFromDB()
  return true
})

ipcMain.handle('quote:delete', async (event, { id }) => {
  await runSql(`DELETE FROM study_quotes WHERE id = ?`, [id])
  // 刷新内存缓存
  await loadWordsFromDB()
  return true
})

ipcMain.handle('quote:refresh', async () => {
  await loadWordsFromDB()
  return words.length
})

// =============== IPC: 配置 ===============
ipcMain.handle('study:get-config', async (event, key) => {
  const row = await getOne('SELECT value FROM user_config WHERE key = ?', [key])
  return row ? row.value : undefined
})

ipcMain.handle('study:set-config', async (event, key, value) => {
  await runSql(
    'INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)',
    [key, value]
  )
  return true
})

ipcMain.handle('study:get-all-config', async () => {
  const rows = await getAll('SELECT key, value FROM user_config')
  const obj = {}
  rows.forEach(r => { obj[r.key] = r.value })
  return obj
})

// =============== IPC: 标签 ===============
ipcMain.handle('tag:get-all', async () => {
  return getAll('SELECT * FROM study_tags ORDER BY sort_order ASC, id ASC')
})

ipcMain.handle('tag:create', async (event, { name, color, icon }) => {
  const result = await runSql(
    'INSERT INTO study_tags(name, color, icon) VALUES (?, ?, ?)',
    [name, color || '#7e9fff', icon || '']
  )
  return result.lastID
})

ipcMain.handle('tag:update', async (event, { id, name, color, icon }) => {
  await runSql(
    'UPDATE study_tags SET name = ?, color = ?, icon = ? WHERE id = ?',
    [name, color, icon, id]
  )
  return true
})

ipcMain.handle('tag:delete', async (event, { id }) => {
  await runSql('DELETE FROM study_tags WHERE id = ?', [id])
  return true
})

ipcMain.handle('tag:assign-to-session', async (event, { sessionId, tagIds }) => {
  await runSql('DELETE FROM session_tags WHERE session_id = ?', [sessionId])
  for (const tagId of tagIds) {
    await runSql(
      'INSERT OR IGNORE INTO session_tags(session_id, tag_id) VALUES (?, ?)',
      [sessionId, tagId]
    )
  }
  return true
})

// =============== IPC: 统计与可视化 ===============
ipcMain.handle('stats:today', async () => {
  return getTodayStats()
})

ipcMain.handle('stats:week', async () => {
  const timeRange = await getTimeRange()
  const now = new Date()
  // 一次性查询所有数据（避免循环 7 次 SQL）
  const allRows = await getAll(
    `SELECT start_time, duration FROM study_sessions WHERE end_time IS NOT NULL`
  )

  const result = []
  for (let i = 6; i >= 0; i--) {
    const bounds = computeRangeBoundsForOffset(now, timeRange, -i)
    let secs = 0
    allRows.forEach(r => {
      const st = parseDbTime(r.start_time)
      if (st >= bounds.start && st < bounds.end) {
        secs += r.duration || 0
      }
    })

    // bounds.start 是统计日是期，格式化为展示标签
    const d = bounds.start
    result.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      seconds: secs,
      label: `${d.getMonth() + 1}/${d.getDate()}`
    })
  }
  return result
})

ipcMain.handle('stats:heatmap', async (event, days = 35) => {
  const timeRange = await getTimeRange()
  const now = new Date()
  const allRows = await getAll(
    `SELECT start_time, duration FROM study_sessions WHERE end_time IS NOT NULL`
  )

  const result = []
  for (let i = days - 1; i >= 0; i--) {
    const bounds = computeRangeBoundsForOffset(now, timeRange, -i)
    let secs = 0
    allRows.forEach(r => {
      const st = parseDbTime(r.start_time)
      if (st >= bounds.start && st < bounds.end) {
        secs += r.duration || 0
      }
    })
    const d = bounds.start
    result.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      seconds: secs
    })
  }
  return result
})

// IPC：向渲染进程提供当前统计区间边界（用于保持 renderer 与 main 计算一致）
ipcMain.handle('stats:today-boundaries', async () => {
  const timeRange = await getTimeRange()
  const now = new Date()
  const bounds = computeRangeBounds(now, timeRange)
  return {
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString(),
    timeRange
  }
})

// =============== 累计统计 / 连续打卡 / 徽章 ===============
// 实时从 study_sessions 表聚合「累计时长 / 总记录数 / 最长连续天数」——
// 比 user_config KV 缓存更可靠（中途删过/改过数据也能正确反映）
ipcMain.handle('stats:overview', async () => {
  // 总记录数 + 累计时长（只统计已结束的 session）
  const sumRow = await getOne(
    `SELECT
       COUNT(*) AS total_sessions,
       COALESCE(SUM(duration), 0) AS total_seconds
     FROM study_sessions
     WHERE end_time IS NOT NULL`
  )
  const totalSessions = sumRow ? sumRow.total_sessions : 0
  const totalSeconds = sumRow ? sumRow.total_seconds : 0

  // 最长连续学习天数：取出去重后的"学习日期"列表，按相邻日期差 = 1 累计
  const dateRows = await getAll(
    `SELECT DISTINCT substr(start_time, 1, 10) AS day
     FROM study_sessions
     WHERE end_time IS NOT NULL
     ORDER BY day ASC`
  )
  let maxStreak = 0
  let currentStreak = 0
  let lastDay = null
  const ONE_DAY = 24 * 60 * 60 * 1000
  for (const r of dateRows) {
    if (!r.day) continue
    const d = parseDbTime(`${r.day} 00:00:00`)
    if (!lastDay) {
      currentStreak = 1
    } else {
      const diffDays = Math.round((d - lastDay) / ONE_DAY)
      if (diffDays === 1) currentStreak += 1
      else if (diffDays > 1) currentStreak = 1
      // diffDays === 0 重复日（理论上 DISTINCT 已经去重），不计
    }
    if (currentStreak > maxStreak) maxStreak = currentStreak
    lastDay = d
  }

  return { totalSessions, totalSeconds, maxStreak }
})

async function updateAccumulatedStats(addedSeconds) {
  try {
    const row = await getOne(`SELECT value FROM user_config WHERE key = 'total_study_seconds'`)
    const oldTotal = row ? parseInt(row.value, 10) || 0 : 0
    const newTotal = oldTotal + addedSeconds
    await runSql(
      `INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
      ['total_study_seconds', String(newTotal)]
    )
    // 累计 session 数
    const cntRow = await getOne(`SELECT value FROM user_config WHERE key = 'total_sessions'`)
    const oldCnt = cntRow ? parseInt(cntRow.value, 10) || 0 : 0
    await runSql(
      `INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
      ['total_sessions', String(oldCnt + 1)]
    )
  } catch (e) {
    console.error('[Stats] 更新累计失败:', e.message)
  }
}

async function updateStreak(endTime) {
  try {
    const today = endTime || new Date()
    const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    const lastRow = await getOne(`SELECT value FROM user_config WHERE key = 'last_study_date'`)
    const lastDate = lastRow ? lastRow.value : ''

    if (lastDate === todayKey) return  // 今天已计过

    const streakRow = await getOne(`SELECT value FROM user_config WHERE key = 'current_streak'`)
    let currentStreak = streakRow ? parseInt(streakRow.value, 10) || 0 : 0

    if (lastDate) {
      const lastD = new Date(lastDate)
      const diffDays = Math.floor((today - lastD) / (24 * 60 * 60 * 1000))
      if (diffDays === 1) {
        currentStreak += 1
      } else if (diffDays > 1) {
        currentStreak = 1  // 断签，重新开始
      }
    } else {
      currentStreak = 1
    }

    await runSql(`INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
      ['current_streak', String(currentStreak)])
    await runSql(`INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
      ['last_study_date', todayKey])

    // 更新历史最长
    const maxRow = await getOne(`SELECT value FROM user_config WHERE key = 'max_streak'`)
    const maxStreak = maxRow ? parseInt(maxRow.value, 10) || 0 : 0
    if (currentStreak > maxStreak) {
      await runSql(`INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
        ['max_streak', String(currentStreak)])
    }
  } catch (e) {
    console.error('[Streak] 更新失败:', e.message)
  }
}

// 徽章定义
const BADGE_DEFINITIONS = [
  {
    id: 'first_session', name: '初学乍练', icon: '🌱',
    desc: '完成第一次学习记录',
    check: async () => {
      const r = await getOne(`SELECT value FROM user_config WHERE key = 'total_sessions'`)
      return r && parseInt(r.value, 10) >= 1
    }
  },
  {
    id: 'streak_7', name: '一周坚持', icon: '🔥',
    desc: '连续学习 7 天',
    check: async () => {
      const r = await getOne(`SELECT value FROM user_config WHERE key = 'current_streak'`)
      return r && parseInt(r.value, 10) >= 7
    }
  },
  {
    id: 'streak_30', name: '月度大师', icon: '👑',
    desc: '连续学习 30 天',
    check: async () => {
      const r = await getOne(`SELECT value FROM user_config WHERE key = 'max_streak'`)
      return r && parseInt(r.value, 10) >= 30
    }
  },
  {
    id: 'total_100h', name: '百日磨剑', icon: '🏆',
    desc: '累计学习 100 小时',
    check: async () => {
      const r = await getOne(`SELECT value FROM user_config WHERE key = 'total_study_seconds'`)
      return r && parseInt(r.value, 10) >= 100 * 3600
    }
  },
  {
    id: 'total_1000h', name: '千锤百炼', icon: '💎',
    desc: '累计学习 1000 小时',
    check: async () => {
      const r = await getOne(`SELECT value FROM user_config WHERE key = 'total_study_seconds'`)
      return r && parseInt(r.value, 10) >= 1000 * 3600
    }
  },
  {
    id: 'single_8h', name: '闪电突击', icon: '⚡',
    desc: '单日学习超过 8 小时',
    check: async () => {
      const today = await getTodayStats()
      return today.totalSeconds >= 8 * 3600
    }
  },
  {
    id: 'early_bird', name: '早起学者', icon: '🌅',
    desc: '在 6:00 之前开始学习',
    check: async () => {
      const rows = await getAll(`SELECT start_time FROM study_sessions WHERE end_time IS NOT NULL`)
      return rows.some(r => {
        const d = parseDbTime(r.start_time)
        return d.getHours() < 6
      })
    }
  },
  {
    id: 'night_owl', name: '夜猫子', icon: '🌙',
    desc: '在 23:00 之后开始学习',
    check: async () => {
      const rows = await getAll(`SELECT start_time FROM study_sessions WHERE end_time IS NOT NULL`)
      return rows.some(r => {
        const d = parseDbTime(r.start_time)
        return d.getHours() >= 23
      })
    }
  }
]

async function checkAndUnlockBadges() {
  try {
    const earnedRow = await getOne(`SELECT value FROM user_config WHERE key = 'earned_badges'`)
    let earned = []
    if (earnedRow && earnedRow.value) {
      try { earned = JSON.parse(earnedRow.value) } catch (e) { earned = [] }
    }

    const newBadges = []
    for (const badge of BADGE_DEFINITIONS) {
      if (earned.includes(badge.id)) continue
      try {
        const ok = await badge.check()
        if (ok) {
          earned.push(badge.id)
          newBadges.push(badge)
        }
      } catch (e) {
        // ignore single badge check errors
      }
    }

    if (newBadges.length > 0) {
      await runSql(`INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
        ['earned_badges', JSON.stringify(earned)])
      // 通知渲染进程
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('badge:unlocked', newBadges)
      }
    }
  } catch (e) {
    console.error('[Badge] 检查失败:', e.message)
  }
}

ipcMain.handle('badge:get-all', async () => {
  const earnedRow = await getOne(`SELECT value FROM user_config WHERE key = 'earned_badges'`)
  let earned = []
  if (earnedRow && earnedRow.value) {
    try { earned = JSON.parse(earnedRow.value) } catch (e) {}
  }
  return BADGE_DEFINITIONS.map(b => ({
    id: b.id,
    name: b.name,
    icon: b.icon,
    desc: b.desc,
    earned: earned.includes(b.id)
  }))
})

// =============== IPC: 数据导出 ===============
ipcMain.handle('data:export', async (event, format) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const fileExt = format === 'json' ? 'json' : 'csv'
  const filename = `study_records_${new Date().toISOString().substring(0, 10)}.${fileExt}`

  const result = await dialog.showSaveDialog(win, {
    title: '导出学习记录',
    defaultPath: filename,
    filters: [
      { name: format === 'json' ? 'JSON' : 'CSV', extensions: [fileExt] }
    ]
  })

  if (result.canceled || !result.filePath) {
    return { success: false, canceled: true }
  }

  const sessions = await getAll(`SELECT s.*, GROUP_CONCAT(t.name) AS tags
    FROM study_sessions s
    LEFT JOIN session_tags st ON st.session_id = s.id
    LEFT JOIN study_tags t ON t.id = st.tag_id
    GROUP BY s.id
    ORDER BY s.start_time ASC`)

  let content = ''
  if (format === 'json') {
    content = JSON.stringify({
      exportedAt: new Date().toISOString(),
      total: sessions.length,
      sessions
    }, null, 2)
  } else {
    // CSV
    const headers = ['id', '开始时间', '结束时间', '时长(秒)', '时长(格式化)', '标签', '备注']
    const lines = [headers.join(',')]
    sessions.forEach(s => {
      const cols = [
        s.id,
        `"${s.start_time || ''}"`,
        `"${s.end_time || ''}"`,
        s.duration || 0,
        `"${formatDurationSimple(s.duration || 0)}"`,
        `"${s.tags || ''}"`,
        `"${(s.note || '').replace(/"/g, '""')}"`
      ]
      lines.push(cols.join(','))
    })
    content = '﻿' + lines.join('\n')  // 带 BOM 让 Excel 识别 UTF-8
  }

  fs.writeFileSync(result.filePath, content, 'utf-8')
  return { success: true, path: result.filePath, count: sessions.length }
})

// =============== IPC: 应用元信息 ===============
ipcMain.handle('app:get-version', () => app.getVersion())

// =============== IPC: 通知 ===============
ipcMain.handle('app:notify', (event, opts = {}) => {
  try {
    const notif = new Notification({
      title: opts.title || '学习时间记录',
      body: opts.body || '',
      silent: !!opts.silent,
      icon: path.join(__dirname, 'logo.ico')
    })
    notif.show()
    return true
  } catch (e) {
    console.error('系统通知失败:', e.message)
    return false
  }
})

// =============== IPC: 主题 ===============
ipcMain.handle('app:set-theme', async (event, theme) => {
  await runSql(
    'INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)',
    ['theme', theme]
  )
  return true
})

// =============== IPC: 安全退出确认 ===============
ipcMain.on('session:end-confirmed-for-quit', () => {
  if (pendingQuitResolve) {
    pendingQuitResolve()
    pendingQuitResolve = null
  }
})

// =============== 应用生命周期 ===============
app.on('before-quit', () => {
  isQuiting = true
})

app.whenReady().then(async () => {
  try {
    await initDatabase()
    await loadWordsFromDB()
    createWindow()
    initAutoUpdater(() => mainWindow)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  } catch (e) {
    console.error('[Init] 启动失败:', e.message)
    dialog.showErrorBox('启动失败', `应用初始化失败:\n${e.message}`)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  if (db) {
    db.close((err) => {
      if (err) console.error('[DB] 关闭失败:', err.message)
    })
  }
})
