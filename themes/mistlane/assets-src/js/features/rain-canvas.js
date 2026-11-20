/*
 * Mistlane cinematic rain — Canvas 2D engine.
 *
 * Loaded as a plain script (no imports/exports) on purpose: the theme bundle
 * imports it for its side effect, and the standalone preview page can include
 * the very same file over file:// without a module server. The public surface
 * is `window.MistlaneRain.createRainEngine`.
 *
 * Design notes
 * ------------
 * - Everything is drawn in CSS pixels; one setTransform(dpr, ...) keeps the
 *   canvas crisp on HiDPI screens. The offscreen atmosphere is rendered at 1x
 *   because it is only soft gradients, saving a full-size HiDPI blit per frame.
 * - Rain streaks are quadratic Bézier arcs stroked with a real, per-drop
 *   linear gradient (transparent tail -> cool white head). A wide, low-alpha
 *   pass of the SAME gradient gives near-layer motion blur and far-layer
 *   softness; no flat-colour strokes are used for the streak itself.
 * - One impact = ONE ripple object. The shock ring, the 2-3 concentric
 *   ellipse rings and the flash point all read the same `age`, so they are
 *   guaranteed to be frame-synchronised.
 * - Drops / ripples / splashes live in preallocated free-list pools; the hot
 *   loop allocates no objects and no colour strings.
 */
;(function (root) {
  'use strict'

  var TAU = Math.PI * 2
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
  var rand = function (lo, hi) { return lo + Math.random() * (hi - lo) }
  var easeOut = function (t) { return 1 - (1 - t) * (1 - t) }

  var DEFAULTS = {
    horizonRatio: 0.64,   // 地面起始 y（视平线）＝ H * ratio
    perspective: 0.44,    // 透视压缩系数：近处椭圆 ry / rx 的上限
    minFlatten: 0.09,     // 视平线处 ry / rx
    atmosphere: 1,        // 环境光 / 雾气 / 暗角强度
    density: 0.00016,     // 每平方 CSS 像素的雨滴数
    baseWind: 0.17,       // 全局风力（水平速度 / 垂直速度）
    rays: 40,             // 天光射光束数上限（0 = 关闭）：光从视口上方一点投射下来，交代雨丝的来光
    shaftOpacity: 1,      // 天光整体不透明度倍率
    lightX: 0.42,         // 光源横向位置（视口比例）
    lightY: -1.05,        // 光源纵向位置：负值 = 在视口上方之外（约一屏高），光从顶部斜射进来
    shaftBlur: 1,         // 天光柔化倍率（0 = 锐利，1 = 默认，越大越糊）
    rayGain: 1.75,        // 天光亮度倍率
    rayCore: 1,           // 核心辉光强度倍率
    ringOpacity: 1.6,     // 光圈整体不透明度倍率（0 = 关闭）
    ringR: 1,             // 光圈半径倍率
    rayWidth: 2.4,        // 单束光宽度倍率（越大越像"一片光"，越小越像"一条线"）
    motes: 54,            // 光柱里悬浮的尘埃/水汽微粒数（丁达尔效应就靠它显形，0 = 关闭）
    moteOpacity: 1,       // 微粒整体不透明度倍率
    palette: 'dark',      // dark = 暗场景冷白雨；light = 浅色页面用深冷蓝保证对比度
    interactive: true,
    maxDpr: 2
  }

  // 远 / 中 / 近：速度、粗细、透明度、落点深度全部拉开差异。
  var LAYERS = [
    { share: 0.48, speed: [170, 265], width: [0.55, 0.95], alpha: [0.10, 0.19],
      land: [0.00, 0.40], impact: 0.13, strength: 0.55, wobble: 4, blur: true },
    { share: 0.34, speed: [420, 630], width: [0.90, 1.40], alpha: [0.20, 0.34],
      land: [0.10, 0.78], impact: 0.36, strength: 0.85, wobble: 9, blur: false },
    { share: 0.18, speed: [840, 1280], width: [1.45, 2.35], alpha: [0.34, 0.58],
      land: [0.45, 1.00], impact: 0.72, strength: 1.20, wobble: 15, blur: false }
  ]
  var CUM_SHARE = [LAYERS[0].share, LAYERS[0].share + LAYERS[1].share, 1]

  // 雨丝长度严格正比于下落速度（模拟固定曝光时间下的运动模糊）。
  var LEN_PER_SPEED = 0.050

  // 预构造的渐变色标：循环里不再拼 rgba 字符串。均为半透明冷白系，避免死白刺眼。
  // light 调色板把雨丝主体压成深冷蓝（站点浅色底 #c6e3eb 上才看得见），
  // 头部仍保留冷白高光；涟漪/水花同步换成深冷蓝。
  var PALETTES = {
    dark: {
      stops: [
        [0.00, 'rgba(174,212,238,0)'],
        [0.28, 'rgba(174,212,238,0.16)'],
        [0.62, 'rgba(196,226,246,0.55)'],
        [0.88, 'rgba(224,241,252,0.86)'],
        [1.00, 'rgba(240,250,255,0.98)']
      ],
      ring: 'rgb(202,232,251)',
      shock: 'rgb(226,245,255)',
      splash: 'rgb(186,222,246)',
      glow: '180,220,248',
      glowBright: '226,245,255',
      flash: '255,255,255',
      rippleAlpha: 1,
      dropAlpha: 1,
      dropWidth: 1
    },
    light: {
      // 浅底上"头部亮"体现为颜色更实、对比更强；近白高光反而会消失在背景里。
      stops: [
        [0.00, 'rgba(30,74,108,0)'],
        [0.28, 'rgba(34,82,118,0.30)'],
        [0.62, 'rgba(38,90,128,0.74)'],
        [0.88, 'rgba(46,102,142,0.95)'],
        [1.00, 'rgba(66,126,166,0.98)']
      ],
      ring: 'rgb(42,98,136)',
      shock: 'rgb(86,146,184)',
      splash: 'rgb(48,106,146)',
      glow: '46,104,142',
      glowBright: '92,152,190',
      flash: '150,198,228',
      rippleAlpha: 0.86,
      dropAlpha: 1.28,
      dropWidth: 1.12
    }
  }

  var MAX_DROPS = 560
  var MAX_RIPPLES = 150
  var MAX_SPLASHES = 260

  // 0 = 最低画质 ... 3 = 全效果。掉帧时逐级下降，长时间流畅再回升。
  var QUALITY = [
    { drop: 0.42, dpr: 1, glow: false, shock: false, splash: false, halo: false, rings: 1, ray: 12, mote: 0 },
    { drop: 0.62, dpr: 1.5, glow: true, shock: true, splash: false, halo: false, rings: 2, ray: 20, mote: 0 },
    { drop: 0.82, dpr: 2, glow: true, shock: true, splash: true, halo: true, rings: 2, ray: 30, mote: 30 },
    { drop: 1.00, dpr: 2, glow: true, shock: true, splash: true, halo: true, rings: 3, ray: 40, mote: 54 }
  ]

  // ---- 对象池：预分配，swap-remove 回收，热循环零 new -----------------------
  function createPool(size, factory) {
    var active = []
    var free = []
    for (var i = 0; i < size; i += 1) free.push(factory())
    return {
      active: active,
      free: free,
      spawn: function () {
        if (!free.length) return null
        var o = free.pop()
        active.push(o)
        return o
      },
      releaseAt: function (i) {
        var last = active.length - 1
        var o = active[i]
        active[i] = active[last]
        active.pop()
        free.push(o)
      },
      clear: function () {
        while (active.length) free.push(active.pop())
      }
    }
  }

  function makeDrop() {
    return { layer: 0, x: 0, y: 0, speed: 0, len: 0, width: 1, alpha: 0,
      bend: 0, phase: 0, wf: 1, wobble: 0, tailJitter: 0, landY: 0 }
  }

  function makeRipple() {
    return { x: 0, y: 0, depth: 0, k: 0.3, maxR: 20, life: 1, age: 0,
      alpha: 0.6, ringCount: 3,
      ringScale: [1, 1, 1], ringPhase: [0, 0, 0], ringK: [1, 1, 1],
      offX: [0, 0, 0], offY: [0, 0, 0] }
  }

  function makeSplash() {
    return { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0.4, size: 1 }
  }

  // ---- 静态光效贴图（只生成一次） -----------------------------------------
  function buildRingGlow(pal) {
    var c = document.createElement('canvas')
    c.width = c.height = 128
    var g = c.getContext('2d')
    var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0.00, 'rgba(' + pal.glow + ',0)')
    grad.addColorStop(0.58, 'rgba(' + pal.glow + ',0)')
    grad.addColorStop(0.80, 'rgba(' + pal.glow + ',0.30)')
    grad.addColorStop(0.91, 'rgba(' + pal.glowBright + ',0.92)')
    grad.addColorStop(1.00, 'rgba(' + pal.glow + ',0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
    return c
  }

  function buildPointGlow(pal) {
    var c = document.createElement('canvas')
    c.width = c.height = 64
    var g = c.getContext('2d')
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0.00, 'rgba(' + pal.flash + ',1)')
    grad.addColorStop(0.22, 'rgba(' + pal.flash + ',0.75)')
    grad.addColorStop(0.55, 'rgba(' + pal.glow + ',0.20)')
    grad.addColorStop(1.00, 'rgba(' + pal.glow + ',0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
    return c
  }

  function createRainEngine(canvas, options) {
    if (!canvas || !canvas.getContext) throw new Error('[rain] a canvas element is required')

    var opt = {}
    for (var key in DEFAULTS) opt[key] = DEFAULTS[key]
    if (options) for (var k in options) if (options[k] !== undefined) opt[k] = options[k]

    var ctx = canvas.getContext('2d', { alpha: true })
    var pal = PALETTES[opt.palette] || PALETTES.dark
    var stops = pal.stops
    var alphaBoost = pal.dropAlpha || 1
    var widthBoost = pal.dropWidth || 1
    var bg = document.createElement('canvas')
    var ringGlow = buildRingGlow(pal)
    var pointGlow = buildPointGlow(pal)

    // 天光：所有光束从同一个"云隙"点发散，每帧按贝塞尔曲线求边，主画布直接填充。
    // 预渲染贴图只能做直条，做不出弯曲和收束，所以这里放弃 drawImage 走路径。
    // 光束数量很少（≤4），采样点复用一个数组，热路径不分配对象。
    var rays = []
    var motes = []

    var drops = createPool(MAX_DROPS, makeDrop)
    var ripples = createPool(MAX_RIPPLES, makeRipple)
    var splashes = createPool(MAX_SPLASHES, makeSplash)

    var W = 1, H = 1, dpr = 1, gy = 1, groundRange = 1
    var running = false, visible = !document.hidden, destroyed = false
    var raf = 0, lastTs = 0, time = 0, resizeTimer = 0
    var baseWindValue = opt.baseWind, wind = baseWindValue
    var quality = 3, ema = 16.7, warmup = 40, bad = 0, good = 0
    var bgQuality = -1                 // 静态层上次按哪一档画质光栅化，-1 = 需要重画
    var baseCount = 100
    var lastMoveTs = 0, lastMoveX = -9999, lastMoveY = -9999

    function pickLayer() {
      var r = Math.random()
      return r < CUM_SHARE[0] ? 0 : r < CUM_SHARE[1] ? 1 : 2
    }

    function resetDrop(d, initial) {
      var li = pickLayer()
      var L = LAYERS[li]
      d.layer = li
      d.speed = rand(L.speed[0], L.speed[1])
      d.len = d.speed * LEN_PER_SPEED * rand(0.86, 1.16)
      d.width = rand(L.width[0], L.width[1]) * widthBoost
      d.alpha = Math.min(0.92, rand(L.alpha[0], L.alpha[1]) * alphaBoost)
      d.bend = rand(-0.5, 0.5)
      d.phase = rand(0, TAU)
      d.wf = rand(2.2, 5.2)
      d.wobble = L.wobble
      d.tailJitter = rand(-1.4, 1.4)
      var depth = rand(L.land[0], L.land[1])
      d.landY = gy + depth * groundRange + rand(-5, 5)
      d.x = rand(-70, W + 70)
      d.y = initial ? rand(-H * 0.3, d.landY) : -rand(d.len + 4, d.len + H * 0.35)
    }

    function setDropCount(target) {
      target = clamp(Math.round(target), 30, MAX_DROPS)
      while (drops.active.length > target) drops.releaseAt(drops.active.length - 1)
      while (drops.active.length < target) {
        var d = drops.spawn()
        if (!d) break
        resetDrop(d, true)
      }
    }

    function flatten(depth) {
      return opt.minFlatten + (opt.perspective - opt.minFlatten) * Math.pow(depth, 1.35)
    }

    function spawnRipple(x, y, depth, strength, user) {
      var r = ripples.spawn()
      if (!r) return null
      var scale = 0.28 + 0.72 * depth
      r.x = x
      r.y = y
      r.depth = depth
      r.k = flatten(depth) * rand(0.90, 1.10)
      r.maxR = (17 + 38 * scale) * strength * rand(0.82, 1.20)
      r.life = rand(0.62, 1.02) * (user ? 1.18 : 1)
      r.age = 0
      r.alpha = (user ? 0.98 : 0.70) * (0.55 + 0.45 * depth) * pal.rippleAlpha
      r.ringCount = clamp(QUALITY[quality].rings - (Math.random() < 0.35 ? 1 : 0), 1, 3)
      for (var i = 0; i < 3; i += 1) {
        r.ringScale[i] = rand(0.88, 1.12)
        r.ringPhase[i] = rand(-0.07, 0.07)   // 轻微随机相位，避免机械重复
        r.ringK[i] = rand(0.92, 1.08)
        r.offX[i] = rand(-1.6, 1.6)
        r.offY[i] = rand(-1.0, 1.0)
      }
      return r
    }

    function spawnSplash(x, y, count, power) {
      if (!QUALITY[quality].splash) return
      for (var i = 0; i < count; i += 1) {
        var p = splashes.spawn()
        if (!p) return
        p.x = x + rand(-3, 3)
        p.y = y
        p.vx = rand(-1, 1) * 95 * power
        p.vy = -rand(0.45, 1.25) * 165 * power
        p.life = rand(0.24, 0.48)
        p.age = 0
        p.size = rand(0.7, 1.5) * (power > 1.2 ? 1.2 : 1)
      }
    }

    function impact(x, y, depth, strength, user, splashCount) {
      spawnRipple(x, y, depth, strength, user)
      if (splashCount) spawnSplash(x, y, splashCount, user ? 1.5 : 0.9)
    }

    // ---- 离屏静态背景：渐变 / 环境光 / 雾带 / 湿地反光 / 暗角，只画一次 -----
    function buildBackground() {
      bg.width = Math.max(1, Math.round(W))
      bg.height = Math.max(1, Math.round(H))
      var b = bg.getContext('2d')
      var w = bg.width, h = bg.height, A = opt.atmosphere
      b.clearRect(0, 0, w, h)

      var g = b.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, 'rgba(18,34,52,' + (0.10 * A) + ')')
      g.addColorStop(0.55, 'rgba(26,48,66,' + (0.045 * A) + ')')
      g.addColorStop(1, 'rgba(8,18,30,' + (0.13 * A) + ')')
      b.fillStyle = g
      b.fillRect(0, 0, w, h)

      g = b.createRadialGradient(w * 0.52, gy * 0.72, 0, w * 0.52, gy * 0.72, w * 0.62)
      g.addColorStop(0, 'rgba(170,208,235,' + (0.055 * A) + ')')
      g.addColorStop(1, 'rgba(170,208,235,0)')
      b.fillStyle = g
      b.fillRect(0, 0, w, h)

      var bandTop = gy - h * 0.16
      g = b.createLinearGradient(0, bandTop, 0, gy + h * 0.12)
      g.addColorStop(0, 'rgba(190,218,238,0)')
      g.addColorStop(0.5, 'rgba(190,218,238,' + (0.055 * A) + ')')
      g.addColorStop(1, 'rgba(190,218,238,0)')
      b.fillStyle = g
      b.fillRect(0, bandTop, w, h * 0.28)

      // 湿地反光从视平线上方柔和淡入，避免出现一条生硬的横向分界线。
      g = b.createLinearGradient(0, gy - h * 0.09, 0, h)
      g.addColorStop(0, 'rgba(120,170,205,0)')
      g.addColorStop(0.22, 'rgba(120,170,205,' + (0.05 * A) + ')')
      g.addColorStop(1, 'rgba(60,105,145,' + (0.012 * A) + ')')
      b.fillStyle = g
      b.fillRect(0, gy - h * 0.09, w, h - gy + h * 0.09)

      g = b.createRadialGradient(w * 0.5, h * 0.48, Math.min(w, h) * 0.26,
        w * 0.5, h * 0.48, Math.max(w, h) * 0.78)
      g.addColorStop(0, 'rgba(4,10,18,0)')
      g.addColorStop(1, 'rgba(4,10,18,' + (0.15 * A) + ')')
      b.fillStyle = g
      b.fillRect(0, 0, w, h)
    }

    // ---- 日间天光：视口上方的一点，向下投射 ------------------------------------
    // 结构依据（照这个实现，而不是"画一束白光"）：
    //  1. 光来自画面外的上方一点（天窗 / 云隙）。屏幕里看到的从来不是「一点向
    //     四周放射的星芒」，而是「越往下越散、越往下越淡」的一段光柱。把光源
    //     放到视口之外，收敛点自然被裁掉 —— 这是它不像特效贴图的关键：画面里
    //     没有可见的放射中心。
    //  2. 光的路径是直线。散射只改变强度、不改变方向（弯曲的是遮挡物孔隙）；
    //     透视让这些直线在上方收拢、往下张开，所以画四边形就够，不必采样曲线。
    //  3. 亮度沿半径按 Beer–Lambert 单调衰减：靠近开口最亮，越远越化进空气。
    //     开口在画外，屏幕顶端已经是「衰减过一段」的亮度，顶端就不会成为全屏
    //     最亮的一条带 —— 那正是自然光柱与放射状贴图的分界。
    //  4. 只在朝下的半球里发股。朝上的部分落在画外，画了也看不见，白占股数。
    var bloomTile = document.createElement('canvas')
    var rayPhase = [rand(0, TAU), rand(0, TAU), rand(0, TAU)]

    var cur = { x: 0, y: 0, dx: 0, dy: 0, len: 0, nx: 0, ny: 0, r0: 0, wAng: 0 }

    function lightX() { return W * opt.lightX }
    function lightY() { return H * opt.lightY }

    // 光源到画面上沿的距离。这是整段天光的标定尺度：光束起始半径、光圈半径、
    // 亮度包络全都按它算，换视口 / 换断点都不会变形。
    function topGap() {
      return Math.max(H * 0.08, -H * opt.lightY)
    }

    function burstRadius() {
      // 到最远角的距离＝径向渐变的半径，保证所有光线的衰减占比一致。
      var cx = lightX(), cy = lightY()
      var dx = Math.max(cx, W - cx), dy = Math.max(cy, H - cy)
      return Math.max(80, Math.sqrt(dx * dx + dy * dy))
    }

    // 射线射到视口边界的距离：让每条光都真正射出屏幕，
    // 末端就不会在画面中间出现一道整齐的硬切。
    function edgeDist(cx, cy, dx, dy) {
      var t = 1e9
      if (dx > 1e-6) t = Math.min(t, (W - cx) / dx)
      else if (dx < -1e-6) t = Math.min(t, -cx / dx)
      if (dy > 1e-6) t = Math.min(t, (H - cy) / dy)
      else if (dy < -1e-6) t = Math.min(t, -cy / dy)
      return Math.max(60, t)
    }

    // 周向亮度：三条不同角频率叠加，对应"雾的大块厚薄 + 细碎纹理"。
    // 均匀分布会读成镜头星芒，而真实散射的密度沿周向连续变化。
    // 关键是相位也在随时间缓慢推进（三档速度各不相同方向也相反），于是亮区
    // 会沿着扇形慢慢游走 —— 静态相位会让某一侧永远最亮，读起来像固定聚光灯。
    function rayStrength(ang) {
      return clamp(
        0.58 + 0.26 * Math.sin(ang * 2.2 + rayPhase[0] + time * 0.055) +
        0.17 * Math.sin(ang * 6.7 + rayPhase[1] - time * 0.031) +
        0.10 * Math.sin(ang * 15.3 + rayPhase[2] + time * 0.017),
        0.10, 1.25)
    }

    function seedRays() {
      rays = []
      var n = Math.max(4, Math.round(opt.rays))
      var cx = lightX(), cy = lightY()
      // 有效角度区间按几何算，不写死：光源在画外上方时，画面就是被「左上角」
      // 与「右上角」两条切线夹住的那一扇；这两条恰好擦着上沿，往外的光一进来
      // 就出画，白占股数。按几何算的好处是光源一挪、视口一变，密度都不会
      // 塌到某一边（写死 15°~165° 时，光源越往上，左边就越稀）。
      var a0, a1
      if (cy < -H * 0.02 && cx > 0 && cx < W) {
        a0 = Math.atan2(-cy, W - cx)      // 擦右上角
        a1 = Math.atan2(-cy, -cx)         // 擦左上角
      } else {
        a0 = Math.PI * 0.085
        a1 = Math.PI - a0
      }
      for (var i = 0; i < n; i += 1) {
        var u = (i + 0.5) / n
        rays.push({
          // 角间距不等：缝隙不是刻度尺，抖动到 ±55% 间距还能保持整体疏密
          ang: a0 + (a1 - a0) * u + rand(-0.55, 0.55) * (a1 - a0) / n,
          // 半张角：用平方分布而不是均匀分布 —— 大多数是细股（负责纹理），
          // 少数特别粗（负责把缝填满）。均匀分布会让整体读成"宽扇子"，没有细节。
          wAng: 0.0040 + 0.034 * Math.pow(Math.random(), 1.8),
          lenMul: rand(1.02, 1.14),     // 一律出屏，只留一点长短差
          r0Mul: rand(0.30, 0.92),      // 起始半径占"到上沿距离"的比例（见 buildRay）
          gain: rand(0.26, 1.15),       // 单股强弱
          phase: rand(0, TAU),
          // 若隐若现的角速度：周期 11~31 秒。再快就成了闪烁，再慢就看不出来；
          // 每束各自不同，所以永远不会整片一起亮、一起暗。
          rate: rand(0.20, 0.55)
        })
      }
      seedMotes()
    }

    function seedMotes() {
      motes = []
      var n = Math.max(0, Math.round(opt.motes))
      for (var i = 0; i < n; i += 1) {
        motes.push({
          beam: (Math.random() * 72) | 0,     // 落在哪一股光里（绘制时按束数取模）
          t: rand(0.12, 1),                   // 沿半径位置：避开光源核心
          off: rand(-0.46, 0.46),             // 横向偏移（相对半宽，±1 = 贴边）
          rise: rand(0.006, 0.024),           // 缓慢向光源漂移（光柱里是上升气流）
          size: rand(0.55, 1.55),
          alpha: rand(0.20, 0.52),
          twinkle: rand(0.5, 1.9),
          phase: rand(0, TAU)
        })
      }
    }

    function buildRay(r) {
      // 整体缓慢来回旋转 + 各束自己的微晃：光源固定，动的是"空气在缓慢转向"。
      // 两条互不整除的长周期（≈140s / ≈330s）叠出一个不回零的来回摆，节拍认不出来；
      // 振幅合计约 0.034 rad（≈2°），在 1.5H 的远端扫过几十像素 —— 看得出在慢慢转，
      // 又不至于像有人拿手电在扫。单束微晃调小，让整片更像"一起转"而非各自抖。
      var sway = 0.022 * Math.sin(time * 0.045) + 0.012 * Math.sin(time * 0.019 + 1.7)
      var ang = r.ang + sway + 0.003 * Math.sin(time * r.rate * 0.22 + r.phase)
      var dx = Math.cos(ang), dy = Math.sin(ang)
      cur.x = lightX(); cur.y = lightY()
      cur.dx = dx; cur.dy = dy
      cur.nx = -dy; cur.ny = dx
      cur.len = edgeDist(cur.x, cur.y, dx, dy) * r.lenMul
      // 起点落在画面之外（上沿附近）而不是数学奇点：光柱进入视口时已经张开到
      // 一定宽度，几十条不会在屏幕顶边挤成一颗亮星。
      cur.r0 = Math.max(6, topGap() * r.r0Mul)
      // 半宽 = 半径 × 半张角：离开开口后线性张开，这是锥形光束的几何本质。
      cur.wAng = r.wAng * opt.rayWidth
    }

    // 径向亮度包络：所有光线共用一张渐变，于是"亮度只随半径变化"。
    // 色标位置按视口高度 H 归一，不按 R（R 随长宽比乱跳，按它定标换个屏幕就毁了）。
    function buildBurstGradient(c2d) {
      var cx = lightX(), cy = lightY()
      var R = burstRadius()
      var gap = topGap()
      var g = c2d.createRadialGradient(cx, cy, 0, cx, cy, R)
      // 单位是"光源到屏幕上沿的距离"gap，不是 H、也不是 R：
      //  · 按 H 定标 —— 光源一挪，整条包络就错位；
      //  · 按 R 定标 —— R 随长宽比乱跳，换个窗口就毁了；
      //  · 按 gap 定标 —— 无论光源放多高，"进入画面时有多亮"始终一致。
      // 曲线整体单调递减：开口在画外，光柱进入画面时已在衰减路上，越往下越淡。
      // 不做"峰值落在画面中间"的包络 —— 那会让屏幕中段凭空亮出一道横带，
      // 正是"光效"和"天光"最容易露馅的地方。
      var prof = [
        [0.00, 0.00], [0.30, 0.30], [0.55, 0.55], [0.80, 0.78],
        [1.00, 0.88], [1.30, 0.86], [1.70, 0.72], [2.20, 0.54],
        [2.80, 0.34], [3.50, 0.16], [4.40, 0.04], [5.40, 0.00]
      ]
      for (var i = 0; i < prof.length; i += 1) {
        g.addColorStop(clamp(prof[i][0] * gap / R, 0, 1),
          'rgba(255,251,238,' + prof[i][1].toFixed(4) + ')')
      }
      return g
    }

    // 开口的辉光在画外，这里预渲染的是它"漏"进画面的那一片：
    // 屏幕顶部一层很淡的亮雾，越往下越没有。
    function buildBloomTile() {
      var bw = Math.max(2, Math.round(W / 3))
      var bh = Math.max(2, Math.round(H / 3))
      bloomTile.width = bw
      bloomTile.height = bh
      var b = bloomTile.getContext('2d')
      b.clearRect(0, 0, bw, bh)
      var cx = bw * opt.lightX, cy = bh * opt.lightY
      var r = Math.max(bw, bh) * 0.56
      var g = b.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0.00, 'rgba(255,252,242,0.17)')
      g.addColorStop(0.30, 'rgba(255,252,242,0.085)')
      g.addColorStop(0.62, 'rgba(255,251,242,0.028)')
      g.addColorStop(1.00, 'rgba(255,251,242,0)')
      b.fillStyle = g
      b.fillRect(0, 0, bw, bh)
    }

    // 模糊：光束画在 1/3 尺寸的离屏上，放大到 1/2 时补一道 canvas blur，
    // 最后双线性放大回全屏。低分辨率本身已经抹掉硬边，filter 只是把过渡拉长。
    var glowLo = null, glowMid = null, burstGrad = null
    var canFilter = null

    function supportsFilter() {
      if (canFilter !== null) return canFilter
      try {
        var probe = document.createElement('canvas').getContext('2d')
        probe.filter = 'blur(1px)'
        canFilter = probe.filter === 'blur(1px)'
      } catch (e) {
        canFilter = false
      }
      return canFilter
    }

    function ensureGlowBuffers() {
      if (!glowLo) {
        glowLo = document.createElement('canvas')
        glowMid = document.createElement('canvas')
      }
      var lw = Math.max(8, Math.round(W / 3))
      var lh = Math.max(8, Math.round(H / 3))
      var changed = glowLo.width !== lw || glowLo.height !== lh
      if (changed) {
        glowLo.width = lw
        glowLo.height = lh
      }
      var mw = Math.max(8, Math.round(W / 2))
      var mh = Math.max(8, Math.round(H / 2))
      if (glowMid.width !== mw || glowMid.height !== mh) {
        glowMid.width = mw
        glowMid.height = mh
      }
      if (changed || !burstGrad) burstGrad = buildBurstGradient(glowLo.getContext('2d'))
    }

    // 横截面用六档宽度叠成近似高斯：只用「宽光晕 + 窄束芯」两档时，两档之间
    // 会留下一条可辨认的硬边，几十股叠起来就成了漫画式的星芒。
    var RAY_PASSES = [
      [6.40, 0.030], [4.40, 0.055], [3.00, 0.085],
      [2.05, 0.115], [1.42, 0.145], [1.00, 0.170]
    ]

    // 光圈：半径（占"到上沿距离"的倍数）、环的半宽（CSS px）、峰值不透明度。
    // 不用 stroke 画 —— 描边是一根等宽的线，读起来像镜头光斑；改用"甜甜圈"
    // 径向渐变填充，边缘自然化开、宽度随半径变厚，才是雾里看灯的观感。
    // 光源在画外，所以这些环在屏幕上表现为顶部几道极淡的弧。
    var RINGS = [[1.50, 34, 0.085], [2.20, 58, 0.042], [3.05, 88, 0.020]]

    // 整片的涨落：两条慢周期叠加（≈33s 与 ≈76s），幅度 ±16%。
    // 与每一束自己的明暗错开相位，于是「一片光在微微起伏」，而不是恒定的一层。
    function glowPulse() {
      return 0.92 + 0.10 * Math.sin(time * 0.19) + 0.06 * Math.sin(time * 0.083 + 2.3)
    }

    function drawHalo(lo) {
      var cx = lightX(), cy = lightY()
      var gap = topGap()
      var k = clamp(opt.shaftOpacity, 0, 1.5) * clamp(opt.rayCore, 0, 3) * glowPulse()
      if (k <= 0.004) return

      // 核心辉光：开口在画外，这里画它透过空气漏进画面的那一层大半径柔光，
      // 进入画面时就已经很淡，往下逐渐消失。
      var gr = Math.max(W, H) * 0.90
      var core = lo.createRadialGradient(cx, cy, 0, cx, cy, gr)
      core.addColorStop(0.00, 'rgba(255,254,247,' + (0.30 * k).toFixed(4) + ')')
      core.addColorStop(0.28, 'rgba(255,252,242,' + (0.14 * k).toFixed(4) + ')')
      core.addColorStop(0.58, 'rgba(255,251,240,' + (0.05 * k).toFixed(4) + ')')
      core.addColorStop(1.00, 'rgba(255,251,240,0)')
      lo.fillStyle = core
      lo.beginPath()
      lo.arc(cx, cy, gr, 0, TAU)
      lo.fill()

      // 光圈：柔边圆环 = 一条环形的高斯亮度，用径向渐变填充整圆实现。
      var ringK = clamp(opt.ringOpacity, 0, 2) * k
      if (ringK <= 0.004) return
      var rr0 = clamp(opt.ringR, 0.3, 3)
      for (var i = 0; i < RINGS.length; i += 1) {
        var rr = gap * RINGS[i][0] * rr0
        var hw = RINGS[i][1] * (0.6 + 0.4 * rr0)
        var g2 = lo.createRadialGradient(cx, cy, Math.max(0, rr - hw), cx, cy, rr + hw)
        var pk = RINGS[i][2] * ringK
        g2.addColorStop(0.00, 'rgba(255,252,244,0)')
        g2.addColorStop(0.38, 'rgba(255,252,244,' + (pk * 0.55).toFixed(4) + ')')
        g2.addColorStop(0.50, 'rgba(255,252,244,' + pk.toFixed(4) + ')')
        g2.addColorStop(0.62, 'rgba(255,252,244,' + (pk * 0.55).toFixed(4) + ')')
        g2.addColorStop(1.00, 'rgba(255,252,244,0)')
        lo.fillStyle = g2
        lo.beginPath()
        lo.arc(cx, cy, rr + hw, 0, TAU)
        lo.fill()
      }
    }

    function drawShafts() {
      var count = Math.min(opt.rays, QUALITY[quality].ray, rays.length)
      if (!count || opt.shaftOpacity <= 0) return

      ctx.globalCompositeOperation = 'lighter'
      if (!bloomTile.width) buildBloomTile()
      if (bloomTile.width) {
        ctx.globalAlpha = clamp(opt.shaftOpacity, 0, 1) * 0.9 * glowPulse()
        ctx.drawImage(bloomTile, 0, 0, W, H)
        ctx.globalAlpha = 1
      }

      ensureGlowBuffers()
      var lo = glowLo.getContext('2d')
      lo.setTransform(1, 0, 0, 1, 0, 0)
      lo.clearRect(0, 0, glowLo.width, glowLo.height)
      lo.setTransform(glowLo.width / W, 0, 0, glowLo.height / H, 0, 0)
      lo.globalCompositeOperation = 'lighter'
      // 所有射线共用这张径向渐变：亮度只跟半径有关，天然满足
      // "共点 → 起点淡 → 峰值 → 长尾"，不需要逐条算衰减。
      lo.fillStyle = burstGrad

      // 整体一个极慢的明暗呼吸（雾在走），叠加到每一股上。
      // 单股基础透明度必须很低：几十股在同一处叠四层，亮度是累加的。
      var drift = 0.88 + 0.12 * Math.sin(time * 0.047)
      for (var i = 0; i < count; i += 1) {
        var r = rays[i]
        buildRay(r)
        // 若隐若现：两束周期互不整除的正弦叠加，暗下去、亮回来的时机不规则，
        // 不会读成"呼吸动画"。谷值压到 0.30 —— 那几秒里这一束几乎消失，
        // 峰值回到 1.0 才重新显形；因为每束的 rate/phase 都不同，
        // 整片光柱永远是"这一道淡了、那一道又浮起来"。
        var b1 = 0.5 + 0.5 * Math.sin(time * r.rate + r.phase)
        var b2 = 0.5 + 0.5 * Math.sin(time * r.rate * 0.53 + r.phase * 1.7)
        var mood = 0.30 + 0.70 * (0.62 * b1 + 0.38 * b2)
        // 整片呼吸：一条很慢的全局正弦（周期≈74s），让"一片光"整体有起伏的呼吸感；
        // 与每束自己的 mood 错相，两者相乘不会读成统一的机械呼吸。
        var breath = 0.86 + 0.14 * Math.sin(time * 0.085)
        var a = 0.46 * opt.rayGain * opt.shaftOpacity * r.gain * rayStrength(r.ang) * drift * mood * breath
        if (a <= 0.002) continue
        // 单股封顶：随机到高增益的那一股会变成一根几乎不透明的白线，比整片都扎眼。
        // 0.42 -> 0.32 -> 0.26：整体越淡，越不允许个别股独自亮成线。
        if (a > 0.26) a = 0.26
        var sx = cur.x + cur.dx * cur.r0, sy = cur.y + cur.dy * cur.r0
        var ex = cur.x + cur.dx * cur.len, ey = cur.y + cur.dy * cur.len
        for (var p = 0; p < RAY_PASSES.length; p += 1) {
          var wm = RAY_PASSES[p][0]
          var pa = a * RAY_PASSES[p][1]
          if (pa <= 0.002) continue
          // 上限防止「特别宽的股 + 最宽那一档」在远处摊成一大块亮斑：
          // 单股半宽不许超过视口短边的 9%，超过就不再是光束而是雾团。
          var cap = Math.min(W, H) * 0.09
          var hw0 = clamp(cur.r0 * cur.wAng * wm, 0.6, cap)
          var hw1 = clamp(cur.len * cur.wAng * wm, 0.8, cap)
          lo.globalAlpha = pa > 0.9 ? 0.9 : pa
          lo.beginPath()
          lo.moveTo(sx + cur.nx * hw0, sy + cur.ny * hw0)
          lo.lineTo(ex + cur.nx * hw1, ey + cur.ny * hw1)
          lo.lineTo(ex - cur.nx * hw1, ey - cur.ny * hw1)
          lo.lineTo(sx - cur.nx * hw0, sy - cur.ny * hw0)
          lo.closePath()
          lo.fill()
        }
      }
      lo.globalAlpha = 1
      drawHalo(lo)

      // 纵向衰减：径向包络只管"离光源多远"，管不了"光该在哪停"。
      // 真实场景里光柱下面总有一堆遮挡（水面、栏杆、雾），越往下越没有。
      // 这里用 destination-in 叠一道自上而下的灰度蒙版，直接把整层压下去 ——
      // 比给每条光单独做渐变便宜，而且衰减曲线与光源位置无关，调参直观。
      lo.globalCompositeOperation = 'destination-in'
      var vg = lo.createLinearGradient(0, 0, 0, H)
      vg.addColorStop(0.00, 'rgba(0,0,0,1)')
      vg.addColorStop(0.22, 'rgba(0,0,0,0.96)')
      vg.addColorStop(0.46, 'rgba(0,0,0,0.72)')
      vg.addColorStop(0.68, 'rgba(0,0,0,0.40)')
      vg.addColorStop(0.86, 'rgba(0,0,0,0.17)')
      vg.addColorStop(1.00, 'rgba(0,0,0,0.04)')
      lo.fillStyle = vg
      lo.fillRect(0, 0, W, H)
      lo.globalCompositeOperation = 'lighter'

      // 逐级放大回主画布：这一步同时完成"合成"和"模糊"。
      var mid = glowMid.getContext('2d')
      mid.setTransform(1, 0, 0, 1, 0, 0)
      mid.clearRect(0, 0, glowMid.width, glowMid.height)
      if (supportsFilter()) {
        // 1.6px 在 1/2 尺度上 ≈ 全屏 3px，再叠上两级放大插值约等于 6~8px 的柔化。
        // 够糊掉每股光的硬边，又不至于把条纹抹平 —— 抹平了就回到"一团白雾"。
        mid.filter = 'blur(' + (1.6 * clamp(opt.shaftBlur, 0, 3)).toFixed(2) + 'px)'
        mid.drawImage(glowLo, 0, 0, glowMid.width, glowMid.height)
        mid.filter = 'none'
      } else {
        mid.drawImage(glowLo, 0, 0, glowMid.width, glowMid.height)
      }

      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = clamp(opt.shaftOpacity, 0, 1)
      ctx.drawImage(glowMid, 0, 0, W, H)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    // 束内尘埃：丁达尔效应本质是"光被介质散射"，没有微粒就只是一道白杠。
    // 微粒挂在具体某一股光上，随它一起呼吸、一起摆，永远待在光里。
    function drawMotes() {
      var cap = QUALITY[quality].mote || 0
      if (!cap || opt.motes <= 0 || opt.moteOpacity <= 0) return
      var count = Math.min(opt.rays, QUALITY[quality].ray, rays.length)
      if (!count) return
      ctx.globalCompositeOperation = 'lighter'
      // 微粒是纯暖白点，亮度全交给 globalAlpha；必须显式设色，否则会继承光束的渐变。
      ctx.fillStyle = 'rgb(255,253,240)'
      var limit = Math.min(motes.length, cap)
      for (var i = 0; i < limit; i += 1) {
        var m = motes[i]
        var r = rays[m.beam % count]
        if (!r) continue
        buildRay(r)
        var t = clamp(m.t, 0, 1)
        var rr = cur.r0 + (cur.len - cur.r0) * t
        var halfW = Math.max(1.5, rr * cur.wAng)
        var px = cur.x + cur.dx * rr + cur.nx * m.off * halfW
        var py = cur.y + cur.dy * rr + cur.ny * m.off * halfW
        if (py < -40 || py > H + 40 || px < -40 || px > W + 40) continue
        // 首尾渐隐：光束两端本来就淡，微粒也跟着消失
        var falloff = Math.sin(Math.PI * t)
        var tw = 0.55 + 0.45 * Math.sin(time * m.twinkle + m.phase)
        var a = m.alpha * falloff * tw * opt.moteOpacity
        if (a <= 0.004) continue
        ctx.globalAlpha = a
        ctx.beginPath()
        ctx.arc(px, py, m.size, 0, TAU)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    function updateMotes(dt) {
      var limit = Math.min(motes.length, QUALITY[quality].mote || 0)
      for (var i = 0; i < limit; i += 1) {
        var m = motes[i]
        m.t -= m.rise * dt          // 微小气流：沿半径缓慢漂移
        if (m.t < 0.06) {           // 漂进开口就重新从远端进来
          m.t = 1.02
          m.beam = (Math.random() * 72) | 0
          m.off = rand(-0.46, 0.46)
        }
      }
    }

    // ---- resize：重建画布 / 背景 / 地面参数，等比迁移已有雨滴 ---------------
    function resize() {
      if (destroyed) return
      var oldW = W, oldH = H, oldGy = gy, oldRange = groundRange
      var nextW = Math.max(1, canvas.clientWidth || window.innerWidth || 1)
      var nextH = Math.max(1, canvas.clientHeight || window.innerHeight || 1)
      var nextDpr = clamp(window.devicePixelRatio || 1, 1, Math.min(opt.maxDpr, QUALITY[quality].dpr))
      var sizeChanged = nextW !== W || nextH !== H
      // 重设 canvas.width/height 会清空位图：尺寸与档位都没变时直接跳过，
      // 避免自动画质调整这类「只是换档」的 resize 闪出一帧空画布。
      var surfaceChanged = sizeChanged || nextDpr !== dpr || bgQuality !== quality
      W = nextW
      H = nextH
      dpr = nextDpr
      gy = H * clamp(opt.horizonRatio, 0.2, 0.92)
      groundRange = Math.max(120, H - gy)

      if (surfaceChanged) {
        canvas.width = Math.round(W * dpr)
        canvas.height = Math.round(H * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        buildBackground()
        buildBloomTile()
        bgQuality = quality
      }

      // 光束参数全部是「角度 + 倍率」的相对量，每帧按 W/H 求几何，所以 resize
      // 只做等比拉伸，不会像贴图方案那样重新随机出另一批光柱。
      if (!rays.length) seedRays()

      if (sizeChanged && oldW > 1 && oldH > 1) {
        var sx = W / oldW, sy = H / oldH
        for (var i = 0; i < drops.active.length; i += 1) {
          var d = drops.active[i]
          d.x *= sx
          d.y *= sy
          d.landY = gy + ((d.landY - oldGy) / oldRange) * groundRange
        }
      }

      baseCount = clamp(Math.round(W * H * opt.density), 70, 460)
      setDropCount(baseCount * QUALITY[quality].drop)

      // 重设位图会清空可见画布：正在运行时立刻补一帧，避免闪出一帧空白底。
      if (surfaceChanged && running && visible && !destroyed) render()
    }

    // ---- 交互：window 上监听，canvas 保持 pointer-events:none 不挡点击 ------
    function interactionDepth(y) {
      return clamp(0.18 + 0.82 * (y / H), 0.18, 1)
    }

    function onPointerMove(e) {
      var now = performance.now()
      if (now - lastMoveTs < 42) return
      var x = e.clientX, y = e.clientY
      var dx = x - lastMoveX, dy = y - lastMoveY
      if (dx * dx + dy * dy < 900) return
      lastMoveTs = now
      lastMoveX = x
      lastMoveY = y
      impact(x, y, interactionDepth(y), 0.78, false, 2)
    }

    function onPointerDown(e) {
      impact(e.clientX, e.clientY, interactionDepth(e.clientY), 1.75, true, 14)
    }

    function onTouchStart(e) {
      var t = e.touches && e.touches[0]
      if (t) impact(t.clientX, t.clientY, interactionDepth(t.clientY), 1.75, true, 14)
    }

    function onTouchMove(e) {
      var t = e.touches && e.touches[0]
      if (!t) return
      var now = performance.now()
      if (now - lastMoveTs < 42) return
      lastMoveTs = now
      impact(t.clientX, t.clientY, interactionDepth(t.clientY), 0.78, false, 2)
    }

    function bindInteraction() {
      if (!opt.interactive) return
      if (root.PointerEvent) {
        root.addEventListener('pointermove', onPointerMove, { passive: true })
        root.addEventListener('pointerdown', onPointerDown, { passive: true })
      } else {
        root.addEventListener('touchstart', onTouchStart, { passive: true })
        root.addEventListener('touchmove', onTouchMove, { passive: true })
        root.addEventListener('mousemove', onPointerMove, { passive: true })
        root.addEventListener('mousedown', onPointerDown, { passive: true })
      }
    }

    function unbindInteraction() {
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('mousemove', onPointerMove)
      root.removeEventListener('mousedown', onPointerDown)
    }

    // ---- 更新 ---------------------------------------------------------------
    function updateRipples(dt) {
      var arr = ripples.active
      for (var i = arr.length - 1; i >= 0; i -= 1) {
        var r = arr[i]
        r.age += dt
        if (r.age >= r.life) ripples.releaseAt(i)
      }
    }

    function updateSplashes(dt) {
      var arr = splashes.active
      for (var i = arr.length - 1; i >= 0; i -= 1) {
        var p = arr[i]
        p.age += dt
        if (p.age >= p.life) { splashes.releaseAt(i); continue }
        p.vy += 920 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
      }
    }

    function updateDrops(dt) {
      var arr = drops.active
      for (var i = 0; i < arr.length; i += 1) {
        var d = arr[i]
        var L = LAYERS[d.layer]
        d.x += (wind * d.speed + Math.sin(time * d.wf + d.phase) * d.wobble * 0.35) * dt
        d.y += d.speed * dt
        if (d.y >= d.landY) {
          var depth = clamp((d.landY - gy) / groundRange, 0, 1)
          if (Math.random() < L.impact) {
            impact(d.x, d.landY, depth, L.strength, false,
              QUALITY[quality].splash && Math.random() < 0.22 ? 2 + (Math.random() * 2 | 0) : 0)
          }
          resetDrop(d, false)
        } else if (d.x < -140 || d.x > W + 140) {
          resetDrop(d, false)
        }
      }
    }

    // ---- 绘制 ---------------------------------------------------------------
    function drawRainLayer(li) {
      var L = LAYERS[li]
      var arr = drops.active
      var q = QUALITY[quality]
      for (var i = 0; i < arr.length; i += 1) {
        var d = arr[i]
        if (d.layer !== li) continue

        var len = d.len
        var hx = d.x, hy = d.y
        var tx = hx - wind * len + d.tailJitter
        var ty = hy - len
        var cx = (tx + hx) * 0.5 + d.bend * len * 0.30 +
          Math.sin(time * d.wf + d.phase) * d.wobble * 0.28
        var cy = hy - len * 0.52

        // 尾部 -> 头部 的真实线性渐变，头部亮、尾部渐隐。
        var g = ctx.createLinearGradient(tx, ty, hx, hy)
        for (var s = 0; s < stops.length; s += 1) g.addColorStop(stops[s][0], stops[s][1])
        ctx.strokeStyle = g

        ctx.beginPath()
        ctx.moveTo(tx, ty)
        ctx.quadraticCurveTo(cx, cy, hx, hy)

        if (L.blur) {
          // 远层：只保留宽而淡的一层，看上去是略微失焦的细密雨雾。
          ctx.globalAlpha = d.alpha * 0.62
          ctx.lineWidth = d.width * 2.6
          ctx.stroke()
        } else {
          if (q.halo && li === 2) {
            // 近层：同一渐变的宽晕 + 尾迹，形成明显运动模糊。
            ctx.globalAlpha = d.alpha * 0.20
            ctx.lineWidth = d.width * 3.1
            ctx.stroke()
          }
          ctx.globalAlpha = d.alpha
          ctx.lineWidth = d.width
          ctx.stroke()
          if (q.halo && li === 2) {
            // 冷色边缘高光：同一渐变、偏移 0.9px 的细描边。
            ctx.globalAlpha = d.alpha * 0.32
            ctx.lineWidth = Math.max(0.45, d.width * 0.42)
            ctx.beginPath()
            ctx.moveTo(tx + 0.9, ty)
            ctx.quadraticCurveTo(cx + 0.9, cy, hx + 0.9, hy)
            ctx.stroke()
          }
        }
      }
    }

    function drawRipples() {
      var q = QUALITY[quality]
      var arr = ripples.active
      for (var i = 0; i < arr.length; i += 1) {
        var r = arr[i]
        var t = clamp(r.age / r.life, 0, 1)
        var p = 1 - Math.pow(1 - t, 1.7)
        // 非线性衰减，前亮后淡
        var a = Math.pow(1 - t, 2.35) * r.alpha
        var R = r.maxR * p
        if (R < 0.6) R = 0.6

        // 边缘亮、中心透明：预渲染的环形辉光（不填充中心）
        if (q.glow && a > 0.012) {
          ctx.globalAlpha = a * 0.75
          ctx.drawImage(ringGlow, r.x - R, r.y - R * r.k, R * 2, R * 2 * r.k)
        }

        // 2~3 圈同心椭圆，透视压扁 + 随机相位 / 偏移 / 扁率
        ctx.strokeStyle = pal.ring
        ctx.lineWidth = 0.8 + 1.0 * (1 - t)
        for (var n = 0; n < r.ringCount; n += 1) {
          var pn = clamp(p + r.ringPhase[n], 0, 1)
          var rn = r.maxR * (1 - n * 0.29) * r.ringScale[n] * (1 - Math.pow(1 - pn, 1.7))
          if (rn < 0.9) continue
          ctx.globalAlpha = a * (1 - n * 0.24)
          ctx.beginPath()
          ctx.ellipse(r.x + r.offX[n], r.y + r.offY[n],
            rn, Math.max(0.5, rn * r.k * r.ringK[n]), 0, 0, TAU)
          ctx.stroke()
        }

        // (a) 水膜冲击环：0.22s 内快速扩散的小环，与涟漪同一 age
        if (q.shock) {
          var st = clamp(r.age / 0.22, 0, 1)
          if (st < 1) {
            var sr = r.maxR * 0.52 * easeOut(st) + 1.5
            ctx.globalAlpha = Math.pow(1 - st, 1.8) * r.alpha * 0.95
            ctx.strokeStyle = pal.shock
            ctx.lineWidth = 1.15
            ctx.beginPath()
            ctx.ellipse(r.x, r.y, sr, Math.max(0.5, sr * r.k * 0.9), 0, 0, TAU)
            ctx.stroke()
          }
        }

        // (c) 一闪而过的高光点，同样取自同一 age，严格同一帧触发
        var ft = clamp(r.age / 0.115, 0, 1)
        if (ft < 1) {
          var fa = (1 - ft) * (1 - ft) * r.alpha
          var fs = 9 + 17 * (1 - ft)
          ctx.globalAlpha = fa
          ctx.drawImage(pointGlow, r.x - fs / 2, r.y - fs / 2, fs, fs)
        }
      }
    }

    function drawSplashes() {
      var arr = splashes.active
      if (!arr.length) return
      ctx.strokeStyle = pal.splash
      for (var i = 0; i < arr.length; i += 1) {
        var p = arr[i]
        var t = clamp(p.age / p.life, 0, 1)
        ctx.globalAlpha = (1 - t) * 0.8
        ctx.lineWidth = p.size
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(p.x - p.vx * 0.012, p.y - p.vy * 0.012)
        ctx.stroke()
      }
    }

    function render() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(bg, 0, 0, W, H)

      // 天光在最远处（雨丝从光里穿下来），尘埃挂在光束上，雨丝最后压上来。
      drawShafts()
      drawMotes()

      drawRainLayer(0)
      drawRainLayer(1)
      drawRainLayer(2)

      // 'lighter' 让涟漪 / 水花 / 反光自然叠加
      ctx.globalCompositeOperation = 'lighter'
      drawRipples()
      drawSplashes()
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    // ---- 帧率自适应降级 -----------------------------------------------------
    function monitor(dtMs) {
      if (warmup > 0) { warmup -= 1; return }
      ema += (dtMs - ema) * 0.07
      if (ema > 20.5) { bad += 1; good = 0 } else if (ema < 15.2) { good += 1; bad = 0 }
      else { bad = Math.max(0, bad - 1); good = Math.max(0, good - 1) }
      if (bad > 45 && quality > 0) {
        setQuality(quality - 1)
        bad = 0
      } else if (good > 420 && quality < 3) {
        setQuality(quality + 1)
        good = 0
      }
    }

    function frame(ts) {
      if (!running || !visible || destroyed) { raf = 0; return }
      raf = root.requestAnimationFrame(frame)
      if (!lastTs) lastTs = ts
      var dtMs = ts - lastTs
      lastTs = ts
      // 钳制 dt：切回标签页 / 长任务后不出现瞬移
      if (dtMs > 50) dtMs = 50
      var dt = dtMs / 1000
      time += dt
      // 只有一层很轻的自然摆动，不再有阵风：雨丝倾角保持稳定。
      wind = baseWindValue + Math.sin(time * 0.21) * 0.045 + Math.sin(time * 0.071) * 0.030

      monitor(dtMs)
      updateRipples(dt)
      updateSplashes(dt)
      updateMotes(dt)
      updateDrops(dt)   // 本帧新产生的涟漪 age = 0，冲击环与高光点同帧亮起
      render()
    }

    function syncRun() {
      var should = running && visible && !destroyed
      if (should && !raf) {
        lastTs = 0
        raf = root.requestAnimationFrame(frame)
      } else if (!should && raf) {
        root.cancelAnimationFrame(raf)
        raf = 0
      }
    }

    function onVisibility() {
      visible = !document.hidden
      syncRun()
    }

    function onResize() {
      root.clearTimeout(resizeTimer)
      resizeTimer = root.setTimeout(resize, 120)
    }

    function setQuality(n) {
      var next = clamp(Math.round(n), 0, 3)
      if (next === quality) return quality
      quality = next
      resize()
      // 立即收敛到新档位的水花上限
      if (!QUALITY[quality].splash) splashes.clear()
      return quality
    }

    var api = {
      start: function () { running = true; syncRun(); return api },
      stop: function () { running = false; syncRun(); return api },
      pause: function () { return api.stop() },
      resume: function () { return api.start() },
      resize: resize,
      setQuality: setQuality,
      getQuality: function () { return quality },
      setWind: function (v) { baseWindValue = clamp(v, -0.6, 0.6); return api },
      // 断点 / 参数微调用：合并配置后原地 resize，不重建画布也不重排雨滴。
      configure: function (patch) {
        if (!patch) return api
        var remotes = patch.motes, reray = patch.rays
        for (var key in patch) if (patch[key] !== undefined) opt[key] = patch[key]
        // 光源一动，径向包络与顶部亮雾都得重算 —— 它们是按光源坐标预渲染的。
        if (patch.lightX !== undefined || patch.lightY !== undefined) {
          burstGrad = null
          bloomTile.width = 0
          buildBloomTile()
        }
        if (reray !== undefined) seedRays()
        else if (remotes !== undefined) seedMotes()
        resize()
        return api
      },
      // 外部触发一次强冲击（点击/暴雨水花）
      burst: function (x, y, strength, splashCount) {
        impact(x == null ? W * 0.5 : x, y == null ? gy + groundRange * 0.5 : y,
          interactionDepth(y == null ? gy + groundRange * 0.5 : y),
          strength == null ? 1.8 : strength, true, splashCount == null ? 14 : splashCount)
        return api
      },
      stats: function () {
        return {
          fps: Math.round(1000 / Math.max(1, ema)),
          quality: quality,
          drops: drops.active.length,
          ripples: ripples.active.length,
          splashes: splashes.active.length,
          dpr: dpr,
          wind: wind,
          rays: Math.min(opt.rays, QUALITY[quality].ray, rays.length),
          motes: Math.min(motes.length, QUALITY[quality].mote || 0)
        }
      },
      destroy: function () {
        if (destroyed) return
        destroyed = true
        running = false
        root.clearTimeout(resizeTimer)
        root.cancelAnimationFrame(raf)
        raf = 0
        root.removeEventListener('resize', onResize)
        root.removeEventListener('orientationchange', onResize)
        document.removeEventListener('visibilitychange', onVisibility)
        unbindInteraction()
        drops.clear(); ripples.clear(); splashes.clear()
        ctx.clearRect(0, 0, W, H)
      }
    }

    resize()
    root.addEventListener('resize', onResize, { passive: true })
    root.addEventListener('orientationchange', onResize, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    bindInteraction()
    return api
  }

  root.MistlaneRain = { createRainEngine: createRainEngine }
})(typeof window !== 'undefined' ? window : this)
