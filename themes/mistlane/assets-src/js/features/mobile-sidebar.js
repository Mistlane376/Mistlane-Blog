// Mobile drawer behaviour.
//
// main.js owns the open/close animation; this module only mirrors that state
// onto <html> so CSS can push ambient layers and the floating music dock below
// the drawer, lock the page behind it, and restores everything after a PJAX
// navigation (which replaces the drawer but not the <html> element).
import { onMount } from '../lib/lifecycle'

const ROOT_CLASS = 'mobile-sidebar-open'
let observedDrawer = null
let observer = null
let delegationBound = false

const isOpen = () => Boolean(document.getElementById('sidebar-menus')?.classList.contains('open'))

const normalize = path => {
  try {
    const url = new URL(path, window.location.origin)
    let p = url.pathname.replace(/\/+$/, '') || '/'
    if (p.length > 1 && p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length) || '/'
    return p
  } catch (_) {
    return path
  }
}

// Mark the drawer entry matching the current page. Longest-href wins so that
// e.g. /link/ does not also highlight a hypothetical / link on the index.
const highlightCurrent = () => {
  const current = normalize(window.location.pathname)
  const links = document.querySelectorAll('#sidebar-menus .menus_items a.site-page[href]')
  let best = null
  let bestLength = -1
  links.forEach(link => {
    link.classList.remove('is-current')
    const href = normalize(link.getAttribute('href'))
    if (href !== current) return
    if (href.length > bestLength) {
      best = link
      bestLength = href.length
    }
  })
  best?.classList.add('is-current')
}

const syncState = () => {
  const open = isOpen()
  const root = document.documentElement
  root.classList.toggle(ROOT_CLASS, open)
  // Lock the page behind the drawer; the drawer itself stays scrollable.
  root.style.overflow = open ? 'hidden' : ''
}

const bindDrawer = () => {
  const drawer = document.getElementById('sidebar-menus')
  if (!drawer) return
  if (observedDrawer !== drawer) {
    observer?.disconnect()
    observer = new MutationObserver(syncState)
    observer.observe(drawer, { attributes: true, attributeFilter: ['class'] })
    observedDrawer = drawer
  }
  syncState()
}

const closeDrawer = () => {
  const drawer = document.getElementById('sidebar-menus')
  if (drawer?.classList.contains('open')) drawer.classList.remove('open')
  syncState()
  // Let main.js clean up its own bookkeeping (scroll padding, internal flag).
  const mask = document.getElementById('menu-mask')
  mask?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

const bindDelegates = () => {
  if (delegationBound) return
  delegationBound = true

  document.addEventListener('click', event => {
    if (event.target.closest?.('#sidebar-close')) {
      event.preventDefault()
      closeDrawer()
    }
  })

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) closeDrawer()
  })
}

onMount(() => {
  bindDelegates()
  bindDrawer()
  highlightCurrent()
})
