// 应用全局常量配置

const CONFIG = {
  // 数据库相关
  db: {
    // 生产环境数据库文件名（打包后使用）
    fileName: 'study_time.db',
    // 开发环境数据库文件名（npm run start 时使用，互不干扰）
    fileNameDev: 'study_time.dev.db',
    timeout: 5000,
    backupRetainDays: 30,
    // 当前代码支持的最新数据库版本
    targetSchemaVersion: 2
  },

  // UI 相关
  ui: {
    historyRefreshInterval: 2 * 60 * 1000, // 2分钟
    todayUpdateInterval: 1000,             // 1秒
    notificationThreshold: 2 * 60 * 60,    // 2小时（秒）
    safeQuitTimeout: 2000,                 // 安全退出最大等待时间
    window: {
      normal: { width: 420, height: 248 },
      maxHeight: 560
    }
  },

  // 默认设置
  defaults: {
    statTimeRange: { start: '05:00', end: '05:00' },
    dailyGoalSeconds: 2 * 60 * 60,    // 默认日目标 2 小时
    weeklyGoalSeconds: 10 * 60 * 60,  // 默认周目标 10 小时
    theme: 'light'                     // light / dark / eyecare
  },

  // 快捷键（默认值，未来可从配置读取）
  shortcuts: {
    start: 'Ctrl+Alt+S',
    end: 'Ctrl+Alt+E',
    showWindow: 'Ctrl+Alt+1',
    closeWindow: 'Ctrl+Alt+2',
    quit: 'Ctrl+Alt+Q',
    pause: 'Ctrl+Alt+P',
    toggleMiniMode: 'Ctrl+Alt+M',
    toggleTheme: 'Ctrl+Alt+T'
  },

  // 番茄钟默认配置
  pomodoro: {
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    cyclesBeforeLongBreak: 4
  },

  // 发版上传配置（scripts/upload-release.js 使用）
  deploy: {
    // 服务器接收上传的接口（multipart/form-data, POST）
    // 期望接受两个文件字段：setup（exe 安装包）和 latest（latest.yml 更新元信息）
    // 本地开发：http://127.0.0.1:8089/upload-api/study-time-record/release
    // 本地部署：http://127.0.0.1:8888/upload-api/study-time-record/release
    // 服务器：http://www.luckyblank.cn/upload-api/study-time-record/release
    // 检测更新地址（本地部署）：http://127.0.0.1:8888/study-time-record/updates/
    // 检测更新地址（服务器部署）：http://www.luckyblank.cn/study-time-record/updates/
    uploadUrl: 'http://www.luckyblank.cn/upload-api/study-time-record/release',
    // 上传超时（毫秒）
    timeoutMs: 5 * 60 * 1000
  }
}

module.exports = CONFIG
