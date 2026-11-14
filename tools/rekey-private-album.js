'use strict'

// 就地更换私密相册信封的口令：解密旧信封 -> 用新口令重新封装，正文（照片 base64）保持不变。
// 与 tools/private-album.js 使用同一套参数（PBKDF2-SHA256 / 210000 迭代 / AES-256-GCM）。
//
// 用法：
//   OLD_ALBUM_PASSWORD="旧口令" NEW_ALBUM_PASSWORD="新口令" \
//     node tools/rekey-private-album.js source/album/private/Secret.json
//
// 注意：改口令不能代替「把明文从发布目录里拿走」。如果照片同时还在 source/images/ 下，
// 换多强的口令都没有意义 —— 请先确认 tools/check-leaks.js 通过。

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const target = process.argv[2] ? path.resolve(process.argv[2]) : null
const oldPassword = process.env.OLD_ALBUM_PASSWORD
const newPassword = process.env.NEW_ALBUM_PASSWORD
const iterations = 210000

if (!target || !oldPassword || !newPassword) {
  console.error('用法: OLD_ALBUM_PASSWORD=... NEW_ALBUM_PASSWORD=... node tools/rekey-private-album.js <信封.json>')
  process.exit(1)
}
if (newPassword.length < 12) {
  console.error('新口令至少 12 位（建议 20 位以上随机串，不要用品牌词/纯数字）')
  process.exit(1)
}

function deriveKey (password, salt) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256')
}

function decrypt (envelope, password) {
  const salt = Buffer.from(envelope.salt, 'base64')
  const iv = Buffer.from(envelope.iv, 'base64')
  const raw = Buffer.from(envelope.data, 'base64')
  const key = deriveKey(password, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(raw.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(0, -16)), decipher.final()]).toString('utf8'))
}

function encrypt (payload, password) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(password, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    version: 1,
    algorithm: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64')
  }
}

const envelope = JSON.parse(fs.readFileSync(target, 'utf8'))

let payload
try {
  payload = decrypt(envelope, oldPassword)
} catch (error) {
  console.error(`旧口令无法解开 ${path.relative(root, target)}（${error.message}）`)
  process.exit(1)
}

const rekeyed = encrypt(payload, newPassword)

// 自检：新信封必须能用新口令解回同一份正文
const verify = decrypt(JSON.parse(JSON.stringify(rekeyed)), newPassword)
if (JSON.stringify(verify) !== JSON.stringify(payload)) {
  console.error('自检失败：重新封装后的正文与原文不一致，已放弃写入')
  process.exit(1)
}

fs.writeFileSync(target, `${JSON.stringify(rekeyed)}\n`)
console.log(`已更换口令: ${path.relative(root, target)}（${payload.photos.length} 张照片，${payload.name}）`)
