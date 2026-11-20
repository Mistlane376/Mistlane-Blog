import { onMount } from '../lib/lifecycle'
import { readLocal, writeLocal } from '../lib/storage'
// Canvas 雨滴 / 夜空引擎以纯脚本形式挂到 window（见各自文件头注释）。
import './rain-canvas'
import './night-sky-canvas'

const storageKey = 'mistlane-effects-enabled-v2'
const effectsSelector = '.night-sky-canvas-layer, .rain-canvas-layer, .petal-layer, .night-star-layer'
const compactQuery = window.matchMedia('(max-width: 768px)')
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
// 与 site-polish.css 里画布层的 opacity 过渡时长保持一致。
const FADE_MS = 420

let effectsEnabled = readLocal(storageKey, true) !== false
let renderFrame = 0
let current = null        // 正在展示的层：{ node, engine, dark }
let leaving = []          // 正在淡出的旧层（过渡结束后销毁）

const reducedMotion = () => reducedMotionQuery.matches || document.documentElement.dataset.reduceMotion === 'true'
const isDarkTheme = () => document.documentElement.getAttribute('data-theme') === 'dark'

// canvas 必须在挂载到 DOM 之后再测量尺寸，因此由 createLayer 在 append 后调用。
// 日间（浅色主题）下雨；夜间（深色主题）换成 Canvas 2D 的银河星空 + 落花。
const rainOptions = () => {
  const compact = compactQuery.matches
  return {
    // 博客浅色底（#c6e3eb）需要深冷蓝雨丝才有对比度；氛围层压到很淡，不干扰阅读。
    palette: 'light',
    atmosphere: 0.45,
    density: compact ? 0.00014 : 0.00018,
    // 日间氛围：光从视口上方之外的一点向下投射（天窗 / 云隙的光柱）。
    // 光源放在画面外约一屏高处，屏幕上就没有可见的放射中心，只剩越往下越散、
    // 越往下越淡的光柱 —— 这是它不像"贴了一张放射光贴图"的关键。
    // rays 是「束数」：少而宽才像一片光；多了会读成星芒。宽度由 rayWidth 给。
    rays: compact ? 26 : 40,
    motes: compact ? 22 : 40,
    lightX: compact ? 0.48 : 0.42,
    lightY: compact ? -0.90 : -1.05,
    // 光束整体再压一档：shaftOpacity 是天光的总透明度闸门（同时作用于顶部亮雾、
    // 光束芯、核心辉光与光圈）。比继续降 rayGain 干净——rayGain 太低会把光压成
    // 一层灰雾，而总透明度降低只是让光更淡、更"若隐若现"，结构还在。
    shaftOpacity: compact ? 0.56 : 0.62,
    shaftBlur: 1,
    rayCore: compact ? 0.75 : 0.82,
    ringOpacity: compact ? 1.2 : 1.6,
    ringR: 1,
    rayWidth: compact ? 2.6 : 2.4,
    // 只压「一条条直线光束」的亮度：rayGain 只乘在每束的 alpha 上，光圈 / 顶部柔光 /
    // 核心辉光走的是 shaftOpacity / rayCore / ringOpacity，保持不动 —— 于是表现为
    // 「光柱更淡了，但顶上那圈光还在」，不是整片一起变暗。
    rayGain: compact ? 0.94 : 1.08
  }
}

const mountRain = canvas => {
  const createRainEngine = window.MistlaneRain && window.MistlaneRain.createRainEngine
  if (!createRainEngine) return null
  const engine = createRainEngine(canvas, rainOptions())
  engine.start()
  return engine
}

// 断点切换时原地 reconfigure，星空引擎会保留已有星点，只调整密度 —— 不再推倒重来。
const nightOptions = () => {
  const compact = compactQuery.matches
  return {
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
  }
}

const mountNightSky = canvas => {
  const createNightSkyEngine = window.MistlaneNightSky && window.MistlaneNightSky.createNightSkyEngine
  if (!createNightSkyEngine) return null
  const engine = createNightSkyEngine(canvas, nightOptions())
  engine.start()
  return engine
}

const createLayer = dark => {
  const node = document.createElement('canvas')
  // is-entering 让新层从 opacity:0 起步，下一帧撤掉就会自然淡入。
  node.className = `${dark ? 'night-sky-canvas-layer' : 'rain-canvas-layer'} is-entering`
  node.setAttribute('aria-hidden', 'true')
  document.body.appendChild(node)
  const engine = dark ? mountNightSky(node) : mountRain(node)
  return { node, engine, dark }
}

const retireLayer = layer => {
  if (!layer) return
  if (layer.engine) layer.engine.destroy()
  layer.node.remove()
}

// 主题切换不删旧层：让它继续绘制并淡出，新层同时淡入 —— 任何一帧都有画面，
// 不会再出现「特效整块消失、星空重新随机一批」的突兀刷新。
const retireSmoothly = layer => {
  if (!layer) return
  // 连续快速切换时只保留最近一层做过渡，避免叠出多个全屏动画。
  if (leaving.length) leaving.splice(0).forEach(retireLayer)
  layer.node.classList.add('is-leaving')
  leaving.push(layer)
  setTimeout(() => {
    leaving = leaving.filter(item => item !== layer)
    retireLayer(layer)
  }, FADE_MS + 60)
}

const clearLayers = () => {
  leaving.forEach(retireLayer)
  leaving = []
  retireLayer(current)
  current = null
  // 兜底：清掉可能由旧版本或第三方脚本留下的同名节点。
  document.querySelectorAll(effectsSelector).forEach(node => node.remove())
}

const showLayer = dark => {
  const next = createLayer(dark)
  // 双 rAF：先让浏览器记录 opacity:0，撤掉 class 才会真的跑过渡。
  requestAnimationFrame(() => requestAnimationFrame(() => next.node.classList.remove('is-entering')))
  if (current) retireSmoothly(current)
  current = next
}

// 幂等：重复调用（PJAX 重挂载、属性重复写入）不会重建已有特效。
const syncEffects = () => {
  if (!effectsEnabled || reducedMotion()) {
    if (current || leaving.length) clearLayers()
    return
  }
  const dark = isDarkTheme()
  if (current && current.dark === dark && current.node.isConnected) return
  // 节点被 PJAX 整块换掉时不做过渡，直接补一层新的（旧引擎已无处可画）。
  if (current && !current.node.isConnected) {
    retireLayer(current)
    current = null
  }
  showLayer(dark)
}

// 两套 Canvas 引擎都自己监听 visibilitychange 停 rAF；class 保留给其他装饰动画。
const syncPaused = () => {
  document.documentElement.classList.toggle('effects-paused', document.hidden)
}

const scheduleSync = () => {
  if (renderFrame) return
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0
    syncEffects()
  })
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
  syncEffects()
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

// 只关心「最终是不是深色」，中间态与重复写入交给 syncEffects 自己去重。
new MutationObserver(scheduleSync).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme', 'data-reduce-motion']
})

// 跨断点时原地调整密度（两套引擎都会保留已有粒子），而不是整片重建。
listen(compactQuery, () => {
  if (current && current.engine && current.engine.configure) {
    current.engine.configure(current.dark ? nightOptions() : rainOptions())
  } else {
    scheduleSync()
  }
})
listen(reducedMotionQuery, scheduleSync)
document.addEventListener('visibilitychange', syncPaused)

onMount(() => {
  syncPaused()
  document.documentElement.classList.toggle('effects-disabled', !effectsEnabled)
  ensureToggle()
  syncEffects()
})
