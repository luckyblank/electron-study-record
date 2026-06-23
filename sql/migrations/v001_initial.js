// v1 基线版本：合并自原 v001-v005
// 包含完整初始 schema：核心表 + 标签系统 + 索引 + 默认配置 + 徽章/番茄钟/健康提醒配置
//
// 注意：study_sessions 的时间字段统一使用 "YYYY-MM-DD HH:mm:ss"（中国时间，无时区后缀）
// 由 renderer 的 toChinaTimeString() 写入，main 进程的 parseDbTime() 读取
function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

module.exports = {
  version: 1,
  description: '初始基线：核心表 + 标签 + 目标 + 徽章 + 配置',
  up: async (db) => {
    // ============ 核心表 ============
    await runSql(db, `CREATE TABLE IF NOT EXISTS study_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration INTEGER,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)

    await runSql(db, `CREATE TABLE IF NOT EXISTS user_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )`)

    // ============ 标签系统 ============
    await runSql(db, `CREATE TABLE IF NOT EXISTS study_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT DEFAULT '#7e9fff',
      icon TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)

    await runSql(db, `CREATE TABLE IF NOT EXISTS session_tags (
      session_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (session_id, tag_id),
      FOREIGN KEY (session_id) REFERENCES study_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES study_tags(id) ON DELETE CASCADE
    )`)

    // ============ 寄语表 ============
    await runSql(db, `CREATE TABLE IF NOT EXISTS study_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)

    // ============ 索引 ============
    await runSql(db, `CREATE INDEX IF NOT EXISTS idx_study_sessions_start_time
      ON study_sessions(start_time)`)
    await runSql(db, `CREATE INDEX IF NOT EXISTS idx_session_tags_tag_id
      ON session_tags(tag_id)`)

    // ============ 预置默认标签 ============
    const defaultTags = [
      { name: '通用学习', color: '#7e9fff', icon: '📚', sort: 1 },
      { name: '编程开发', color: '#67c23a', icon: '💻', sort: 2 },
      { name: '阅读',     color: '#f4a261', icon: '📖', sort: 3 },
      { name: '语言学习', color: '#e76f51', icon: '🗣️', sort: 4 }
    ]
    for (const tag of defaultTags) {
      await runSql(db,
        `INSERT OR IGNORE INTO study_tags(name, color, icon, sort_order) VALUES (?, ?, ?, ?)`,
        [tag.name, tag.color, tag.icon, tag.sort]
      )
    }

    // ============ 预置默认寄语 ============
    const defaultQuotes = [
    ' 前路漫漫亦灿灿，万事皆有回甘'
      ,'心怀微光，自能奔赴万丈晴朗'
      ,'慢慢沉淀，终会遇见更好自己'
      ,'纵有风雨，心藏山海自有温柔'
      ,'以渺小启程，以努力奔赴盛大'
      ,'不必借光而行，你我亦是星辰'
      ,'沉下心赶路，时光自有馈赠'
      ,'且将新火试新茶，诗酒趁年华'
      ,'追风赶月莫停留，平芜尽处是春山'
      ,'手持烟火谋生，心怀诗意前行'
      ,'踏过荆棘长路，终拥繁花满途'
      ,'保持热爱，奔赴下一场山海'
      ,'前路自有繁花，当下只管耕耘'
      ,'不惧岁月漫长，自有来日荣光'
      ,'积攒温柔力量，对抗世间风霜'
      ,'凡心所向素履以往，万事皆可期待'
    ]
    for (const content of defaultQuotes) {
      await runSql(db,
        `INSERT OR IGNORE INTO study_quotes(content, enabled) VALUES (?, 1)`,
        [content]
      )
    }

    // ============ 默认配置（合并 v3 + v4） ============
    const defaultConfigs = [
      // 学习目标 / 累计统计 / 连续打卡
      ['daily_goal_seconds',  '7200'],   // 默认 2 小时
      ['weekly_goal_seconds', '36000'],  // 默认 10 小时
      ['current_streak',      '0'],
      ['max_streak',          '0'],
      ['last_study_date',     ''],
      ['total_study_seconds', '0'],
      ['total_sessions',      '0'],
      // 徽章 / 主题 / 番茄钟 / 健康提醒
      ['earned_badges',              '[]'],
      ['user_level',                 '1'],
      ['theme',                      'light'],
      ['pomodoro_enabled',           '0'],
      ['pomodoro_work_min',          '25'],
      ['pomodoro_short_break_min',   '5'],
      ['pomodoro_long_break_min',    '15'],
      ['pomodoro_cycles',            '4'],
      ['health_reminders_enabled',   '1']
    ]
    for (const [key, value] of defaultConfigs) {
      await runSql(db,
        `INSERT OR IGNORE INTO user_config(key, value) VALUES (?, ?)`,
        [key, value]
      )
    }
  },
  down: async () => {
    // 基线版本不支持降级
  }
}
