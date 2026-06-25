const { contextBridge, ipcRenderer } = require('electron/renderer')

// IPC 超时包装
function withTimeout(promise, ms = 5000, label = 'IPC') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 调用超时(${ms}ms)`)), ms)
    )
  ])
}

contextBridge.exposeInMainWorld('studyRecord', {
  // ===== Session =====
  startSession: (startTime) =>
    withTimeout(ipcRenderer.invoke('study:start-session', startTime), 5000, 'startSession'),
  endSession: ({ id, endTime }) =>
    withTimeout(ipcRenderer.invoke('study:end-session', { id, endTime }), 5000, 'endSession'),
  pauseSession: ({ id, pausedAt }) =>
    withTimeout(ipcRenderer.invoke('study:pause-session', { id, pausedAt }), 5000, 'pauseSession'),
  resumeSession: ({ id, resumedAt }) =>
    withTimeout(ipcRenderer.invoke('study:resume-session', { id, resumedAt }), 5000, 'resumeSession'),
  getAllSessions: () =>
    withTimeout(ipcRenderer.invoke('study:get-all-sessions'), 8000, 'getAllSessions'),
  deleteSession: ({ id }) =>
    withTimeout(ipcRenderer.invoke('study:delete-session', { id }), 5000, 'deleteSession'),
  updateSessionNote: ({ id, note }) =>
    withTimeout(ipcRenderer.invoke('study:update-note', { id, note }), 3000, 'updateSessionNote'),

  // ===== 词条 =====
  getWord: () =>
    withTimeout(ipcRenderer.invoke('study:get-word'), 3000, 'getWord'),

  // ===== 寄语管理 =====
  quoteGetAll: () =>
    withTimeout(ipcRenderer.invoke('quote:get-all'), 3000, 'quoteGetAll'),
  quoteAdd: (content) =>
    withTimeout(ipcRenderer.invoke('quote:add', content), 3000, 'quoteAdd'),
  quoteDelete: (opts) =>
    withTimeout(ipcRenderer.invoke('quote:delete', opts), 3000, 'quoteDelete'),
  quoteRefresh: () =>
    withTimeout(ipcRenderer.invoke('quote:refresh'), 3000, 'quoteRefresh'),

  // ===== 配置 =====
  getConfig: (key) =>
    withTimeout(ipcRenderer.invoke('study:get-config', key), 3000, 'getConfig'),
  setConfig: (key, value) =>
    withTimeout(ipcRenderer.invoke('study:set-config', key, value), 3000, 'setConfig'),
  getAllConfig: () =>
    withTimeout(ipcRenderer.invoke('study:get-all-config'), 3000, 'getAllConfig'),
  getCurrentStreak: () =>
    withTimeout(ipcRenderer.invoke('study:get-current-streak'), 3000, 'getCurrentStreak'),

  // ===== 标签 =====
  tagGetAll: () =>
    withTimeout(ipcRenderer.invoke('tag:get-all'), 3000, 'tagGetAll'),
  tagCreate: (opts) =>
    withTimeout(ipcRenderer.invoke('tag:create', opts), 3000, 'tagCreate'),
  tagUpdate: (opts) =>
    withTimeout(ipcRenderer.invoke('tag:update', opts), 3000, 'tagUpdate'),
  tagDelete: (opts) =>
    withTimeout(ipcRenderer.invoke('tag:delete', opts), 3000, 'tagDelete'),
  tagAssignToSession: (opts) =>
    withTimeout(ipcRenderer.invoke('tag:assign-to-session', opts), 3000, 'tagAssignToSession'),

  // ===== 统计 =====
  statsToday: () =>
    withTimeout(ipcRenderer.invoke('stats:today'), 5000, 'statsToday'),
  statsWeek: () =>
    withTimeout(ipcRenderer.invoke('stats:week'), 5000, 'statsWeek'),
  statsHeatmap: (days) =>
    withTimeout(ipcRenderer.invoke('stats:heatmap', days), 5000, 'statsHeatmap'),
  statsTodayBoundaries: () =>
    withTimeout(ipcRenderer.invoke('stats:today-boundaries'), 3000, 'statsTodayBoundaries'),
  statsOverview: () =>
    withTimeout(ipcRenderer.invoke('stats:overview'), 5000, 'statsOverview'),

  // ===== 徽章 =====
  badgeGetAll: () =>
    withTimeout(ipcRenderer.invoke('badge:get-all'), 3000, 'badgeGetAll'),

  // ===== 学习宠物 =====
  petGetState: () =>
    withTimeout(ipcRenderer.invoke('pet:get-state'), 3000, 'petGetState'),
  petSaveState: (state) =>
    withTimeout(ipcRenderer.invoke('pet:save-state', state), 3000, 'petSaveState'),
  petCheckUnlocks: () =>
    withTimeout(ipcRenderer.invoke('pet:check-unlocks'), 3000, 'petCheckUnlocks'),

  // ===== 数据导出 =====
  exportData: (format) =>
    withTimeout(ipcRenderer.invoke('data:export', format), 30000, 'exportData'),

  // ===== 通知 =====
  notify: (opts) =>
    withTimeout(ipcRenderer.invoke('app:notify', opts), 3000, 'notify'),

  // ===== 主题 =====
  setTheme: (theme) =>
    withTimeout(ipcRenderer.invoke('app:set-theme', theme), 3000, 'setTheme'),

  // ===== 窗口模式 =====
  setMiniMode: (enable) =>
    withTimeout(ipcRenderer.invoke('window:set-mini-mode', enable), 3000, 'setMiniMode'),
  getMiniMode: () =>
    withTimeout(ipcRenderer.invoke('window:get-mini-mode'), 3000, 'getMiniMode'),
  minimizeWindow: () =>
    withTimeout(ipcRenderer.invoke('window:minimize'), 3000, 'minimizeWindow'),
  closeWindow: () =>
    withTimeout(ipcRenderer.invoke('window:close'), 5000, 'closeWindow'),

  // ===== 自动更新 =====
  checkForUpdates: () =>
    withTimeout(ipcRenderer.invoke('updater:check'), 15000, 'checkForUpdates'),
  showUpdatePrompt: () =>
    withTimeout(ipcRenderer.invoke('updater:show-prompt'), 5000, 'showUpdatePrompt'),
  respondUpdatePrompt: (accepted) =>
    accepted ? withTimeout(ipcRenderer.invoke('updater:start-download'), 30000, 'startDownload') : Promise.resolve(false),
  setUpdateInteractionState: (state) =>
    withTimeout(ipcRenderer.invoke('updater:set-interaction-state', state), 3000, 'setUpdateInteractionState'),
  onUpdaterStatus: (callback) =>
    ipcRenderer.on('updater:status', (_event, payload) => callback(payload)),
  onUpdatePromptRequested: (callback) =>
    ipcRenderer.on('updater:show-prompt-requested', (_event, payload) => callback(payload)),

  // ===== 应用元信息 =====
  getAppVersion: () =>
    withTimeout(ipcRenderer.invoke('app:get-version'), 3000, 'getAppVersion'),

  // ===== 事件监听 =====
  onGlobalShortcut: (callback) =>
    ipcRenderer.on('global-shortcut', (event, action) => callback(action)),
  onBadgeUnlocked: (callback) =>
    ipcRenderer.on('badge:unlocked', (event, badges) => callback(badges)),
  onMiniModeChanged: (callback) =>
    ipcRenderer.on('window:mini-mode-changed', (event, isMini) => callback(isMini)),

  // ===== 安全退出确认 =====
  confirmSessionEndedForQuit: () =>
    ipcRenderer.send('session:end-confirmed-for-quit')
})
