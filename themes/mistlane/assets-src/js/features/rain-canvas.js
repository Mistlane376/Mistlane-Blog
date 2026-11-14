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
    { drop: 0.42, dpr: 1, glow: false, shock: false, splash: false, halo: false, rings: 1 },
    { drop: 0.62, dpr: 1.5, glow: true, shock: true, splash: false, halo: false, rings: 2 },
    { drop: 0.82, dpr: 2, glow: true, shock: true, splash: true, halo: true, rings: 2 },
    { drop: 1.00, dpr: 2, glow: true, shock: true, splash: true, halo: true, rings: 3 }
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

    var drops = createPool(MAX_DROPS, makeDrop)
    var ripples = createPool(MAX_RIPPLES, makeRipple)
    var splashes = createPool(MAX_SPLASHES, makeSplash)

    var W = 1, H = 1, dpr = 1, gy = 1, groundRange = 1
    var running = false, visible = !document.hidden, destroyed = false
    var raf = 0, lastTs = 0, time = 0, resizeTimer = 0
    var baseWindValue = opt.baseWind, wind = baseWindValue
    var quality = 3, ema = 16.7, warmup = 40, bad = 0, good = 0
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

    // ---- resize：重建画布 / 背景 / 地面参数，等比迁移已有雨滴 ---------------
    function resize() {
      if (destroyed) return
      var oldW = W, oldH = H, oldGy = gy, oldRange = groundRange
      W = Math.max(1, canvas.clientWidth || window.innerWidth || 1)
      H = Math.max(1, canvas.clientHeight || window.innerHeight || 1)
      dpr = clamp(window.devicePixelRatio || 1, 1, Math.min(opt.maxDpr, QUALITY[quality].dpr))
      gy = H * clamp(opt.horizonRatio, 0.2, 0.92)
      groundRange = Math.max(120, H - gy)

      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      buildBackground()

      if (oldW > 1 && oldH > 1) {
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
      wind = baseWindValue + Math.sin(time * 0.21) * 0.045 + Math.sin(time * 0.071) * 0.030

      monitor(dtMs)
      updateRipples(dt)
      updateSplashes(dt)
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
      quality = clamp(Math.round(n), 0, 3)
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
          wind: wind
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
