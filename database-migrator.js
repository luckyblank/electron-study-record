// 数据库迁移管理器：版本检测、备份、增量迁移、失败回滚
const path = require('node:path')
const fs = require('node:fs')

// 自动扫描 sql/migrations/ 目录加载迁移脚本
// 文件名约定: v{NNN}_xxx.js (例: v001_initial.js, v012_add_foo.js)
// 文件 export 的 version 字段必须与文件名前缀的数字一致
function loadMigrations() {
  const dir = path.join(__dirname, 'sql', 'migrations')
  const files = fs.readdirSync(dir)
    .filter(f => /^v\d+_.+\.js$/i.test(f))
    .sort() // 文件名带 0 填充，字符串排序即版本顺序

  const list = []
  for (const file of files) {
    const fileVersion = parseInt(file.match(/^v(\d+)_/i)[1], 10)
    const mod = require(path.join(dir, file))
    if (typeof mod.version !== 'number') {
      throw new Error(`[Migration] ${file} 缺少 version 字段`)
    }
    if (mod.version !== fileVersion) {
      throw new Error(`[Migration] ${file} 的 version (${mod.version}) 与文件名 (v${fileVersion}) 不一致`)
    }
    if (typeof mod.up !== 'function') {
      throw new Error(`[Migration] ${file} 缺少 up() 方法`)
    }
    list.push(mod)
  }

  // 校验版本连续递增，避免漏号 / 重号
  for (let i = 0; i < list.length; i++) {
    if (list[i].version !== i + 1) {
      throw new Error(`[Migration] 版本不连续：期望 v${i + 1}，实际 v${list[i].version}`)
    }
  }

  return list
}

const migrations = loadMigrations()


function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err)
      else resolve(this)
    })
  })
}

function getOne(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err)
      else resolve(row)
    })
  })
}

// 获取当前数据库版本（未初始化或无版本记录则视为 0）
async function getCurrentVersion(db) {
  try {
    const row = await getOne(db,
      "SELECT value FROM user_config WHERE key = 'db_schema_version'"
    )
    if (!row) return 0  // 全新库：user_config 表存在但无该 key
    const v = parseInt(row.value, 10)
    return isNaN(v) ? 0 : v
  } catch (e) {
    // user_config 表不存在或查询失败
    return 0
  }
}

async function setVersion(db, version) {
  await runSql(db,
    `INSERT OR REPLACE INTO user_config(key, value) VALUES (?, ?)`,
    ['db_schema_version', String(version)]
  )
}

function backupDatabase(dbPath, version) {
  // 中国时间 (UTC+8) 的 YYYYMMDDHHMM 格式
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  const pad = n => String(n).padStart(2, '0')
  const timestamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes())
  const backupPath = `${dbPath}.backup_v${version}_${timestamp}`
  if (fs.existsSync(dbPath)) {
    fs.copyFileSync(dbPath, backupPath)
  }
  return backupPath
}

function restoreFromBackup(dbPath, backupPath) {
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, dbPath)
    return true
  }
  return false
}

// 清理超过指定天数的旧备份
function cleanOldBackups(dbDir, retainDays = 30) {
  try {
    if (!fs.existsSync(dbDir)) return
    const now = Date.now()
    const cutoff = retainDays * 24 * 60 * 60 * 1000
    fs.readdirSync(dbDir).forEach(file => {
      if (file.includes('.backup_v')) {
        const filePath = path.join(dbDir, file)
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > cutoff) {
          fs.unlinkSync(filePath)
          console.log(`[DB] 清理过期备份: ${file}`)
        }
      }
    })
  } catch (e) {
    console.warn('[DB] 清理旧备份失败:', e.message)
  }
}

/**
 * 执行所有未应用的迁移
 * @param {sqlite3.Database} db
 * @param {string} dbPath
 * @param {number} targetVersion 当前代码支持的最新版本
 * @returns {Promise<{success: boolean, migratedFrom?: number, migratedTo?: number, error?: string, restored?: boolean}>}
 */
async function runMigrations(db, dbPath, targetVersion) {
  const currentVersion = await getCurrentVersion(db)
  const finalTarget = targetVersion || migrations.length

  console.log(`[DB Migration] 当前版本: v${currentVersion}, 目标版本: v${finalTarget}`)

  if (currentVersion >= finalTarget) {
    return { success: true, isLatest: true, version: currentVersion }
  }

  // 迁移前自动备份
  let backupPath = null
  try {
    backupPath = backupDatabase(dbPath, currentVersion)
    if (backupPath && fs.existsSync(backupPath)) {
      console.log(`[DB Migration] 已备份: ${path.basename(backupPath)}`)
    }
  } catch (e) {
    console.warn('[DB Migration] 备份失败但继续迁移:', e.message)
  }

  try {
    // 从 currentVersion+1 跑到 finalTarget（含）。
    // migrations 数组索引 0 对应 v1：所以 v 版本对应 migrations[v-1]
    for (let v = currentVersion + 1; v <= finalTarget; v++) {
      const migration = migrations[v - 1]
      if (!migration) {
        throw new Error(`缺少 v${v} 的迁移脚本`)
      }
      console.log(`[DB Migration] 执行 v${v - 1} → v${v}: ${migration.description}`)
      await migration.up(db)
      await setVersion(db, v)
      console.log(`[DB Migration] v${v} 完成 ✓`)
    }

    // 清理旧备份
    cleanOldBackups(path.dirname(dbPath), 30)

    return {
      success: true,
      isLatest: false,
      migratedFrom: currentVersion,
      migratedTo: finalTarget
    }
  } catch (error) {
    console.error('[DB Migration] 失败:', error.message)
    let restored = false
    if (backupPath && fs.existsSync(backupPath)) {
      try {
        restored = restoreFromBackup(dbPath, backupPath)
        console.log('[DB Migration] 已从备份恢复')
      } catch (restoreErr) {
        console.error('[DB Migration] 恢复失败:', restoreErr.message)
      }
    }
    return {
      success: false,
      error: error.message,
      restored
    }
  }
}

module.exports = {
  runMigrations,
  getCurrentVersion,
  setVersion
}
