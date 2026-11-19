import { onMount } from '../lib/lifecycle'
import { countUp } from '../lib/anim'

const ACCENTS = ['var(--ui-teal)', 'var(--ui-coral)', 'var(--ui-blue)', 'var(--ui-plum)']

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

const domainOf = href => {
  try {
    return href ? new URL(href, window.location.href).hostname.replace(/^www\./, '') : ''
  } catch (_) {
    return ''
  }
}

const formatMs = value => {
  const n = Number(value) || 0
  if (!n) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`
}

const pad2 = n => String(n).padStart(2, '0')

const parseDate = iso => {
  const date = iso ? new Date(iso) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

const formatCheckedShort = iso => {
  const date = parseDate(iso)
  return date ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}` : ''
}

const formatCheckedFull = iso => {
  const date = parseDate(iso)
  return date ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` : ''
}

// 跳转目标与原始链接不同时，才在卡片上显示「跳到哪儿」。
const normalizeUrl = value => {
  try {
    const parsed = new URL(value, window.location.href)
    return `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname.replace(/\/$/, '')}`
  } catch (_) {
    return ''
  }
}

// 卡片上只放「结论 + 码 + 耗时」，检测时间/Server/跳转这些次要信息走悬停浮层。
let statusTip = null
let tipGlobalsBound = false

const ensureStatusTip = () => {
  if (statusTip && statusTip.isConnected) return statusTip
  statusTip = document.createElement('div')
  statusTip.className = 'flink-status-tip'
  statusTip.setAttribute('role', 'tooltip')
  document.body.append(statusTip)
  return statusTip
}

const hideStatusTip = () => {
  if (statusTip) statusTip.classList.remove('is-visible')
}

const showStatusTip = (item, anchor) => {
  const ds = item.dataset
  const status = ds.linkStatus || 'unknown'
  if (status !== 'up' && status !== 'down') return

  const finalUrl = ds.linkFinal || ''
  const server = ds.linkServer || ''
  const ownHref = item.querySelector('a')?.getAttribute('href') || ''
  const rows = [
    ds.linkChecked ? `<span class="flink-status-tip-row">检测于 ${escapeHtml(formatCheckedFull(ds.linkChecked))}</span>` : '',
    server ? `<span class="flink-status-tip-row is-muted">Server ${escapeHtml(server)}</span>` : '',
    finalUrl && normalizeUrl(finalUrl) !== normalizeUrl(ownHref)
      ? `<span class="flink-status-tip-row is-url is-muted">跳转 ${escapeHtml(finalUrl)}</span>`
      : ''
  ].filter(Boolean)
  if (!rows.length) return

  const tip = ensureStatusTip()
  tip.innerHTML = rows.join('')
  tip.classList.add('is-visible')

  const rect = anchor.getBoundingClientRect()
  const width = tip.offsetWidth
  const height = tip.offsetHeight
  let left = rect.left + rect.width / 2 - width / 2
  let top = rect.top - height - 10
  if (top < 8) top = rect.bottom + 10
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
}

const copyText = async text => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (_) {
    // Fall through to the legacy path when the clipboard API is unavailable.
  }
  try {
    const helper = document.createElement('textarea')
    helper.value = text
    helper.setAttribute('readonly', '')
    helper.style.position = 'fixed'
    helper.style.opacity = '0'
    document.body.append(helper)
    helper.select()
    const ok = document.execCommand('copy')
    helper.remove()
    return ok
  } catch (_) {
    return false
  }
}

const initializeExchangeCopy = page => {
  page.querySelectorAll('.link-exchange-code').forEach(block => {
    const pre = block.querySelector('pre')
    if (!pre || block.querySelector('.link-exchange-copy')) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'link-exchange-copy'
    button.innerHTML = '<i class="fas fa-copy" aria-hidden="true"></i><span>复制</span>'
    button.addEventListener('click', async () => {
      const clone = pre.cloneNode(true)
      clone.querySelectorAll('br').forEach(lineBreak => lineBreak.replaceWith('\n'))
      const ok = await copyText(clone.textContent.trim())
      button.classList.toggle('is-done', ok)
      button.innerHTML = ok
        ? '<i class="fas fa-check" aria-hidden="true"></i><span>已复制</span>'
        : '<i class="fas fa-xmark" aria-hidden="true"></i><span>复制失败</span>'
      window.clearTimeout(button.restoreTimer)
      button.restoreTimer = window.setTimeout(() => {
        button.classList.remove('is-done')
        button.innerHTML = '<i class="fas fa-copy" aria-hidden="true"></i><span>复制</span>'
      }, 1800)
    })
    block.append(button)
  })
}

const initializeLinkDirectory = () => {
  const page = document.querySelector('.type-link')
  const directory = page?.querySelector('.flink')
  if (!directory || directory.dataset.directoryReady === 'true') return
  directory.dataset.directoryReady = 'true'

  const lists = [...directory.querySelectorAll('.flink-list')]
  const items = []
  const categories = []

  lists.forEach((list, listIndex) => {
    const heading = list.previousElementSibling?.previousElementSibling
    const category = heading?.tagName === 'H2' ? heading.textContent.trim() : `友链 ${listIndex + 1}`
    const categoryItems = [...list.querySelectorAll('.flink-list-item')]
    if (!categoryItems.length) return
    categories.push({ name: category, count: categoryItems.length, list })
    categoryItems.forEach(item => {
      item.dataset.linkCategory = category
      items.push(item)
    })
  })

  if (!items.length) return

  const domains = new Set()

  items.forEach((item, index) => {
    const anchor = item.querySelector('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    const domain = domainOf(href)
    if (domain) domains.add(domain)
    const name = item.querySelector('.flink-item-name')?.textContent.trim() || anchor.getAttribute('title') || domain || '这位朋友'
    const description = item.querySelector('.flink-item-desc')?.textContent.trim()
    const avatar = item.querySelector('.flink-item-icon img')?.getAttribute('src') || '/img/friend_404.gif'
    // 状态由构建期写入 data-link-*（GitHub Action 定时检测），重建 DOM 时据此渲染。
    // 不能只靠服务端渲染：本函数会把 <a> 的 innerHTML 整个替换掉。
    const status = item.dataset.linkStatus || 'unknown'
    const code = item.dataset.linkCode || ''
    const statusText = item.dataset.linkText || ''
    const errorName = item.dataset.linkError || ''
    const ms = item.dataset.linkMs || ''

    const codeLabel = Number(code) > 0
      ? `HTTP ${code}${statusText ? ` ${statusText}` : ''}`
      : errorName === 'timeout'
        ? '请求超时'
        : errorName
          ? `错误 ${errorName}`
          : '无响应'

    const statusBadge = status === 'up' || status === 'down'
      ? `<span class="flink-item-status is-${status}" aria-label="${status === 'down' ? '暂时无法访问' : '在线'}"></span>`
      : ''

    // 卡片上只留一行结论；检测时间 / Server / 跳转放悬停浮层。
    const statusPanel = status === 'up' || status === 'down'
      ? `<span class="flink-item-status-panel">
          <span class="flink-status-verdict is-${status}">${status === 'up' ? '在线' : '离线'}</span>
          <span class="flink-status-fact">${escapeHtml(codeLabel)}</span>
          <span class="flink-status-fact" title="响应耗时">${formatMs(ms)}</span>
        </span>`
      : ''

    item.style.setProperty('--link-index', String(index))
    item.style.setProperty('--link-accent', ACCENTS[index % ACCENTS.length])
    item.classList.toggle('is-down', status === 'down')
    anchor.innerHTML = `
      <span class="flink-item-icon"><img class="no-lightbox" src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.onerror=null;this.src='/img/friend_404.gif'"></span>
      <span class="flink-item-body">
        <span class="flink-item-head">
          <span class="flink-item-name">${escapeHtml(name)}</span>
          ${domain ? `<span class="flink-item-domain">${escapeHtml(domain)}</span>` : ''}
          ${statusBadge}
        </span>
        <span class="flink-item-desc" title="${escapeHtml(description || '')}">${escapeHtml(description || '这位朋友还没有写简介。')}</span>
        ${statusPanel}
      </span>
      <span class="flink-item-visit" aria-hidden="true"><i class="fas fa-arrow-right"></i></span>
    `
  })

  const heroCopy = document.createElement('div')
  heroCopy.className = 'link-directory-hero-copy'
  heroCopy.innerHTML = `
    <div class="link-directory-hero-text">
      <span class="link-directory-kicker"><i class="fas fa-link" aria-hidden="true"></i> FRIEND LINK DIRECTORY</span>
      <h1>友链</h1>
      <p>收藏值得长期回访的个人站点与创作空间。</p>
    </div>
    <div class="link-directory-stats" role="group" aria-label="友链统计">
      <div><strong data-stat="links">0</strong><em>个友链</em></div>
      <div><strong data-stat="types">0</strong><em>种类型</em></div>
      <div><strong data-stat="domains">0</strong><em>个独立域名</em></div>
    </div>
  `
  countUp(heroCopy.querySelector('[data-stat="links"]'), items.length)
  countUp(heroCopy.querySelector('[data-stat="types"]'), categories.length)
  countUp(heroCopy.querySelector('[data-stat="domains"]'), domains.size)

  categories.forEach(entry => {
    const section = document.createElement('header')
    section.className = 'link-directory-section-heading'
    section.innerHTML = `<div><span>LINK COLLECTION</span><h2>${escapeHtml(entry.name)}</h2></div><small>${entry.count} 个站点</small>`
    entry.list.before(section)
  })

  // 顶部检测汇总：全部由每张卡的 data-* 聚合，不需要额外请求。
  const knownItems = items.filter(item => item.dataset.linkStatus === 'up' || item.dataset.linkStatus === 'down')
  let summaryBar = null
  if (knownItems.length) {
    const upItems = items.filter(item => item.dataset.linkStatus === 'up')
    const downItems = items.filter(item => item.dataset.linkStatus === 'down')
    const durations = upItems.map(item => Number(item.dataset.linkMs || 0)).filter(n => n > 0)
    const avg = durations.length ? Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length) : 0
    let latest = ''
    knownItems.forEach(item => {
      const checked = item.dataset.linkChecked || ''
      if (checked > latest) latest = checked
    })
    summaryBar = document.createElement('div')
    summaryBar.className = 'flink-status-summary'
    summaryBar.innerHTML = `
      <span class="flink-status-summary-title"><i class="fas fa-heart-pulse" aria-hidden="true"></i> 友链状态</span>
      <span class="flink-status-chip is-up"><i></i>${upItems.length} 在线</span>
      <span class="flink-status-chip is-down"><i></i>${downItems.length} 离线</span>
      <span class="flink-status-chip">平均 ${formatMs(avg)}</span>
      <span class="flink-status-chip is-time">最后检测 ${formatCheckedShort(latest)}</span>
    `
  }

  directory.prepend(heroCopy)
  if (summaryBar) heroCopy.after(summaryBar)

  // 悬停状态行看补充信息（检测时间 / Server / 跳转）。事件委托绑在 .flink 上，卡片重建后依然有效。
  directory.addEventListener('pointerover', event => {
    const anchor = event.target.closest('.flink-item-status-panel, .flink-item-status')
    if (!anchor) return
    const item = anchor.closest('.flink-list-item')
    if (item) showStatusTip(item, anchor)
  })
  directory.addEventListener('pointerout', event => {
    if (event.target.closest('.flink-item-status-panel, .flink-item-status')) hideStatusTip()
  })
  if (!tipGlobalsBound) {
    tipGlobalsBound = true
    window.addEventListener('scroll', hideStatusTip, { passive: true })
    window.addEventListener('resize', hideStatusTip)
  }

  initializeExchangeCopy(page)
}

onMount(initializeLinkDirectory)
