// 把 electron-builder 打包产物（exe 安装包 + latest.yml）一次性 POST 到部署服务器。
// 用法：
//   node scripts/upload-release.js
//   node scripts/upload-release.js --url=http://your.host/upload   # 覆盖 config 中的 URL
//
// 服务器接口约定（multipart/form-data, 一次 POST）：
//   - 字段 `setup`  : 安装包 .exe
//   - 字段 `latest` : latest.yml 更新元信息
//   - 字段 `version`: 当前版本号字符串（便于服务端归档）
//
// 依赖：仅 Node 内置（fetch / Blob / FormData / fs / path），Node 18+
// 如果你的 Node < 18，请改用 ssh2-sftp-client 或 axios + form-data

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const CONFIG = require(path.join(ROOT, 'config.js'))
const pkg = require(path.join(ROOT, 'package.json'))

// 允许命令行参数覆盖：--url=...
const cliArgs = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...rest] = a.replace(/^--/, '').split('=')
      return [k, rest.join('=')]
    })
)
const UPLOAD_URL = cliArgs.url || (CONFIG.deploy && CONFIG.deploy.uploadUrl)
const TIMEOUT_MS = (CONFIG.deploy && CONFIG.deploy.timeoutMs) || 5 * 60 * 1000

if (!UPLOAD_URL) {
  console.error('[upload] 缺少 uploadUrl 配置，请在 config.js -> deploy.uploadUrl 设置')
  process.exit(1)
}
if (typeof fetch !== 'function' || typeof FormData !== 'function' || typeof Blob !== 'function') {
  console.error('[upload] 需要 Node 18+ 的 fetch / FormData / Blob 全局支持')
  console.error('[upload] 当前 Node 版本:', process.version)
  process.exit(1)
}

const distDir = path.join(ROOT, 'dist')
// electron-builder NSIS 默认产物名：`<productName> Setup <version>.exe`
// productName 在 package.json.build.productName 配置（"学习时间记录"）
const productName = (pkg.build && pkg.build.productName) || pkg.name
const setupName = `${productName} Setup ${pkg.version}.exe`
const setupPath = path.join(distDir, setupName)
const latestPath = path.join(distDir, 'latest.yml')

function bail(msg) {
  console.error('[upload] ' + msg)
  process.exit(1)
}

if (!fs.existsSync(setupPath)) {
  bail(`未找到安装包：${setupPath}\n请先执行 npm run dist`)
}
if (!fs.existsSync(latestPath)) {
  bail(`未找到 latest.yml：${latestPath}\n请确认 electron-builder publish 配置已生效`)
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function fileToBlob(filePath) {
  const buf = fs.readFileSync(filePath)
  return new Blob([buf])
}

async function main() {
  const setupSize = fs.statSync(setupPath).size
  const latestSize = fs.statSync(latestPath).size

  console.log('[upload] 目标:', UPLOAD_URL)
  console.log('[upload] 版本:', `v${pkg.version}`)
  console.log('[upload] 安装包:', setupName, `(${fmtSize(setupSize)})`)
  console.log('[upload] latest.yml:', `(${fmtSize(latestSize)})`)

  const form = new FormData()
  form.append('version', pkg.version)
  form.append('setup', fileToBlob(setupPath), setupName)
  form.append('latest', fileToBlob(latestPath), 'latest.yml')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const startedAt = Date.now()
  try {
    const res = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal
    })
    clearTimeout(timer)

    const text = await res.text()
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (!res.ok) {
      console.error(`[upload] 上传失败 HTTP ${res.status} (耗时 ${elapsed}s)`)
      console.error('[upload] 响应:', text)
      process.exit(1)
    }
    console.log(`[upload] 上传成功 (耗时 ${elapsed}s)`)
    if (text) console.log('[upload] 响应:', text)
  } catch (e) {
    clearTimeout(timer)
    if (e.name === 'AbortError') {
      bail(`上传超时 (${TIMEOUT_MS / 1000}s)`)
    }
    bail(`上传出错: ${e.message}`)
  }
}

main()
