#!/usr/bin/env node
'use strict'

/**
 * 友链可用性检测。
 *
 * 读取 source/_data/link.yml，逐个探测每个友链能否访问，把结果写入
 * source/_data/flink-status.json，供友链页在构建时标注「在线 / 离线」。
 *
 * - 由 .github/workflows/deploy-vercel.yml 在构建前调用；
 * - 本地也可直接跑：node tools/check-friend-links.js
 *
 * 判定规则（对「友链是否还活着」比对「是否完美 200」更合理）：
 *   2xx / 3xx          -> 在线
 *   401 / 403          -> 在线（站点在挡爬虫，但服务本身活着）
 *   404 / 410 / 其它 4xx -> 离线（页面确实不在了）
 *   5xx / 超时 / DNS 失败 -> 离线
 */

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const ROOT = path.resolve(__dirname, '..')
const LINK_FILE = path.join(ROOT, 'source', '_data', 'link.yml')
const OUT_FILE = path.join(ROOT, 'source', '_data', 'flink-status.json')

const TIMEOUT_MS = 15000
const CONCURRENCY = 6
const UA = 'Mozilla/5.0 (compatible; MistlaneFlinkChecker/1.0; +https://blog.mistlane.top/link/)'

const readLinks = () => {
  if (!fs.existsSync(LINK_FILE)) throw new Error(`找不到 ${LINK_FILE}`)
  const groups = yaml.load(fs.readFileSync(LINK_FILE, 'utf8')) || []
  const urls = []
  for (const group of groups) {
    for (const item of group.link_list || []) {
      const url = String(item.link || '').trim()
      if (/^https?:\/\//i.test(url)) urls.push(url)
    }
  }
  return [...new Set(urls)]
}

const isUp = status => {
  if (status >= 500) return false
  if (status === 404 || status === 410) return false
  // 401/403：挡爬虫但服务活着；429：限流，说明站点可达。
  if (status >= 400 && status < 500) return status === 401 || status === 403 || status === 429
  return true
}

const attempt = async url => {
  const started = Date.now()
  const checkedAt = new Date().toISOString()
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    const finalUrl = res.url || url
    return {
      up: isUp(res.status),
      status: res.status,
      statusText: res.statusText || '',
      ms: Date.now() - started,
      checkedAt,
      finalUrl,
      redirected: finalUrl !== url,
      server: (res.headers.get('server') || '').slice(0, 64),
      contentType: (res.headers.get('content-type') || '').split(';')[0].trim().slice(0, 64)
    }
  } catch (error) {
    const name = (error && error.name) || 'Error'
    return {
      up: false,
      status: 0,
      statusText: name,
      ms: Date.now() - started,
      checkedAt,
      error: name === 'TimeoutError' ? 'timeout' : String(name).slice(0, 64)
    }
  }
}

const checkOne = async url => {
  let result = await attempt(url)
  // CI 网络抖动 / 网关 5xx 很常见：只对「连不上 / 5xx」再试一次，
  // 避免把偶发失败记成死链；4xx 是确定性结果，不重试。
  if (!result.up && (result.status === 0 || result.status >= 500)) {
    await new Promise(resolve => setTimeout(resolve, 800))
    result = await attempt(url)
  }
  return result
}

const runPool = async (urls, size) => {
  const results = {}
  let cursor = 0
  const worker = async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++]
      const result = await checkOne(url)
      results[url] = result
      const tag = result.up ? 'UP  ' : 'DOWN'
      console.log(`${tag} ${String(result.status || 'ERR').padStart(3)} ${String(result.ms).padStart(5)}ms  ${url}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, urls.length) || 1 }, worker))
  return results
}

;(async () => {
  const urls = readLinks()
  if (!urls.length) console.warn('[flink] link.yml 里没有可检测的友链')

  const started = Date.now()
  const links = await runPool(urls, CONCURRENCY)
  const entries = Object.entries(links)
  const upEntries = entries.filter(([, r]) => r.up)
  const downEntries = entries.filter(([, r]) => !r.up)
  const durations = upEntries.map(([, r]) => r.ms).filter(ms => ms > 0)
  const avgMs = durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : 0
  const slowest = entries.reduce((acc, [url, r]) => (r.ms > acc.ms ? { url, ms: r.ms } : acc), { url: '', ms: 0 })

  const payload = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: urls.length,
      up: upEntries.length,
      down: downEntries.length,
      avgMs,
      slowest: slowest.url ? { url: slowest.url, ms: slowest.ms } : null,
      downList: downEntries.map(([url]) => url)
    },
    links
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`[flink] ${upEntries.length}/${urls.length} 在线，平均 ${avgMs}ms，耗时 ${Date.now() - started}ms -> ${path.relative(ROOT, OUT_FILE)}`)
})().catch(error => {
  console.error('[flink] 检测失败：', error)
  process.exit(1)
})
