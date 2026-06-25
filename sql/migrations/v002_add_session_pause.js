module.exports = {
  version: 2,
  description: 'add pause state to study sessions',

  async up(db) {
    const run = (sql, params = []) => new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err)
        else resolve(this)
      })
    })

    const all = (sql, params = []) => new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err)
        else resolve(rows)
      })
    })

    const columns = await all(`PRAGMA table_info(study_sessions)`)
    const names = new Set(columns.map(col => col.name))

    if (!names.has('paused_at')) {
      await run(`ALTER TABLE study_sessions ADD COLUMN paused_at TEXT`)
    }

    if (!names.has('paused_duration')) {
      await run(`ALTER TABLE study_sessions ADD COLUMN paused_duration INTEGER DEFAULT 0`)
    }
  }
}
