#!/usr/bin/env node
/**
 * 本地校验 Vercel 部署所需的三个值是否可用 —— 不用推送、不用等 Action 跑。
 *
 * 三种喂值方式（优先级从高到低）：
 *   1. 环境变量：VERCEL_TOKEN / VERCEL_ORG_ID / VERCEL_PROJECT_ID
 *   2. 仓库根目录的 .env.local（已被 .gitignore 的 .env* 覆盖，不会入库）
 *   3. 无 —— 只做格式检查，并提示哪几个缺
 *
 * 用法：
 *   node tools/verify-vercel-secrets.mjs
 *   VERCEL_TOKEN=xxx node tools/verify-vercel-secrets.mjs
 *
 * 退出码：0 = 全部通过；1 = 有缺失或校验失败。
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW = path.join(ROOT, '.github/workflows/deploy-vercel.yml')
const ENV_FILE = path.join(ROOT, '.env.local')

const NAMES = ['VERCEL_TOKEN', 'VERCEL_ORG_ID', 'VERCEL_PROJECT_ID']

const green = s => `\u001b[32m${s}\u001b[0m`
const red = s => `\u001b[31m${s}\u001b[0m`
const dim = s => `\u001b[2m${s}\u001b[0m`
const bold = s => `\u001b[1m${s}\u001b[0m`

/** 解析 .env.local 这种 KEY=VALUE 的简单格式 */
const readEnvFile = file => {
  const out = {}
  if (!existsSync(file)) return out
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return out
}

const fromFile = readEnvFile(ENV_FILE)
const value = name => (process.env[name] || fromFile[name] || '').trim()

const mask = v => (v.length <= 8 ? '*'.repeat(v.length) : `${v.slice(0, 4)}${'*'.repeat(Math.min(v.length - 8, 24))}${v.slice(-4)}`)

let failed = false
const fail = msg => {
  failed = true
  console.log(`  ${red('✗')} ${msg}`)
}
const pass = msg => console.log(`  ${green('✓')} ${msg}`)
const warn = msg => console.log(`  ${dim('–')} ${msg}`)

console.log(bold('\n[1/4] 取值来源'))
for (const name of NAMES) {
  const source = process.env[name] ? '环境变量' : fromFile[name] ? '.env.local' : null
  if (source) pass(`${name} 来自${source}（${value(name).length} 字符）`)
  else warn(`${name} 未提供`)
}
if (!process.env.VERCEL_TOKEN && fromFile.VERCEL_TOKEN) {
  console.log(dim('  提示：令牌以明文存在 .env.local，该文件已被 .gitignore 忽略；用完建议删除。'))
}

console.log(bold('\n[2/4] 格式检查'))
for (const name of NAMES) {
  const v = value(name)
  if (!v) {
    fail(`${name} 缺失`)
    continue
  }
  if (name === 'VERCEL_ORG_ID') {
    if (/^(team|user)_[\w-]{8,}$/.test(v)) pass(`VERCEL_ORG_ID 形如 ${v.slice(0, 5)}…（长度 ${v.length}）`)
    else fail(`VERCEL_ORG_ID 格式可疑："${mask(v)}" —— 应以 team_ 或 user_ 开头`)
  } else if (name === 'VERCEL_PROJECT_ID') {
    if (/^prj_[\w-]{8,}$/.test(v)) pass(`VERCEL_PROJECT_ID 形如 prj_…（长度 ${v.length}）`)
    else fail(`VERCEL_PROJECT_ID 格式可疑："${mask(v)}" —— 应以 prj_ 开头`)
  } else {
    if (v.length >= 20) pass(`VERCEL_TOKEN 长度 ${v.length}，形如 ${mask(v)}`)
    else fail(`VERCEL_TOKEN 太短（${v.length} 字符），Vercel 令牌通常 24 位左右`)
  }
}

console.log(bold('\n[3/4] Vercel API 校验'))
const token = value('VERCEL_TOKEN')
const orgId = value('VERCEL_ORG_ID')
const projectId = value('VERCEL_PROJECT_ID')

const api = async url => {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000)
    })
    let body = null
    try {
      body = await res.json()
    } catch {
      /* 非 JSON 响应 */
    }
    return { status: res.status, body }
  } catch (error) {
    return { status: 0, body: null, error }
  }
}

let account = ''
let projectName = ''

if (!token) {
  warn('没有令牌，跳过 API 校验（无法确认密钥是否真的生效）')
} else {
  const me = await api('https://api.vercel.com/v2/user')
  if (me.status === 200) {
    account = me.body?.user?.username || me.body?.user?.email || ''
    pass(`令牌有效，账号 ${account || '(未返回用户名)'}`)
  } else {
    const reason = me.body?.error?.message || me.body?.message || me.error?.message || ''
    fail(`令牌无效：HTTP ${me.status}${reason ? ` / ${reason}` : ''}`)
  }

  if (me.status === 200 && orgId && projectId) {
    const isTeam = orgId.startsWith('team_')
    const qs = isTeam ? `?teamId=${encodeURIComponent(orgId)}` : ''
    const proj = await api(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}${qs}`)
    if (proj.status === 200) {
      projectName = proj.body?.name || ''
      pass(`项目可访问：${projectName || projectId}`)
      const linked = proj.body?.accountId || proj.body?.teamId || ''
      if (linked && orgId && linked !== orgId) {
        fail(`项目归属 (${linked}) 与 VERCEL_ORG_ID 不一致，部署会报 scope 错误`)
      } else if (linked) {
        pass('项目归属与 VERCEL_ORG_ID 一致')
      }
    } else {
      const reason = proj.body?.error?.message || proj.body?.message || proj.error?.message || ''
      fail(`项目查询失败：HTTP ${proj.status}${reason ? ` / ${reason}` : ''}（ORG_ID 与 PROJECT_ID 可能不属于同一团队）`)
    }
  }
}

console.log(bold('\n[4/4] 工作流引用的密钥名'))
if (existsSync(WORKFLOW)) {
  const yml = readFileSync(WORKFLOW, 'utf8')
  const referenced = [...new Set([...yml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))]
  const unknown = referenced.filter(n => !NAMES.includes(n))
  if (unknown.length) fail(`工作流还引用了未在文档中说明的密钥：${unknown.join(', ')}`)
  else pass(`工作流引用 ${referenced.length} 个密钥：${referenced.join(', ')}`)
  if (!yml.includes('name: Verify secrets')) warn('工作流里没有「Verify secrets」自检步骤，建议保留')
} else {
  warn(`找不到 ${path.relative(ROOT, WORKFLOW)}`)
}

console.log('')
if (!token && !orgId && !projectId) {
  console.log('结论：三个值都没拿到，无法校验。')
  console.log(dim('用法一（临时）：VERCEL_TOKEN=你的令牌 node tools/verify-vercel-secrets.mjs'))
  console.log(dim('用法二（复用）：把三行写进仓库根目录 .env.local，之后直接 node tools/verify-vercel-secrets.mjs'))
  console.log(dim('   VERCEL_TOKEN=...'))
  console.log(dim('   VERCEL_ORG_ID=team_...'))
  console.log(dim('   VERCEL_PROJECT_ID=prj_...'))
  process.exit(1)
}
if (failed) {
  console.log(red('结论：有问题，见上面 ✗ 项。'))
  console.log(dim('常见原因：令牌被撤销 / ORG_ID 与 PROJECT_ID 不是同一个团队 / 复制时带了空格或换行。'))
  process.exit(1)
}
if (!token) {
  console.log(dim('结论：格式没问题，但未提供令牌，无法确认是否可用。'))
  console.log(dim('补一次真实校验：VERCEL_TOKEN=你的令牌 node tools/verify-vercel-secrets.mjs'))
  process.exit(0)
}
console.log(green(`结论：三个值都可用${account ? `（账号 ${account}` : ''}${projectName ? `，项目 ${projectName}）` : account ? '）' : ''}。`))
console.log(dim('注意：这只验证「值是对的」，GitHub 上是否填进 Secrets 还需看仓库 Settings → Secrets → Actions 是否列出这三个名字。'))
