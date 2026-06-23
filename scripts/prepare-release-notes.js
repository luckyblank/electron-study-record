// 打包前调用：根据 package.json.version 从 release-notes/v{version}.md 拷贝到 release-notes.md
// electron-builder 的 releaseInfo.releaseNotesFile 不支持模板，所以用"间接层"做版本路由

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const version = pkg.version

const dir = path.join(ROOT, 'release-notes')
const versionFile = path.join(dir, `v${version}.md`)
const outFile = path.join(ROOT, 'release-notes.md')

if (!fs.existsSync(versionFile)) {
  console.error(`[prepare-release-notes] 未找到 release-notes/v${version}.md`)
  console.error(`[prepare-release-notes] 请先创建该文件再打包，或更新 package.json.version`)
  process.exit(1)
}

const content = fs.readFileSync(versionFile, 'utf8')
fs.writeFileSync(outFile, content)
console.log(`[prepare-release-notes] v${version} → release-notes.md (${content.length} chars)`)
