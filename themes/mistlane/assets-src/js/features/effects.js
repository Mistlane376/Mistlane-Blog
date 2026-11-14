import { onMount } from '../lib/lifecycle'
import { readLocal, writeLocal } from '../lib/storage'
// Canvas 雨滴 / 夜空引擎以纯脚本形式挂到 window（见各自文件头注释）。
import './rain-canvas'
import './night-sky-canvas'

const storageKey = 'mistlane-effects-enabled-v2'
const effectsSelector = '.night-sky-canvas-layer, .rain-canvas-layer, .petal-layer, .night-star-layer'
const compactQuery = window.matchMedia('(max-width: 768px)')
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')

let effectsEnabled = readLocal(storageKey, true) !== false
let renderFrame = 0
let rainEngine = null
let nightEngine = null

// 先停掉 rAF / 解绑事件，再移除节点，避免 PJAX / 主题切换后残留循环。
const removeEffects = () => {
  if (rainEngine) {
    rainEngine.destroy()
    rainEngine = null
  }
  if (nightEngine) {
    nightEngine.destroy()
    nightEngine = null
  }
  document.querySelectorAll(effectsSelector).forEach(layer => layer.remove())
}

const reducedMotion = () => reducedMotionQuery.matches || document.documentElement.dataset.reduceMotion === 'true'

// canvas 必须在挂载到 DOM 之后再测量尺寸，因此由 renderEffects 在 append 后调用。
// 日间（浅色主题）下雨；夜间（深色主题）换成 Canvas 2D 的银河星空 + 落花。
const mountRain = canvas => {
  const createRainEngine = window.MistlaneRain && window.MistlaneRain.createRainEngine
  if (!createRainEngine) return
  rainEngine = createRainEngine(canvas, {
    // 博客浅色底（#c6e3eb）需要深冷蓝雨丝才有对比度；氛围层压到很淡，不干扰阅读。
    palette: 'light',
    atmosphere: 0.45,
    density: compactQuery.matches ? 0.00014 : 0.00018
  })
  rainEngine.start()
}

const mountNightSky = canvas => {
  const createNightSkyEngine = window.MistlaneNightSky && window.MistlaneNightSky.createNightSkyEngine
  if (!createNightSkyEngine) return
  const compact = compactQuery.matches
  nightEngine = createNightSkyEngine(canvas, {
    // 博客正文在前景：透明叠加模式，不铺不透明天幕；移动端减少粒子并降一层星云。
    overlay: true,
    starCount: compact ? 540 : 900,
    milkyWayDensity: compact ? 0.8 : 1.0,
    nebulaLayers: compact ? 2 : 3,
    petalCount: compact ? 58 : 110,
    // 碎花螺旋在正文前景上要更收敛：半径小、每批少、密度低，叠加模式再压淡到 0.60。
    swirlRadius: compact ? 16 : 22,
    swirlPerEmit: compact ? 2 : 3,
    swirlDensity: compact ? 0.55 : 0.8,
    swirlPull: 0.68,            // 博客正文上更聚成一团，避免碎花沿整条轨迹散开
    swirlLife: 1.0,
    // 点击绽放：正文前景上比预览稍收敛，但保持「一圈碎花绽开」的辨识度。
    // 叠加模式下背景是浅色插画，碎花要比暗底再大一点、亮一点才看得清。
    bloomCount: compact ? 12 : 16,
    bloomRadius: compact ? 42 : 50,
    bloomLife: 1.25,
    bloomSize: 1.35,
    bloomGlow: 0.58,
    vignette: 0.52,
    grain: 0.042,
    maxDpr: 2
  })
  nightEngine.start()
}

const renderEffects = () => {
  renderFrame = 0
  removeEffects()
  if (!effectsEnabled || reducedMotion()) return

  const fragment = document.createDocumentFragment()
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  // 夜间：单个 canvas 同时承载银河 / 星野 / 流星 / 落花，旧的 DOM 关键帧已移除。
  const effectCanvas = document.createElement('canvas')
  effectCanvas.className = isDark ? 'night-sky-canvas-layer' : 'rain-canvas-layer'
  effectCanvas.setAttribute('aria-hidden', 'true')
  fragment.appendChild(effectCanvas)

  document.body.appendChild(fragment)
  if (isDark) mountNightSky(effectCanvas)
  else mountRain(effectCanvas)
  syncPaused()
}

// 两套 Canvas 引擎都自己监听 visibilitychange 停 rAF；class 保留给其他装饰动画。
const syncPaused = () => {
  document.documentElement.classList.toggle('effects-paused', document.hidden)
}

const scheduleRender = () => {
  if (renderFrame) return
  renderFrame = window.requestAnimationFrame(renderEffects)
}

const syncToggle = () => {
  const toggle = document.getElementById('toggle-effects')
  if (!toggle) return
  toggle.title = effectsEnabled ? '关闭动态特效' : '开启动态特效'
  toggle.setAttribute('aria-label', toggle.title)
  toggle.innerHTML = `<i class="fas ${effectsEnabled ? 'fa-wind' : 'fa-pause'}"></i>`
}

const applyEffectsState = enabled => {
  effectsEnabled = enabled
  document.documentElement.classList.toggle('effects-disabled', !enabled)
  writeLocal(storageKey, enabled)
  syncToggle()
  renderEffects()
}

// The ambient motion toggle lives in the rightside hide panel, which PJAX
// swaps on navigation, so it is re-created on every mount when missing.
const ensureToggle = () => {
  const panel = document.getElementById('rightside-config-hide')
  if (!panel) return
  if (!document.getElementById('toggle-effects')) {
    const toggle = document.createElement('button')
    toggle.id = 'toggle-effects'
    toggle.type = 'button'
    toggle.addEventListener('click', () => applyEffectsState(!effectsEnabled))
    panel.appendChild(toggle)
  }
  syncToggle()
}

const listen = (query, handler) => {
  if (typeof query.addEventListener === 'function') query.addEventListener('change', handler)
  else query.addListener(handler)
}

new MutationObserver(records => {
  if (records.some(record => record.oldValue !== document.documentElement.getAttribute(record.attributeName))) scheduleRender()
}).observe(document.documentElement, { attributes: true, attributeOldValue: true, attributeFilter: ['data-theme', 'data-reduce-motion'] })

listen(compactQuery, scheduleRender)
listen(reducedMotionQuery, scheduleRender)
document.addEventListener('visibilitychange', syncPaused)

onMount(() => {
  syncPaused()
  document.documentElement.classList.toggle('effects-disabled', !effectsEnabled)
  ensureToggle()
  if (!document.querySelector(effectsSelector)) renderEffects()
})
