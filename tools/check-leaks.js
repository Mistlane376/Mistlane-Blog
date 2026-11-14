'use strict'

/**
 * 发布物泄露自检。
 *
 * 背景：站点的「私密相册」采用客户端加密，信封（/album/private/*.json）本来就公开，
 * 真正的访问控制完全依赖「明文照片不出现在任何发布路径」。历史事故（2026-11）正是
 * 因为私密照片同时被 git 跟踪在 source/images/ 下、随构建进入 public/images/ 而失效。
 *
 * 本脚本在 `hexo generate` 之后运行，用哈希比对而不是靠文件名黑名单来判定：
 *   1) 私密相册明文源（private-albums/*.json 的 file 字段）必须位于 source/ 之外；
 *   2) private-albums/photos/ 下任何一张照片的 SHA-256 都不得出现在 public/ 中；
 *   3) 发布物里不得出现浏览器凭据/环境变量之类的敏感文件；
 *   4) source/images/ 下的零引用图片只作提示，不阻断构建。
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')
const sourceDir = path.join(root, 'source')
const privateDir = path.join(root, 'private-albums')

const failures = []
const warnings = []
const passes = []

const assert = (condition, message) => {
  if (condition) passes.push(message)
  else failures.push(message)
}

const walk = (dir, filter) => {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return []
      return walk(full, filter)
    }
    return filter(full) ? [full] : []
  })
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const rel = file => path.relative(root, file).split(path.sep).join('/')

// --- 1) 私密相册明文源不得放在会参与构建的 source/ 里 ---
const albumSources = fs.existsSync(privateDir)
  ? fs.readdirSync(privateDir).filter(name => name.endsWith('.json')).map(name => path.join(privateDir, name))
  : []

for (const albumFile of albumSources) {
  const album = JSON.parse(fs.readFileSync(albumFile, 'utf8'))
  for (const photo of album.photos || []) {
    const resolved = path.resolve(path.dirname(albumFile), String(photo.file || ''))
    assert(
      !resolved.startsWith(sourceDir + path.sep),
      `${rel(albumFile)} 的照片源不得位于 source/ 内（当前: ${rel(resolved)}）`
    )
    assert(fs.existsSync(resolved), `${rel(albumFile)} 的照片源存在（${rel(resolved)}）`)
  }
}

// --- 2) 私密照片的哈希不得出现在源码树或发布物中 ---
// 哈希来源：本地 private-albums/photos/（开发机）+ tools/private-photo-hashes.json（入库，CI 也生效）
const privateHashes = new Map()

const manifestPath = path.join(__dirname, 'private-photo-hashes.json')
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const entry of manifest.hashes || []) {
    if (entry && entry.sha256) privateHashes.set(String(entry.sha256).toLowerCase(), entry.note || '私密照片')
  }
}

const localPrivatePhotos = walk(path.join(privateDir, 'photos'), () => true)
  .filter(file => /\.(jpe?g|png|webp|gif|avif)$/i.test(file))
for (const file of localPrivatePhotos) {
  privateHashes.set(sha256(file), rel(file))
}

if (privateHashes.size === 0) {
  warnings.push('未找到任何私密照片哈希，跳过比对（tools/private-photo-hashes.json 缺失且 private-albums/photos/ 为空）')
} else {
  const scanned = walk(sourceDir, () => true)
    .concat(walk(publicDir, () => true))
    .filter(file => /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)$/i.test(file))

  const leaked = scanned.filter(file => privateHashes.has(sha256(file)))
  assert(
    leaked.length === 0,
    leaked.length === 0
      ? `源码树与发布物中均不含 ${privateHashes.size} 张私密照片（哈希比对）`
      : `发现私密照片出现在可发布路径：${leaked.map(file => `${rel(file)} ≡ ${privateHashes.get(sha256(file))}`).join('; ')}`
  )
}

// --- 3) 发布物里不得有浏览器凭据 / 环境变量 / 私钥 ---
const forbiddenPattern = /(^|\/)(Login Data|Login Data For Account|Cookies|Cookies-journal|History|Web Data|Local State|Preferences|\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.sqlite3?)$/i
const browserProfileDirs = /(^|\/)\.(chrome|edge|chromium|firefox)[^/]*\//i

const candidateFiles = walk(publicDir, () => true).concat(walk(path.join(root, 'source'), () => true))
const suspicious = candidateFiles.filter(file => {
  const relative = rel(file)
  return forbiddenPattern.test(relative) || browserProfileDirs.test(relative)
})
assert(
  suspicious.length === 0,
  `源码树与发布物中不含凭据类文件：${suspicious.length === 0 ? '通过' : suspicious.map(rel).join(', ')}`
)

// --- 4) source/images 零引用图片（提示，不阻断）---
const imagesDir = path.join(sourceDir, 'images')
const rootConfigs = fs.readdirSync(root)
  .filter(name => /\.(yml|yaml)$/i.test(name))
  .map(name => path.join(root, name))
const textFiles = walk(sourceDir, file => /\.(md|json|yml|yaml|styl|css|js|html|ejs|njk|pug)$/i.test(file))
  .concat(walk(path.join(root, 'themes'), file => /\.(styl|css|js|ejs|njk|pug|html|yml|yaml)$/i.test(file)))
  .concat(walk(path.join(root, 'scripts'), file => /\.js$/i.test(file)))
  .concat(rootConfigs)

const corpus = textFiles.map(file => fs.readFileSync(file, 'utf8')).join('\n')
const unreferenced = walk(imagesDir, file => /\.(jpe?g|png|webp|gif|avif|svg)$/i.test(file))
  .filter(file => !corpus.includes(path.basename(file)))
  .map(file => `${rel(file)} (${(fs.statSync(file).size / 1024).toFixed(0)}KB)`)

if (unreferenced.length > 0) {
  warnings.push(`source/images 下有 ${unreferenced.length} 张零引用图片，建议确认是否需要公开：\n    ${unreferenced.join('\n    ')}`)
}

// --- 输出 ---
for (const pass of passes) console.log(`  ✓ ${pass}`)
for (const warning of warnings) console.log(`  ! ${warning}`)

if (failures.length > 0) {
  console.error('\n✗ 泄露自检未通过：')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}

console.log(`\n✓ 泄露自检通过（${passes.length} 项）`)
