/*
 * Mistlane cinematic night sky — Canvas 2D engine (starfield + falling petals).
 *
 * Loaded as a plain script (no imports/exports) on purpose: the theme bundle
 * imports it for its side effect, and the standalone preview page can inline
 * the very same file over file:// without a module server. Public surface:
 * `window.MistlaneNightSky.createNightSkyEngine`.
 *
 * Why Canvas 2D only
 * ------------------
 * Every element here is a sub-2px dot, a soft gradient or a ~20px bezier path.
 * There is no per-pixel shading, no geometry and no texture sampling that
 * would benefit from a GPU shader. A WebGL context would add shader/VAO/FBO
 * bookkeeping, a second context to lose on mobile, and no measurable win for
 * a few thousand tiny draw calls. 2D + one offscreen prerender + batching is
 * the cheaper and more robust choice for a blog background.
 *
 * Frame budget
 * ------------
 * - Sky base / milky-way dust / nebulae / extinction / grain / vignette are
 *   baked ONCE into `bg` (1x CSS pixels, soft gradients only) and blitted once
 *   per frame. `devicePixelRatio` is applied to the live canvas for crisp dots.
 * - Stars are NOT drawn one by one with a style each frame: brightness is
 *   quantised into 8 alpha buckets, stars are scattered into preallocated
 *   Float32Arrays by (layer, colour, bucket), then each group is filled with
 *   ONE path + ONE fillStyle + ONE globalAlpha. 96 state changes max.
 * - Petal outlines are four cubic Béziers + a tip cap (root narrow, asymmetric
 *   shoulders, round / notched tip), stored in two Path2D objects created once.
 *   Each (colour x SHADES brightness level) owns ONE prebuilt linear gradient
 *   in unit local space, so a petal flip is a continuous brightness ramp rather
 *   than a two-state switch. Main vein / side veins / rim highlight are two
 *   more prebuilt paths. The hot loop creates no gradients and no strings.
 * - Petals / meteors / cursor shards live in free-list pools; no `new` in the
 *   hot loop. The pointer leaves a trail of tiny "shard" swirls: each shard
 *   orbits its own centre (angle + shrinking/expanding radius), rises and
 *   fades, using the same colour table but a narrower shard Path2D.
 * - A click does NOT touch the wind field or the falling petals — it blooms a
 *   ring of larger shards at the click point (fast radial expansion that
 *   decelerates, petals visibly open while fading), sharing the same pool.
 */
;(function (root) {
  'use strict'

  var TAU = Math.PI * 2
  var HALF_PI = Math.PI / 2
  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
  var rand = function (lo, hi) { return lo + Math.random() * (hi - lo) }

  /* ---- 快速三角函数：4096 步正弦查表 ------------------------------------
   * 星点闪烁 + 层间视差 + 花瓣摆锤 + 碎花自转，每帧要算 3000 以上次 sin/cos，
   * 是整段动画里最密集的一处 CPU 开销。查表 + 取整索引比 Math.sin 快数倍，
   * 4096 步的量化误差 < 1e-3，落到亚像素位移和 8 档亮度上完全不可见。
   * 索引取模用「减整数部分」而非 `%`：对负数同样成立，且没有取模的额外分支。
   * ------------------------------------------------------------------- */
  var SIN_BITS = 12
  var SIN_N = 1 << SIN_BITS
  var SIN_TAB = new Float32Array(SIN_N + 1)
  for (var sinInit = 0; sinInit <= SIN_N; sinInit += 1) {
    SIN_TAB[sinInit] = Math.sin(sinInit / SIN_N * TAU)
  }
  var INV_TAU = 1 / TAU
  function sinL(x) {
    var u = x * INV_TAU
    u -= u | 0                 // 去掉整数周期（向零截断，负值下会落到 (-1,0)）
    if (u < 0) u += 1
    return SIN_TAB[(u * SIN_N) | 0]
  }
  function cosL(x) { return sinL(x + HALF_PI) }

  /* =====================================================================
   * CONFIG — 全部可调参数（每项中文注释）。createNightSkyEngine 的第二参数
   * 会浅合并覆盖这里的默认值；预览页可通过 engine.configure() 实时调整。
   * ===================================================================== */
  var CONFIG = {
    starCount: 900,            // 星点总数上限（三层合计；画质降级时按比例缩减，硬上限 1600）
    milkyWayDensity: 1.0,      // 银河密度场倍率：越大带内尘埃/星点越密
    milkyWayAngle: -0.42,      // 银河带倾角（弧度；负值＝左下→右上的斜带）
    milkyWayWidth: 0.17,       // 银河带半宽（相对视口高度）
    twinkleSpeed: 1.0,         // 闪烁速度总倍率；单星频率 0.2~2Hz 独立随机
    meteorChance: 1.0,         // 流星频率倍率（在基础间隔上做除法）
    meteorGap: [4, 12],        // 流星触发间隔范围（秒，低频随机）
    petalCount: 110,           // 同时在场（含落地停留）的花瓣上限
    windBase: 16,              // 全局基础风力（CSS px/s，正值向右）
    gustStrength: 1.0,         // 阵风强度倍率：影响水平速度 / 摆幅 / 下落减速
    gustGap: [5, 11],          // 自然阵风的间隔范围（秒）
    fallSpeed: 62,             // 花瓣垂直基准下落速度（CSS px/s）
    swingAmplitude: 26,        // 水平正弦摆动（落叶摆锤）基准振幅（CSS px）
    swingHarmonic: 0.26,       // 摆动二次谐波比例：让摆锤轨迹不是标准正弦（0 = 纯正弦）
    petalDrag: 0.55,           // 逐片风阻差异：0 = 一阵风下整片同步平移，越大越错落自然
    gustAttack: 0.30,          // 阵风起风段占比（0~0.5）：越小越「骤起缓落」，段落感越强
    petalSheen: 0.78,          // 花瓣边缘高光 / 脉络强度倍率（0 = 关闭，最低画质自动关闭）
    landBlendTime: 0.24,       // 落地压扁过渡时长（秒），避免触地瞬间变成椭圆
    settleTremor: 0.035,       // 贴地花瓣随阵风轻微颤动的角度幅度（弧度）
    ghostTrail: 1.0,           // 近景叠影沿运动方向的偏移倍率（0 = 固定偏移）
    groundY: 0.80,             // 地面平面／视平线位置（视口高度比例）
    perspective: 0.42,         // 透视压缩系数：近处落地花瓣的 ry/rx 上限
    minFlatten: 0.10,          // 最远处落地花瓣的 ry/rx（越远越扁）
    layerCount: 3,             // 花瓣景深层数（≥3：远 / 中 / 近）
    nebulaLayers: 3,           // 星云低透明度径向渐变叠加层数（降级时降到 1）
    interactive: true,         // 是否启用鼠标/触摸交互（碎花螺旋 + 附近星点增亮 + 点击碎花绽放）
    overlay: false,            // true = 嵌入博客：透明底、弱化暗部遮罩，只叠加星点/星云/花瓣，不遮挡正文
    pointerRadius: 150,        // 光标附近星点轻微增亮的影响半径（CSS px）
    swirlEnabled: true,        // 鼠标「碎花螺旋」总开关（false = 只留星点微亮）
    swirlRadius: 26,           // 螺旋半径（CSS px）：小小一团碎花绕中心打旋，刻意不铺满屏幕
    swirlSpeed: 3.6,           // 螺旋角速度（rad/s）；逐片 ±12% 随机，方向随鼠标水平移动翻转
    swirlLife: 1.0,            // 单片碎花寿命（秒，含淡入淡出）
    swirlSize: [5.5, 10.5],    // 碎花尺寸范围（CSS px，明显小于落花，像被卷起的花瓣屑）
    swirlEmitStep: 18,         // 光标每移动多少 CSS px 洒下一批碎花
    swirlPerEmit: 3,           // 每批洒下几片（0 = 停止发射；画质降级时按比例缩减）
    swirlRise: 18,             // 碎花整体上浮速度（CSS px/s），形成「被卷起」的小旋涡
    swirlPull: 0.55,           // 碎花中心向光标收敛强度（0 = 沿轨迹散落，1 = 始终聚成一小团）
    swirlFade: 0.16,           // 单片碎花淡入 / 淡出时长（秒）
    swirlDensity: 1.0,         // 碎花密度总倍率（嵌入博客正文时压低）
    swirlIdle: 0.30,           // 光标静止时每隔多少秒零星补 1 片，维持一小簇（0 = 不补）
    swirlBurst: 12,            // 手动强风（engine.gust / 预览面板）额外卷起的一簇碎花片数
    bloomCount: 20,            // 点击绽放的碎花片数（0 = 关闭点击绽放）
    bloomRadius: 56,           // 绽放散开的目标半径（CSS px）：一圈碎花从点击处向外「绽开」
    bloomLife: 1.35,           // 绽放单片寿命（秒）：前段快速外扩、后段缓缓淡出
    bloomSize: 1.7,            // 绽放碎花相对 swirlSize 的尺寸倍率（比轨迹碎花大一号才明显）
    bloomGlow: 0.55,           // 绽放中心柔光强度（0 = 只有碎片、没有那记闪光）
    maxDpr: 2,                 // devicePixelRatio 上限
    autoQuality: true,         // 自动画质升降；false = 锁死当前档位（预览对比 / 录屏时用）
    vignette: 0.62,            // 暗角强度（0 = 关闭）
    grain: 0.05,               // 极轻微噪点强度，用来打散大面积渐变的色带
    settleTime: [1, 3],        // 落地静止停留时间范围（秒）
    bounceDecay: 0.42,         // 落地一次小反弹的初速衰减系数
    colors: {
      skyTop: '#050914',       // 天顶底色
      skyBottom: '#0b1728',    // 近地平线底色
      nebulaA: '126, 104, 198',// 紫蓝星云
      nebulaB: '84, 148, 182', // 青灰星云
      nebulaC: '74, 116, 182', // 冷蓝星云
      stars: [                 // 星色（加权随机）：冷白 / 蓝白 / 暖黄 / 淡橙
        { rgb: 'rgb(228,240,255)', weight: 0.34 },
        { rgb: 'rgb(180,216,255)', weight: 0.30 },
        { rgb: 'rgb(255,232,188)', weight: 0.24 },
        { rgb: 'rgb(255,202,156)', weight: 0.12 }
      ],
      petals: [                // 花瓣基色：粉 / 白 / 淡黄 / 浅橘（每片再做微扰）
        [255, 196, 216],
        [250, 246, 244],
        [255, 242, 214],
        [255, 224, 194]
      ],
      meteor: '206,232,255',   // 流星拖尾色
      dust: '190,212,255',     // 银河尘埃色
      vein: 'rgba(255,248,250,0.9)',      // 花瓣中央主脉高光
      veinSide: 'rgba(255,236,246,0.62)'  // 侧脉 / 右缘高光（更淡）
    }
  }

  var MAX_STARS = 1600        // 星点硬上限（同时决定分组缓冲容量）
  var MAX_PETALS = 220        // 花瓣对象池容量
  var MAX_METEORS = 6         // 流星对象池容量（含偶尔连发的第 2 颗）
  var MAX_SHARDS = 64         // 碎花对象池硬上限（轨迹一团 + 点击一圈可同时在场上限）
  var SHADES = 7              // 翻面明暗分级数：预生成色阶，翻滚时连续过渡而非突然变暗
  var BUCKETS = 8             // 闪烁亮度分组数（8 组足够平滑，且只 96 次状态切换）
  var GROUP_COUNT = 3 * 4 * BUCKETS

  // 远 / 中 / 近：密度、尺寸、亮度、闪烁幅度、视差幅度全部拉开差异。
  var STAR_LAYERS = [
    { share: 0.60, r: [0.30, 0.68], magScale: 0.52, amp: 0.06, drift: [1.2, 0.7], alpha: 0.72 },
    { share: 0.32, r: [0.55, 1.35], magScale: 1.00, amp: 0.82, drift: [3.0, 1.6], alpha: 1.00 },
    { share: 0.08, r: [1.20, 2.30], magScale: 1.25, amp: 0.52, drift: [5.4, 2.8], alpha: 1.00 }
  ]
  var STAR_CUM = [STAR_LAYERS[0].share, STAR_LAYERS[0].share + STAR_LAYERS[1].share, 1]

  // 0 = 最低画质 ... 3 = 全效果。连续掉帧逐级下降，长时间流畅再回升。
  var QUALITY = [
    { star: 0.40, petal: 0.36, nebula: 1, dpr: 1.00, spike: false, halo: false, ghost: false, glow: false },
    { star: 0.62, petal: 0.58, nebula: 2, dpr: 1.25, spike: true, halo: true, ghost: false, glow: false },
    { star: 0.82, petal: 0.80, nebula: 2, dpr: 1.60, spike: true, halo: true, ghost: true, glow: true },
    { star: 1.00, petal: 1.00, nebula: 3, dpr: 2.00, spike: true, halo: true, ghost: true, glow: true }
  ]

  // ---- 小型确定性值噪声：银河密度场与带形扰动，全程无对象分配 ---------------
  function hash2(ix, iy) {
    var h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0
    h = (h ^ (h >>> 13)) | 0
    h = Math.imul(h, 1274126177) | 0
    h = (h ^ (h >>> 16)) | 0
    return (h & 0x7fffffff) / 1073741824 - 1
  }
  function smoothstep(t) { return t * t * (3 - 2 * t) }
  // 非对称阵风包络：attack 之前快速起风，之后缓慢收尾，形成「被吹起」的段落感。
  function gustEnvelope(age, life, attack) {
    var a = clamp(attack, 0.08, 0.48)
    var t = clamp(age / Math.max(0.001, life), 0, 1)
    return t < a ? Math.pow(t / a, 0.75) : Math.pow((1 - t) / (1 - a), 1.6)
  }
  function noise2(x, y) {
    var ix = Math.floor(x), iy = Math.floor(y)
    var fx = smoothstep(x - ix), fy = smoothstep(y - iy)
    var a = hash2(ix, iy), b = hash2(ix + 1, iy)
    var c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1)
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
  }

  // ---- 对象池：预分配 + swap-remove 回收，热循环零 new -----------------------
  function createPool(size, factory) {
    var active = [], free = []
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
      clear: function () { while (active.length) free.push(active.pop()) }
    }
  }

  function makePetal() {
    return { layer: 0, depth: 0, size: 10, alpha: 0.6, colorIdx: 0, shapeIdx: 0,
      phase: 0, swingFreq: 1, swingAmp: 20, wobbleFreq: 2, wobbleAmp: 3,
      angle: 0, spin: 0, tumble: 0, tumbleSpeed: 1, landAngle: 0,
      baseX: 0, fallY: 0, landY: 0, flat: 0.2, vy: 0, drag: 1,
      state: 0, hold: 0, fade: 1, landT: 1, pushX: 0, pushY: 0, pvx: 0, pvy: 0,
      lastX: 0, lastY: 0 }
  }
  function makeMeteor() {
    return { x: 0, y: 0, vx: 0, vy: 0, angle: 0, len: 140, height: 10,
      age: 0, life: 0.6 }
  }
  // 碎花螺旋专用：极坐标（angle / radius）绕自己的中心打旋 + 上浮 + 短寿命。
  // mode 0 = 轨迹螺旋（绕中心打旋、向光标收敛）；mode 1 = 点击绽放（径向快速
  // 外扩减速、边开边放大，留在点击处开放），两种碎花共用同一个对象池。
  function makeShard() {
    return { cx: 0, cy: 0, angle: 0, radius: 0, spin: 0, rVel: 0,
      x: 0, y: 0, size: 5, alpha: 0.9, colorIdx: 0, shapeIdx: 0,
      tilt: 0, tiltSpin: 0, tumble: 0, tumbleSpeed: 0,
      age: 0, life: 1, rise: 0, drift: 0, mode: 0 }
  }

  // ---- 一次性贴图：流星拖尾 / 头部辉光 / 噪点（都不是外部图片资源） ---------
  function buildMeteorSprite(rgb) {
    var c = document.createElement('canvas')
    c.width = 256; c.height = 24
    var g = c.getContext('2d')
    var lg = g.createLinearGradient(0, 0, 256, 0)
    lg.addColorStop(0.00, 'rgba(' + rgb + ',0)')
    lg.addColorStop(0.42, 'rgba(' + rgb + ',0.06)')
    lg.addColorStop(0.76, 'rgba(' + rgb + ',0.40)')
    lg.addColorStop(0.95, 'rgba(' + rgb + ',0.92)')
    lg.addColorStop(1.00, 'rgba(255,255,255,1)')
    g.fillStyle = lg
    g.fillRect(0, 0, 256, 24)
    // 竖向羽化：尾迹不是硬边矩形，而是一条细长渐变光带。
    var vg = g.createLinearGradient(0, 0, 0, 24)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(0.5, 'rgba(0,0,0,1)')
    vg.addColorStop(1, 'rgba(0,0,0,0)')
    g.globalCompositeOperation = 'destination-in'
    g.fillStyle = vg
    g.fillRect(0, 0, 256, 24)
    return c
  }

  function buildHeadGlow(rgb) {
    var c = document.createElement('canvas')
    c.width = c.height = 64
    var g = c.getContext('2d')
    var rg = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    rg.addColorStop(0, 'rgba(255,255,255,0.95)')
    rg.addColorStop(0.18, 'rgba(' + rgb + ',0.65)')
    rg.addColorStop(0.55, 'rgba(' + rgb + ',0.16)')
    rg.addColorStop(1, 'rgba(' + rgb + ',0)')
    g.fillStyle = rg
    g.fillRect(0, 0, 64, 64)
    return c
  }

  // 绽放闪光：一小团粉白柔光（径向渐变贴图，只建一次）。点击瞬间在中心快速
  // 扩散并淡出，给「绽放」一记明确的起势，而不只是碎片的位移。
  function buildBloomGlow() {
    var c = document.createElement('canvas')
    c.width = c.height = 96
    var g = c.getContext('2d')
    var rg = g.createRadialGradient(48, 48, 0, 48, 48, 48)
    rg.addColorStop(0, 'rgba(255,238,244,0.88)')
    rg.addColorStop(0.22, 'rgba(255,216,230,0.44)')
    rg.addColorStop(0.55, 'rgba(255,198,218,0.13)')
    rg.addColorStop(1, 'rgba(255,190,212,0)')
    g.fillStyle = rg
    g.fillRect(0, 0, 96, 96)
    return c
  }
  function buildGrainTile(scale) {
    var c = document.createElement('canvas')
    // 按 devicePixelRatio 生成：静态层现在也按 dpr 渲染，tile 如果还是 128 逻辑像素，
    // 噪点会被放大 dpr 倍、变成明显的「粗颗粒」。这里让一个 tile 的物理像素数
    // 正好等于它在 dpr 变换下的显示尺寸，噪点保持 1 设备像素的细腻度。
    var s = clamp(Math.round(scale), 1, 3)
    var n = 128 * s
    c.width = c.height = n
    var g = c.getContext('2d')
    var img = g.createImageData(n, n)
    var d = img.data
    for (var i = 0; i < d.length; i += 4) {
      var v = 190 + (Math.random() * 65) | 0
      d[i] = v; d[i + 1] = v; d[i + 2] = v + 6
      d[i + 3] = (Math.random() * 70) | 0
    }
    g.putImageData(img, 0, 0)
    return c
  }

  // 星芒贴图：近层亮星的四芒十字。以前每帧给每颗亮星现建 2 个 linearGradient，
  // 一帧就是 32 次渐变对象分配（还会喂 GC）。现在烘成一张 96px 贴图，
  // 绘制时只做一次带缩放的 drawImage —— 形状和亮度响应都一致，成本降到 1/10。
  function buildSpikeSprite(rgb) {
    var S = 96, c = document.createElement('canvas')
    c.width = c.height = S
    var g = c.getContext('2d')
    var mid = S / 2
    // 水平长芒：两端完全透明 → 中心近白。条体只有 4px，缩放到实际半径后
    // 由抗锯齿自然柔化上下边，和原来 1.5px fillRect 的观感一致。
    var lg = g.createLinearGradient(0, 0, S, 0)
    lg.addColorStop(0, 'rgba(' + rgb + ',0)')
    lg.addColorStop(0.40, 'rgba(' + rgb + ',0.26)')
    lg.addColorStop(0.50, 'rgba(240,247,255,0.95)')
    lg.addColorStop(0.60, 'rgba(' + rgb + ',0.26)')
    lg.addColorStop(1, 'rgba(' + rgb + ',0)')
    g.fillStyle = lg
    g.fillRect(0, mid - 2, S, 4)
    // 垂直短芒：更细更暗，让四芒是「一亮一暗」而不是正十字。
    var vg = g.createLinearGradient(0, 0, 0, S)
    vg.addColorStop(0, 'rgba(' + rgb + ',0)')
    vg.addColorStop(0.40, 'rgba(' + rgb + ',0.20)')
    vg.addColorStop(0.50, 'rgba(238,246,255,0.70)')
    vg.addColorStop(0.60, 'rgba(' + rgb + ',0.20)')
    vg.addColorStop(1, 'rgba(' + rgb + ',0)')
    g.fillStyle = vg
    g.fillRect(mid - 1.4, 0, 2.8, S)
    return c
  }

  // ---- 花瓣轮廓：四段三次贝塞尔 + 尖端二次曲线收口（圆 / 微凹） -------------
  // 局部坐标：根部 (0,0) 窄，尖端 (0,-1)。相比「两段贝塞尔」多出肩部转折：
  // 根部收窄 → 下腹外鼓 → 肩部内收 → 尖端圆弧/微凹；左右控制点始终不对称，
  // 因此轮廓有真实花瓣的偏斜感，而不是对称椭圆。
  function makePetalPath(path, notch) {
    var tipY = notch ? -0.955 : -1.0
    path.moveTo(0, 0)
    path.bezierCurveTo(-0.12, -0.10, -0.40, -0.30, -0.50, -0.52)   // 左下缘：窄根展开
    path.bezierCurveTo(-0.60, -0.74, -0.30, -0.94, -0.055, tipY)   // 左肩：外鼓后内收
    if (notch) path.quadraticCurveTo(0, -0.886, 0.055, tipY)       // 尖端微凹
    else path.quadraticCurveTo(0, tipY - 0.055, 0.055, tipY)        // 尖端圆弧
    path.bezierCurveTo(0.26, -0.95, 0.52, -0.76, 0.44, -0.50)     // 右肩（不对称）
    path.bezierCurveTo(0.36, -0.28, 0.13, -0.09, 0, 0)            // 右下缘收回根部
    path.closePath()
  }

  // 碎花：比完整花瓣更窄更尖的「花瓣屑」，两种不规则轮廓（尖端圆 / 带小凹口）。
  function makeShardPath(path, kind) {
    path.moveTo(0, 0)
    if (kind === 0) {
      path.bezierCurveTo(-0.14, -0.13, -0.42, -0.55, -0.045, -1.0)
      path.quadraticCurveTo(0.01, -1.04, 0.07, -0.93)
      path.bezierCurveTo(0.34, -0.60, 0.16, -0.11, 0, 0)
    } else {
      path.bezierCurveTo(-0.34, -0.16, -0.40, -0.62, -0.06, -0.90)
      path.quadraticCurveTo(0.015, -0.80, 0.05, -0.92)             // 尖端小凹口
      path.bezierCurveTo(0.29, -0.58, 0.19, -0.10, 0, 0)
    }
    path.closePath()
  }

  // 脉络：主脉单独一条（稍亮）；侧脉 4 条 + 右缘高光合成一条（更淡），
  // 各只需一次 stroke，避免逐片多次设置样式。
  function makeVeinPaths(main, detail) {
    main.moveTo(0, -0.03)
    main.bezierCurveTo(0.055, -0.30, 0.05, -0.62, 0.006, -0.88)
    detail.moveTo(0.02, -0.26); detail.quadraticCurveTo(-0.13, -0.40, -0.31, -0.52)
    detail.moveTo(0.03, -0.44); detail.quadraticCurveTo(-0.10, -0.60, -0.22, -0.76)
    detail.moveTo(0.02, -0.30); detail.quadraticCurveTo(0.13, -0.44, 0.30, -0.55)
    detail.moveTo(0.03, -0.49); detail.quadraticCurveTo(0.12, -0.64, 0.21, -0.78)
    detail.moveTo(0.10, -0.10); detail.bezierCurveTo(0.30, -0.30, 0.40, -0.56, 0.31, -0.78)
  }
  function makeShardVein(path) {
    path.moveTo(0, -0.04)
    path.quadraticCurveTo(0.02, -0.45, 0, -0.86)
  }

  function createNightSkyEngine(canvas, options) {
    if (!canvas || !canvas.getContext) throw new Error('[night-sky] a canvas element is required')

    var opt = {}
    for (var key in CONFIG) opt[key] = CONFIG[key]
    if (options) for (var k in options) if (options[k] !== undefined) opt[k] = options[k]

    // 非叠加模式把画布声明为不透明：合成器可以跳过 alpha 通道，省掉每帧一次
    // 全屏混合。叠加到博客正文上时必须保留 alpha，否则半透明夜幕会变成实心黑块。
    var ctx = canvas.getContext('2d', { alpha: !!opt.overlay }) || canvas.getContext('2d')
    var bg = document.createElement('canvas')       // 静态层：银河 / 星云 / 暗角 / 噪点
    var meteorSprite = buildMeteorSprite(opt.colors.meteor)
    var headGlow = buildHeadGlow(opt.colors.meteor)
    var bloomGlow = buildBloomGlow()
    var spikeSprite = buildSpikeSprite(opt.colors.meteor)
    // 噪点 tile 按 dpr 缓存：画质升降会改 dpr，缓存住避免每次 resize 重新生成。
    var grainTiles = {}
    function grainTileFor(scale) {
      var s = clamp(Math.round(scale), 1, 3)
      if (!grainTiles[s]) grainTiles[s] = buildGrainTile(s)
      return grainTiles[s]
    }

    var petalPaths = [new Path2D(), new Path2D()]
    makePetalPath(petalPaths[0], false)
    makePetalPath(petalPaths[1], true)
    var shardPaths = [new Path2D(), new Path2D()]
    makeShardPath(shardPaths[0], 0)
    makeShardPath(shardPaths[1], 1)
    var veinMain = new Path2D(), veinDetail = new Path2D(), shardVein = new Path2D()
    makeVeinPaths(veinMain, veinDetail)
    makeShardVein(shardVein)

    // 星色：初始化时预拼字符串，热循环不拼 rgba。
    var starRGB = [], starCum = [], acc = 0
    for (var ci = 0; ci < opt.colors.stars.length; ci += 1) {
      starRGB.push(opt.colors.stars[ci].rgb)
      acc += opt.colors.stars[ci].weight
      starCum.push(acc)
    }

    // 花瓣明暗色阶：cos(翻滚角) 从 -1（反面）到 +1（正面）连续映射到 SHADES
    // 级，不再是「正/反」二值突变。每个 (颜色 × 色阶) 预建一个线性渐变：
    // 根部略深 → 腹部本色 → 尖端透亮，横坐标略斜以配合轮廓的不对称。
    // 渐变坐标定义在单位局部空间，绘制时随 CTM 一起变换，因此只需建一次。
    function shadeRGB(base, k, whiten) {
      var r = clamp(base[0] * k + 255 * whiten, 0, 255) | 0
      var g = clamp(base[1] * k + 252 * whiten, 0, 255) | 0
      var b = clamp(base[2] * k + 250 * whiten, 0, 255) | 0
      return 'rgb(' + r + ',' + g + ',' + b + ')'
    }
    var petalGrad = [], petalSolid = [], petalBases = []
    // 每个基色只做 3 档微扰（原来是 5 档）：渐变对象从 140 个降到 84 个。
    // 每片花瓣换 fillStyle 就等于换一次 Skia shader，数量越少，一帧里的
    // shader 切换越少；而这 12 种粉白微差在暗底上已经足够看出层次。
    for (var pi = 0; pi < opt.colors.petals.length; pi += 1) {
      for (var vi = 0; vi < 3; vi += 1) {
        var b0 = opt.colors.petals[pi]
        var shift = rand(-8, 8), light = rand(-12, 12)
        var base = [
          clamp(b0[0] + shift + light, 0, 255),
          clamp(b0[1] + shift * 0.5 + light, 0, 255),
          clamp(b0[2] - shift * 0.5 + light, 0, 255)
        ]
        petalBases.push(base)
        for (var sh = 0; sh < SHADES; sh += 1) {
          var k = 0.66 + 0.34 * (sh / (SHADES - 1))     // 反面 0.66 → 正面 1.00
          petalSolid.push(shadeRGB(base, k, 0))
          var grad = ctx.createLinearGradient(0, 0.04, 0.06, -1.0)
          grad.addColorStop(0.00, shadeRGB(base, k * 0.62, 0))
          grad.addColorStop(0.22, shadeRGB(base, k * 0.90, 0))
          grad.addColorStop(0.62, shadeRGB(base, k, 0.02))
          grad.addColorStop(1.00, shadeRGB(base, k, 0.28))
          petalGrad.push(grad)
        }
      }
    }
    var petalVariants = petalBases.length

    var petals = createPool(MAX_PETALS, makePetal)
    var meteors = createPool(MAX_METEORS, makeMeteor)
    var shards = createPool(MAX_SHARDS, makeShard)
    // 碎花螺旋发射器：沿光标轨迹按位移留下一串各自打旋的小旋涡。
    var swirl = { x: -9999, y: -9999, dist: 0, idle: 0, dir: 1, phase: 0,
      seen: false, inside: false, speed: 0 }
    // 点击绽放的中心柔光：固定 3 个槽位预分配（连击时最多 3 个闪光同时在场），
    // 只存位置与进度，不进入对象池、不产生垃圾。
    var flares = []
    for (var fl = 0; fl < 3; fl += 1) {
      flares.push({ active: false, x: 0, y: 0, age: 0, life: 0.5 })
    }

    // 星点数据（结构化数组，避免上千个对象）
    var sx = new Float32Array(MAX_STARS), sy = new Float32Array(MAX_STARS)
    var sr = new Float32Array(MAX_STARS), smag = new Float32Array(MAX_STARS)
    var sphase = new Float32Array(MAX_STARS)
    var sext = new Float32Array(MAX_STARS)
    var slayer = new Uint8Array(MAX_STARS), scolor = new Uint8Array(MAX_STARS)
    var spikeAngle = new Float32Array(MAX_STARS)
    // 预存每颗星的派生量：视差相位（0.07 / 0.05 已乘进去）和角频率（×TAU）。
    // 都是生成时就固定下来的常数，每帧再乘一遍纯属浪费。
    var sphDx = new Float32Array(MAX_STARS), sphDy = new Float32Array(MAX_STARS)
    var sfreqT = new Float32Array(MAX_STARS)
    var brightIdx = [], activeStars = 0

    // 分组缓冲：(层 3 × 色 4 × alpha 桶 8) 组，每组 x/y/r 连续存放。
    var groupData = [], groupN = new Int32Array(GROUP_COUNT)
    for (var gi = 0; gi < GROUP_COUNT; gi += 1) groupData.push(new Float32Array(MAX_STARS * 3))

    var W = 1, H = 1, dpr = 1, gy = 1, groundRange = 1
    var running = false, visible = !document.hidden, destroyed = false
    var raf = 0, lastTs = 0, time = 0, resizeTimer = 0
    var quality = 3, ema = 16.7, warmup = 40, bad = 0, good = 0
    var wind = opt.windBase, gust = 0
    var gustTimer = rand(opt.gustGap[0], opt.gustGap[1])
    var gustEv = { active: false, age: 0, life: 1, amp: 0, dir: 1 }
    var burstEv = { active: false, age: 0, life: 1, amp: 0, dir: 1 }
    var meteorTimer = rand(opt.meteorGap[0], opt.meteorGap[1]) * 0.45
    var followTimer = -1
    var pointer = { x: -9999, y: -9999, vx: 0, vy: 0, energy: 0, ts: 0 }
    var layers = []

    // ---- 花瓣景深层：由 layerCount 插值生成，天然支持 ≥3 层 ------------------
    function buildLayers() {
      layers = []
      var n = clamp(Math.round(opt.layerCount), 3, 6)
      var total = 0
      for (var i = 0; i < n; i += 1) {
        var d = i / (n - 1)                       // 0 = 最远，1 = 最近
        var share = 1 - 0.55 * d
        total += share
        layers.push({
          depth: d, share: share,
          size: [5 + 12 * d, 9 + 23 * d],
          speed: 0.40 + 1.02 * d * d,
          alpha: 0.26 + 0.60 * d,
          wind: 0.42 + 0.92 * d,
          halo: d < 0.34,                       // 远层轻微失焦
          ghost: d > 0.66                       // 近层低透明度叠影
        })
      }
      var cum = 0
      for (var j = 0; j < n; j += 1) { cum += layers[j].share / total; layers[j].cum = cum }
      layers[n - 1].cum = 1
    }
    function pickPetalLayer() {
      var r = Math.random()
      for (var i = 0; i < layers.length; i += 1) if (r < layers[i].cum) return i
      return layers.length - 1
    }

    function bandY(x) {
      return H * 0.36 + (x - W * 0.5) * Math.tan(opt.milkyWayAngle) +
        noise2(x / W * 2.4 + 3.1, 0.37) * H * 0.055
    }
    // 带状噪声密度场：带内高、带外仅留极稀疏本底。
    function milkyDensity(x, y) {
      var d = (y - bandY(x)) * Math.cos(opt.milkyWayAngle) / (H * opt.milkyWayWidth)
      var f = Math.exp(-d * d * 1.25)
      var n = 0.5 + 0.5 * noise2(x / W * 4.2 + 11, y / H * 5.3 + 7)
      return clamp(f * (0.45 + 0.75 * n) + 0.028, 0, 1.2)
    }
    function extinction(y) {
      var t = clamp((y - H * 0.48) / (H * 0.52), 0, 1)
      return clamp(1 - Math.pow(t, 1.25) * 0.88, 0.12, 1)
    }
    function flatten(depth) {
      return opt.minFlatten + (opt.perspective - opt.minFlatten) * Math.pow(depth, 1.3)
    }
    function landYFor(depth) { return gy + depth * groundRange * 0.94 }

    // ---- 静态背景：一次绘制，之后每帧只做一次 drawImage ----------------------
    function buildBackground() {
      // 静态层按 dpr 光栅化。多画一次的成本只发生在 resize 时，而它换来的是：
      // 每帧的 drawImage 变成 1:1 位块拷贝，不再需要把 1x 背景双线性上采样到
      // 2x —— 那一步在 1440p @dpr2 下就是 800 万像素级的插值，是单帧最大开销。
      bg.width = Math.max(1, Math.round(W * dpr))
      bg.height = Math.max(1, Math.round(H * dpr))
      var b = bg.getContext('2d')
      var w = W, h = H
      b.setTransform(dpr, 0, 0, dpr, 0, 0)
      b.globalCompositeOperation = 'source-over'
      b.globalAlpha = 1
      b.clearRect(0, 0, w, h)

      // 叠加模式下不画不透明天幕，只压一层极淡的冷色夜幕，正文依旧清晰可读。
      var ov = opt.overlay
      var dim = ov ? 0.55 : 1          // 发光元素（星云 / 银河尘埃）衰减
      var darkDim = ov ? 0.18 : 1      // 压暗类遮罩（地面 / 消光）衰减
      var vigDim = ov ? 0.28 : 1       // 暗角衰减
      var g = b.createLinearGradient(0, 0, 0, h)
      if (!ov) {
        g.addColorStop(0, opt.colors.skyTop)
        g.addColorStop(0.52, '#081226')
        g.addColorStop(1, opt.colors.skyBottom)
      } else {
        g.addColorStop(0, 'rgba(6,12,26,0.22)')
        g.addColorStop(0.6, 'rgba(5,11,24,0.14)')
        g.addColorStop(1, 'rgba(4,9,20,0.10)')
      }
      b.fillStyle = g
      b.fillRect(0, 0, w, h)

      // 银河本体：沿带法线方向的超柔线性渐变，给尘埃一个连续的底光。
      b.save()
      b.translate(w * 0.5, bandY(w * 0.5))
      b.rotate(opt.milkyWayAngle)
      var bandHalf = h * opt.milkyWayWidth * 1.35
      g = b.createLinearGradient(0, -bandHalf, 0, bandHalf)
      g.addColorStop(0, 'rgba(' + opt.colors.nebulaA + ',0)')
      g.addColorStop(0.42, 'rgba(' + opt.colors.nebulaA + ',' + (0.055 * dim).toFixed(3) + ')')
      g.addColorStop(0.5, 'rgba(' + opt.colors.nebulaB + ',' + (0.095 * dim).toFixed(3) + ')')
      g.addColorStop(0.58, 'rgba(' + opt.colors.nebulaC + ',' + (0.055 * dim).toFixed(3) + ')')
      g.addColorStop(1, 'rgba(' + opt.colors.nebulaA + ',0)')
      b.fillStyle = g
      b.fillRect(-w, -bandHalf, w * 2, bandHalf * 2)
      b.restore()

      // 2~3 层超低透明度径向渐变（紫蓝 / 青灰 / 冷蓝）叠加出星云辉光。
      b.globalCompositeOperation = 'lighter'
      var nebulaColors = [opt.colors.nebulaA, opt.colors.nebulaB, opt.colors.nebulaC]
      var count = clamp(Math.round(Math.min(opt.nebulaLayers, QUALITY[quality].nebula)), 0, 3)
      for (var n = 0; n < count; n += 1) {
        var cx = w * (0.24 + n * 0.26) + noise2(n * 3.7, 1.1) * w * 0.05
        var cy = bandY(cx) + noise2(n * 5.3, 2.2) * h * 0.06
        var R = Math.max(w, h) * (0.30 + n * 0.06)
        b.save()
        b.translate(cx, cy)
        b.rotate(opt.milkyWayAngle + (n - 1) * 0.16)
        b.scale(1.7, 0.55)
        var rg = b.createRadialGradient(0, 0, 0, 0, 0, R)
        rg.addColorStop(0, 'rgba(' + nebulaColors[n] + ',' + (0.125 * dim).toFixed(3) + ')')
        rg.addColorStop(0.35, 'rgba(' + nebulaColors[n] + ',' + (0.060 * dim).toFixed(3) + ')')
        rg.addColorStop(0.72, 'rgba(' + nebulaColors[n] + ',' + (0.020 * dim).toFixed(3) + ')')
        rg.addColorStop(1, 'rgba(' + nebulaColors[n] + ',0)')
        b.fillStyle = rg
        b.fillRect(-R, -R, R * 2, R * 2)
        b.restore()
      }

      // 密度场尘埃：带内密集、带外稀疏；两次固定 alpha，不逐点设样式。
      var dustCount = Math.min(9000, Math.round(w * h * 0.0038 * opt.milkyWayDensity))
      var attempts = dustCount * 9
      var drawn = 0
      b.fillStyle = 'rgba(' + opt.colors.dust + ',' + (0.090 * dim).toFixed(3) + ')'
      var bright = []
      while (attempts > 0 && drawn < dustCount) {
        attempts -= 1
        var dx = Math.random() * w, dy = Math.random() * h
        if (Math.random() > milkyDensity(dx, dy)) continue
        b.fillRect(dx, dy, 1, 1)
        drawn += 1
        if (Math.random() < 0.055) bright.push(dx, dy)
      }
      b.fillStyle = 'rgba(226,238,255,' + (0.26 * dim).toFixed(3) + ')'
      for (var bi = 0; bi < bright.length; bi += 2) b.fillRect(bright[bi], bright[bi + 1], 1, 1)
      b.globalCompositeOperation = 'source-over'

      // 地面平面：视平线下方压暗，留出很淡的一层地平雾，避免生硬分界。
      g = b.createLinearGradient(0, gy - h * 0.06, 0, h)
      g.addColorStop(0, 'rgba(3,8,18,0)')
      g.addColorStop(0.30, 'rgba(3,8,18,' + (0.22 * darkDim).toFixed(3) + ')')
      g.addColorStop(1, 'rgba(2,6,14,' + (0.78 * darkDim).toFixed(3) + ')')
      b.fillStyle = g
      b.fillRect(0, gy - h * 0.06, w, h - gy + h * 0.06)

      // 大气消光：越靠近地平线越暗，配合星点生成时的稀疏化。
      g = b.createLinearGradient(0, h * 0.48, 0, h)
      g.addColorStop(0, 'rgba(3,7,16,0)')
      g.addColorStop(0.62, 'rgba(3,7,16,' + (0.20 * darkDim).toFixed(3) + ')')
      g.addColorStop(1, 'rgba(2,5,12,' + (0.72 * darkDim).toFixed(3) + ')')
      b.fillStyle = g
      b.fillRect(0, h * 0.48, w, h * 0.52)

      // 噪点：打破大面积渐变的色带（banding）。tile 按当前 dpr 生成，
      // 铺在 dpr 变换下正好是 1 tile 像素 : 1 设备像素，颗粒不会被放大。
      if (opt.grain > 0) {
        var pattern = b.createPattern(grainTileFor(dpr), 'repeat')
        if (pattern) {
          b.globalCompositeOperation = 'lighter'
          b.globalAlpha = opt.grain
          b.fillStyle = pattern
          b.fillRect(0, 0, w, h)
          b.globalAlpha = 1
          b.globalCompositeOperation = 'source-over'
        }
      }

      // 暗角：预渲染在静态层里，不参与每帧计算。
      if (opt.vignette > 0) {
        var vg = b.createRadialGradient(w * 0.5, h * 0.46, Math.min(w, h) * 0.24,
          w * 0.5, h * 0.46, Math.max(w, h) * 0.78)
        vg.addColorStop(0, 'rgba(2,5,12,0)')
        vg.addColorStop(0.62, 'rgba(2,5,12,' + (opt.vignette * 0.16 * vigDim).toFixed(3) + ')')
        vg.addColorStop(1, 'rgba(1,3,9,' + (opt.vignette * vigDim).toFixed(3) + ')')
        b.fillStyle = vg
        b.fillRect(0, 0, w, h)
      }
    }

    // ---- 星点生成：斜带偏置 + 幂律星等 + 大气消光稀疏化 ----------------------
    function buildStars() {
      activeStars = clamp(Math.round(opt.starCount * QUALITY[quality].star), 60, MAX_STARS)
      brightIdx.length = 0
      var bandSigma = Math.max(12, H * opt.milkyWayWidth * 0.60)
      for (var i = 0; i < activeStars; i += 1) {
        var lr = Math.random()
        var li = lr < STAR_CUM[0] ? 0 : lr < STAR_CUM[1] ? 1 : 2
        var L = STAR_LAYERS[li]
        var x = 0, y = 0, ok = false
        for (var t = 0; t < 8; t += 1) {
          // 约 78% 的星从银河带内取样（三随机近似高斯），带外只留均匀稀疏本底。
          if (Math.random() < 0.78) {
            x = rand(-20, W + 20)
            y = bandY(x) + (Math.random() + Math.random() + Math.random() - 1.5) * 1.35 * bandSigma
          } else {
            x = rand(-20, W + 20)
            y = rand(0, H * 0.94)
          }
          if (y < 0 || y > H * 0.94) continue
          if (Math.random() < 0.22 + 0.78 * extinction(y)) { ok = true; break }
        }
        if (!ok) { y = rand(0, H * 0.55); x = rand(0, W) }

        // 幂律星等：Math.pow(u, 3.1) 让暗星远多于亮星。
        var mag = clamp((0.16 + 0.84 * Math.pow(Math.random(), 3.1)) * L.magScale, 0.08, 1)
        sx[i] = x; sy[i] = y
        sr[i] = L.r[0] + (L.r[1] - L.r[0]) * Math.pow(mag, 0.7)
        smag[i] = mag
        sext[i] = extinction(y)
        slayer[i] = li
        var cr = Math.random() * starCum[starCum.length - 1], cidx = 0
        while (cidx < starCum.length - 1 && cr > starCum[cidx]) cidx += 1
        scolor[i] = cidx
        sphase[i] = rand(0, TAU)
        sfreqT[i] = TAU * rand(0.2, 2.0)                // 每颗独立频率；twinkleSpeed 作为实时倍率
        sphDx[i] = sphase[i] * 0.07                    // 视差相位偏移，预乘好省一次乘法
        sphDy[i] = sphase[i] * 0.05
        spikeAngle[i] = rand(0, TAU)
        // 近层亮星才带四芒星芒（数量很少，逐颗绘制渐变不心疼）。
        if (li === 2 && mag > 0.80 && brightIdx.length < 16) brightIdx.push(i)
      }
    }

    // ---- resize：DPR / 离屏层 / 星场 / 花瓣位置等比迁移 ----------------------
    function resize() {
      if (destroyed) return
      var oldW = W, oldH = H
      W = Math.max(1, canvas.clientWidth || root.innerWidth || 1)
      H = Math.max(1, canvas.clientHeight || root.innerHeight || 1)
      dpr = clamp(root.devicePixelRatio || 1, 1, Math.min(opt.maxDpr, QUALITY[quality].dpr))
      gy = H * clamp(opt.groundY, 0.3, 0.95)
      groundRange = Math.max(60, H - gy)
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.lineCap = 'round'
      buildBackground()
      buildStars()

      if (oldW > 1 && oldH > 1) {
        var sxr = W / oldW, syr = H / oldH
        for (var i = 0; i < petals.active.length; i += 1) {
          var p = petals.active[i]
          p.baseX *= sxr
          p.fallY *= syr
          p.landY = landYFor(p.depth)
          p.flat = flatten(p.depth)
        }
      }
      setPetalCount(opt.petalCount * QUALITY[quality].petal)
    }

    // ---- 花瓣生命周期 -------------------------------------------------------
    function resetPetal(p, initial) {
      var li = pickPetalLayer()
      var L = layers[li]
      p.layer = li
      p.depth = clamp(L.depth + rand(-0.10, 0.10), 0, 1)
      p.size = rand(L.size[0], L.size[1])
      p.alpha = L.alpha * rand(0.82, 1.0)
      p.colorIdx = (Math.random() * petalVariants) | 0
      p.shapeIdx = Math.random() < 0.30 ? 1 : 0
      p.phase = rand(0, TAU)
      p.swingFreq = rand(1.0, 2.6)                                  // rad/s
      p.swingAmp = rand(0.55, 1.5) * (0.45 + 0.55 * p.depth)   // 系数，绘制时乘 CONFIG.swingAmplitude
      p.wobbleFreq = rand(1.4, 3.2)
      p.wobbleAmp = rand(1.5, 5.0)
      p.angle = rand(0, TAU)
      p.spin = rand(-1.5, 1.5)
      p.tumble = rand(0, TAU)
      p.tumbleSpeed = rand(0.7, 2.6) * (Math.random() < 0.5 ? -1 : 1)
      p.landAngle = rand(-0.34, 0.34)
      p.landY = landYFor(p.depth)
      p.flat = flatten(p.depth)
      p.baseX = rand(-60, W + 60)
      p.fallY = initial ? rand(-H * 0.25, p.landY) : -rand(20, H * 0.30)
      p.pushX = p.pushY = p.pvx = p.pvy = 0
      p.vy = 0; p.state = 0; p.hold = 0; p.fade = 1; p.landT = 1
      // 逐片风阻：同一阵风下不再整片同步平移，前后层次更错落。
      p.drag = rand(1 - opt.petalDrag * 0.5, 1 + opt.petalDrag * 0.5)
      p.lastX = p.baseX; p.lastY = p.fallY
    }

    function setPetalCount(target) {
      target = clamp(Math.round(target), 12, MAX_PETALS)
      while (petals.active.length > target) petals.releaseAt(petals.active.length - 1)
      while (petals.active.length < target) {
        var p = petals.spawn()
        if (!p) break
        resetPetal(p, true)
      }
    }

    // ---- 风场：慢变本底 + 自然阵风包络 + 点击强风 ---------------------------
    function updateWind(dt) {
      var slow = sinL(time * 0.19) * 0.28 + sinL(time * 0.071 + 1.3) * 0.20

      if (!gustEv.active) {
        gustTimer -= dt
        if (gustTimer <= 0) {
          gustEv.active = true; gustEv.age = 0
          gustEv.life = rand(2.2, 4.2)
          gustEv.amp = rand(0.55, 1.0) * opt.gustStrength
          gustEv.dir = Math.random() < 0.5 ? -1 : 1
        }
      } else {
        gustEv.age += dt
        if (gustEv.age >= gustEv.life) {
          gustEv.active = false
          gustTimer = rand(opt.gustGap[0], opt.gustGap[1])
        }
      }
      // 非对称包络：骤起缓落，形成「被风吹起」的段落感，而不是对称的鼓包。
      var natural = gustEv.active
        ? gustEnvelope(gustEv.age, gustEv.life, opt.gustAttack) * gustEv.amp * gustEv.dir : 0

      var burst = 0
      if (burstEv.active) {
        burstEv.age += dt
        if (burstEv.age >= burstEv.life) burstEv.active = false
        else burst = gustEnvelope(burstEv.age, burstEv.life, opt.gustAttack) * burstEv.amp * burstEv.dir
      }

      wind = opt.windBase + slow * 9 + natural * 38 + burst * 105
      gust = Math.abs(natural) + Math.abs(burst) * 1.6
    }

    function updatePetals(dt) {
      var arr = petals.active
      var decayV = Math.exp(-3.2 * dt), decayP = Math.exp(-1.4 * dt)
      for (var i = 0; i < arr.length; i += 1) {
        var p = arr[i]
        var L = layers[p.layer]
        // 落花只受风场与点击强风影响；鼠标不再推开附近落花，保持安静的飘落。
        if (p.state === 0) {
          // 垂直：匀速 + 微小起伏；阵风时下落变缓甚至被轻轻托起。
          var fall = opt.fallSpeed * L.speed * (1 - Math.min(0.55, gust * 0.32))
          p.fallY += (fall + sinL(time * p.wobbleFreq + p.phase) * p.wobbleAmp) * dt - gust * 16 * dt
          // 水平：基准位移随全局风力漂移（逐片风阻），位置再叠加摆锤摆动。
          p.baseX += (wind * L.wind * p.drag + gust * 26 * L.wind) * dt
          p.angle += p.spin * dt
          p.tumble += p.tumbleSpeed * dt * (1 + gust * 0.25)
          if (p.fallY >= p.landY) {
            p.fallY = p.landY
            p.state = 1
            p.vy = -rand(80, 170) * (0.45 + 0.55 * p.depth) * opt.bounceDecay
          }
        } else if (p.state === 1) {
          // 一次小反弹：重力拉回，第二次触地即静止。
          p.vy += 520 * dt
          p.fallY += p.vy * dt
          p.angle += p.spin * 0.35 * dt
          if (p.vy > 0 && p.fallY >= p.landY) {
            p.fallY = p.landY; p.vy = 0
            p.state = 2
            p.angle = p.landAngle
            p.landT = 0                 // 触地后渐进压扁，避免瞬间变成椭圆
            p.hold = rand(opt.settleTime[0], opt.settleTime[1])
          }
        } else if (p.state === 2) {
          p.landT = Math.min(1, p.landT + dt / Math.max(0.05, opt.landBlendTime))
          p.hold -= dt
          if (p.hold <= 0) p.state = 3
        } else {
          p.fade -= dt / 1.25
          if (p.fade <= 0) { resetPetal(p, false); continue }
        }

        p.pvx *= decayV; p.pvy *= decayV
        p.pushX += p.pvx * dt; p.pushY += p.pvy * dt
        p.pushX *= decayP; p.pushY *= decayP
        if (p.baseX < -170 || p.baseX > W + 170) resetPetal(p, false)
      }
    }

    // ---- 鼠标碎花螺旋 -------------------------------------------------------
    // 沿光标轨迹按位移洒下细小的花瓣屑；每片绕自己的中心打旋（角速度 + 半径
    // 收放），同时整体上浮、淡出。与落花池完全分离，不参与落地生命周期。
    function emitShards(x, y, count, boost) {
      if (!opt.interactive || !opt.swirlEnabled || count <= 0) return
      var qf = 0.45 + 0.55 * quality / 3
      var n = Math.min(Math.round(count), Math.round(count * qf * opt.swirlDensity))
      if (n <= 0) return
      // 同时活跃数上限：始终只保留「小小一团」。快速移动时挤掉寿命走得最远的
      // 碎片，新片补在光标处，避免整条轨迹被碎花铺满而显得杂乱。
      // 只淘汰 mode 0（轨迹螺旋）：点击绽放的碎片有固定的短寿命和明确的视觉
      // 意义，绝不能被随后洒下的轨迹碎花顶掉 —— 否则点完鼠标一动，刚绽开的
      // 那一圈就消失了，点击等于没有反馈。
      var cap = Math.max(6, Math.round(opt.swirlPerEmit * 7 * opt.swirlDensity))
      var trailCount = 0
      for (var t0 = 0; t0 < shards.active.length; t0 += 1) {
        if (shards.active[t0].mode === 0) trailCount += 1
      }
      while (trailCount + n > cap) {
        var oldest = -1, ot = -1
        for (var k = 0; k < shards.active.length; k += 1) {
          var sk = shards.active[k]
          if (sk.mode !== 0) continue
          var tt = sk.age / sk.life
          if (tt > ot) { ot = tt; oldest = k }
        }
        if (oldest < 0) break
        shards.releaseAt(oldest)
        trailCount -= 1
      }
      var b = boost || 1
      var R = opt.swirlRadius * b
      var dir = swirl.dir
      var bright = Math.min(6, petalVariants)       // 前 6 档＝粉 / 白两种基色
      for (var i = 0; i < n; i += 1) {
        var s = shards.spawn()
        if (!s) break
        s.mode = 0
        s.age = 0
        s.life = opt.swirlLife * rand(0.82, 1.20)
        // 同一批共享中心、角度连续推进、半径由内向外 → 一条渐开的螺旋臂。
        s.cx = x + rand(-1.5, 1.5)
        s.cy = y + rand(-1.5, 1.5)
        swirl.phase += 0.62 * dir
        s.angle = swirl.phase + rand(-0.10, 0.10)
        s.radius = R * (0.20 + 0.80 * ((i + 1) / (n + 1))) * rand(0.92, 1.08)
        s.spin = opt.swirlSpeed * rand(0.88, 1.12) * dir
        s.rVel = R * rand(-0.12, 0.12)
        s.rise = opt.swirlRise * rand(0.55, 1.35) * b
        s.drift = clamp(pointer.vx * 0.03, -60, 60) + rand(-6, 6)
        s.size = rand(opt.swirlSize[0], opt.swirlSize[1]) * b
        s.alpha = rand(0.82, 1.0)
        // 90% 取粉 / 白，少量淡黄 / 浅橘点缀，避免旋涡整体偏灰偏褐。
        s.colorIdx = Math.random() < 0.95 ? (Math.random() * bright) | 0
          : (Math.random() * petalVariants) | 0
        s.shapeIdx = Math.random() < 0.5 ? 0 : 1
        s.tilt = rand(0, TAU)
        s.tiltSpin = s.spin * rand(0.35, 0.75)
        s.tumble = rand(0, TAU)
        s.tumbleSpeed = rand(1.2, 3.6) * (Math.random() < 0.5 ? -1 : 1)
        s.x = s.cx + cosL(s.angle) * s.radius
        s.y = s.cy + sinL(s.angle) * s.radius * 0.72
      }
    }

    // 点击绽放：一小圈更大的碎花从点击处向外「绽开」—— 半径快速外扩再减速，
    // 单片边开边放大、翻转更活泼，最后缓缓淡出。刻意不占「轨迹小团」的名额
    // （只在对象池硬上限内让位），也不动风场 / 落花，背景保持安静。
    function emitBloom(x, y) {
      if (!opt.interactive || !opt.swirlEnabled || opt.bloomCount <= 0) return
      var qf = 0.45 + 0.55 * quality / 3
      var n = Math.round(opt.bloomCount * qf)
      if (n <= 0) return
      var bright = Math.min(6, petalVariants)       // 前 6 档＝粉 / 白两种基色
      var R = opt.bloomRadius
      // 中心柔光：取一个空闲槽位（都在用就抢最老的），给绽放一个明确的起势。
      var slot = 0, slotAge = -1
      for (var fi = 0; fi < flares.length; fi += 1) {
        if (!flares[fi].active) { slot = fi; slotAge = Infinity; break }
        var ft = flares[fi].age / flares[fi].life
        if (ft > slotAge) { slotAge = ft; slot = fi }
      }
      var fl0 = flares[slot]
      fl0.active = true; fl0.x = x; fl0.y = y; fl0.age = 0
      fl0.life = 0.46
      for (var i = 0; i < n; i += 1) {
        var s = shards.spawn()
        if (!s) break
        s.mode = 1
        s.age = 0
        s.life = opt.bloomLife * rand(0.82, 1.22)
        s.cx = x + rand(-2, 2)
        s.cy = y + rand(-2, 2)
        // 角度沿圆周均匀铺开 + 微扰：绽放是一整圈，不是随机撒点。
        s.angle = (i / n) * TAU + rand(-0.14, 0.14)
        s.radius = rand(2, 7)
        // rVel 取「目标半径 / 特征时间」量级，配合 update 里的指数减速，
        // 前零点几秒快速绽开、随后几乎停在最大半径处慢慢淡出。
        s.rVel = (R / 0.55) * rand(0.85, 1.25)
        s.spin = rand(-0.9, 0.9)                    // 整圈缓慢转动，像花瓣被旋开
        s.rise = opt.swirlRise * rand(0.45, 1.05)
        s.drift = rand(-10, 10)
        s.size = rand(opt.swirlSize[0], opt.swirlSize[1]) * opt.bloomSize
        s.alpha = rand(0.88, 1.0)
        s.colorIdx = Math.random() < 0.95 ? (Math.random() * bright) | 0
          : (Math.random() * petalVariants) | 0
        s.shapeIdx = Math.random() < 0.5 ? 0 : 1
        s.tilt = rand(0, TAU)
        s.tiltSpin = rand(-1.6, 1.6)
        s.tumble = rand(0, TAU)
        s.tumbleSpeed = rand(1.6, 4.4) * (Math.random() < 0.5 ? -1 : 1)
        s.x = s.cx + cosL(s.angle) * s.radius
        s.y = s.cy + sinL(s.angle) * s.radius * 0.72
      }
    }

    // 柔光扩散：快速外扩、二次曲线淡出（'lighter' 叠加，暗底上有一记柔亮）。
    function updateFlares(dt) {
      for (var i = 0; i < flares.length; i += 1) {
        if (!flares[i].active) continue
        flares[i].age += dt
        if (flares[i].age >= flares[i].life) flares[i].active = false
      }
    }
    function drawFlares() {
      var any = false
      for (var i = 0; i < flares.length; i += 1) if (flares[i].active) { any = true; break }
      if (!any) return
      var ov = opt.overlay ? 0.60 : 1
      ctx.globalCompositeOperation = 'lighter'
      for (var j = 0; j < flares.length; j += 1) {
        var f = flares[j]
        if (!f.active) continue
        var t = f.age / f.life
        var ease = 1 - Math.pow(1 - t, 2.2)      // 起手快、收尾慢
        var size = opt.bloomRadius * (1.1 + 1.9 * ease)
        ctx.globalAlpha = (1 - t) * (1 - t) * opt.bloomGlow * ov
        ctx.drawImage(bloomGlow, f.x - size * 0.5, f.y - size * 0.5, size, size)
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    function updateShards(dt) {
      // 光标静止时也零星补 1 片，让附近始终留有一小团缓缓打旋的碎花。
      if (opt.interactive && opt.swirlEnabled && swirl.seen && swirl.inside && opt.swirlIdle > 0) {
        swirl.idle -= dt
        if (swirl.idle <= 0) {
          swirl.idle = opt.swirlIdle
          emitShards(pointer.x, pointer.y, 1)
        }
      }
      var arr = shards.active
      // 中心收敛：已洒下的碎花被缓缓卷回当前光标，整团始终「聚」在鼠标附近
      // 打旋，同时留一点掉队的尾巴；0 则纯沿轨迹散落。
      var pull = (swirl.seen && opt.swirlPull > 0)
        ? (1 - Math.exp(-dt / 0.40)) * opt.swirlPull : 0
      for (var i = arr.length - 1; i >= 0; i -= 1) {
        var s = arr[i]
        s.age += dt
        if (s.age >= s.life) { shards.releaseAt(i); continue }
        if (s.mode === 1) {
          // 绽放：留在点击处开放 —— 不向光标收敛；半径快速外扩后指数减速，
          // 像花瓣被「绽开」的一瞬，随后几乎停在最大半径处慢慢淡出。
          s.spin *= (1 - 0.5 * dt)
          s.angle += s.spin * dt
          s.rVel *= (1 - 1.9 * dt)
          s.radius += s.rVel * dt
          if (s.radius < 1.5) s.radius = 1.5
          s.cy -= s.rise * dt
          s.rise *= (1 - 0.35 * dt)
          s.cx += s.drift * dt
          s.drift *= (1 - 0.9 * dt)
        } else {
          if (pull > 0) {
            s.cx += (swirl.x - s.cx) * pull
            s.cy += (swirl.y - s.cy) * pull
          }
          // 螺旋：角度持续推进 + 半径收放，轨迹是一条渐开 / 渐收的螺旋线。
          s.spin *= (1 - 0.35 * dt)          // 角速度缓慢衰减，旋涡自然散开
          s.angle += s.spin * dt
          s.radius += s.rVel * dt
          if (s.radius < 1.5) { s.radius = 1.5; s.rVel = Math.abs(s.rVel) * 0.5 }
          s.cy -= s.rise * dt               // 被卷起：整体上浮
          s.rise *= (1 - 0.25 * dt)
          s.cx += s.drift * dt             // 顺光标移动方向轻微带走，不形成跟随
          s.drift *= (1 - 0.9 * dt)
        }
        // y 方向压 0.72：旋涡有一点透视，不是平面正圆。
        s.x = s.cx + cosL(s.angle) * s.radius
        s.y = s.cy + sinL(s.angle) * s.radius * 0.72
        s.tilt += s.tiltSpin * dt
        s.tumble += s.tumbleSpeed * dt
      }
    }

    // ---- 流星：低频随机 + 偶尔连发 2 颗，全部走对象池 ------------------------
    function spawnMeteor() {
      var m = meteors.spawn()
      if (!m) return null
      m.age = 0
      m.life = rand(0.4, 0.9)
      m.x = rand(W * 0.05, W * 0.92)
      m.y = rand(H * 0.02, H * 0.50)
      // 随机角度快速斜划（左下或右下），不做固定方向。
      m.angle = Math.random() < 0.5 ? rand(0.28, 0.80) : Math.PI - rand(0.28, 0.80)
      var speed = rand(760, 1380)
      m.vx = Math.cos(m.angle) * speed
      m.vy = Math.sin(m.angle) * speed
      m.len = rand(90, 220)
      m.height = rand(7, 13)
      return m
    }
    function triggerMeteor() {
      if (spawnMeteor() && Math.random() < 0.22) followTimer = rand(0.18, 0.42)
    }
    function updateMeteors(dt) {
      var arr = meteors.active
      for (var i = arr.length - 1; i >= 0; i -= 1) {
        var m = arr[i]
        m.age += dt
        if (m.age >= m.life) { meteors.releaseAt(i); continue }
        m.x += m.vx * dt
        m.y += m.vy * dt
      }
      if (followTimer > 0) {
        followTimer -= dt
        if (followTimer <= 0) { followTimer = -1; spawnMeteor() }
      } else {
        meteorTimer -= dt
        if (meteorTimer <= 0) {
          triggerMeteor()
          meteorTimer = rand(opt.meteorGap[0], opt.meteorGap[1]) / Math.max(0.25, opt.meteorChance)
        }
      }
    }

    // ---- 绘制：星点按 alpha 分组批量填充 ------------------------------------
    function drawStars() {
      groupN.fill(0)
      var pr2 = opt.pointerRadius * opt.pointerRadius
      var pEnergy = pointer.energy
      // 每层的视差相位是「时间 × 常数」，层内所有星共享，提前算好三份即可；
      // 单星之间的差异已经预乘进 sphDx / sphDy，循环里不再做乘法。
      var tx0 = time * 0.11, tx1 = tx0 + time * 0.045, tx2 = tx1 + time * 0.045
      var ty0 = time * 0.083, ty1 = ty0 + time * 0.037, ty2 = ty1 + time * 0.037
      var tw = time * opt.twinkleSpeed
      for (var i = 0; i < activeStars; i += 1) {
        var li = slayer[i]
        var L = STAR_LAYERS[li]
        // 极慢的层间视差：有界振荡，位移幅度只有 1~5px，不会把星场推走。
        var x = sx[i] + sinL((li === 0 ? tx0 : li === 1 ? tx1 : tx2) + sphDx[i]) * L.drift[0]
        var y = sy[i] + cosL((li === 0 ? ty0 : li === 1 ? ty1 : ty2) + sphDy[i]) * L.drift[1]
        // 每颗独立相位/频率，sin 缓动到 0.4~1；远层 amp 极小＝几乎不闪。
        var s = 0.5 + 0.5 * sinL(sphase[i] + tw * sfreqT[i])
        var v = 0.4 + 0.6 * (0.5 + (s - 0.5) * L.amp)
        var a = smag[i] * v * sext[i] * L.alpha
        // 鼠标附近星点轻微增亮：只改一个标量，不破坏分组批处理。
        if (pEnergy > 0.01) {
          var dx = x - pointer.x, dy = y - pointer.y
          var d2 = dx * dx + dy * dy
          if (d2 < pr2) a += 0.34 * (1 - d2 / pr2) * pEnergy
        }
        var b = a <= 0 ? 0 : a >= 1 ? BUCKETS - 1 : (a * BUCKETS) | 0
        var g = ((li * 4) + scolor[i]) * BUCKETS + b
        var k = groupN[g] * 3
        var d = groupData[g]
        d[k] = x; d[k + 1] = y; d[k + 2] = sr[i]
        groupN[g] += 1
      }

      // 独立场景用加色混合出星光辉光；叠加到博客正文上时改用正常 alpha，
      // 否则亮色背景会把加色的白星「吃掉」。
      ctx.globalCompositeOperation = opt.overlay ? 'source-over' : 'lighter'
      var starAlpha = opt.overlay ? 0.72 : 1
      for (var gi = 0; gi < GROUP_COUNT; gi += 1) {
        var n = groupN[gi]
        if (!n) continue
        var layer = (gi / (4 * BUCKETS)) | 0
        var color = (gi / BUCKETS | 0) % 4
        var bucket = gi % BUCKETS
        ctx.fillStyle = starRGB[color] || starRGB[0]
        ctx.globalAlpha = (bucket + 0.55) / BUCKETS * starAlpha
        ctx.beginPath()
        var data = groupData[gi]
        // 只有近层（半径可到 2.3px）值得用圆；远/中层半径都在 1.35px 以内，
        // 方块与圆在这个尺度上肉眼无差，但 rect 省掉了 arc 的圆弧离散化开销。
        if (layer < 2) {
          for (var j = 0; j < n; j += 1) {
            var o = j * 3, rr = data[o + 2]
            ctx.rect(data[o] - rr, data[o + 1] - rr, rr * 2, rr * 2)
          }
        } else {
          for (var j2 = 0; j2 < n; j2 += 1) {
            var o2 = j2 * 3, r2 = data[o2 + 2]
            ctx.moveTo(data[o2] + r2, data[o2 + 1])
            ctx.arc(data[o2], data[o2 + 1], r2, 0, TAU)
          }
        }
        ctx.fill()
      }

      // 近层亮星的四芒星芒：贴图 + 缩放，不再每帧现建线性渐变（一帧省 32 次）。
      if (QUALITY[quality].spike) {
        var bl = STAR_LAYERS[2]
        for (var s2 = 0; s2 < brightIdx.length; s2 += 1) {
          var idx = brightIdx[s2]
          // 与星点本体用同一组视差公式，星芒不会和核心脱节。
          var bx = sx[idx] + sinL(tx2 + sphDx[idx]) * bl.drift[0]
          var by = sy[idx] + cosL(ty2 + sphDy[idx]) * bl.drift[1]
          var R = sr[idx] * 7.5
          var twi = 0.4 + 0.6 * (0.5 + 0.5 * sinL(sphase[idx] + tw * sfreqT[idx]))
          ctx.globalAlpha = 0.34 * twi * sext[idx]
          // setTransform 直接给出「设备缩放 + 偏移」，比 save/translate/rotate/restore
          // 少压一次状态栈；旋转仍在设备空间，角度与原来完全一致。
          ctx.setTransform(dpr, 0, 0, dpr, dpr * bx, dpr * by)
          ctx.rotate(spikeAngle[idx])
          ctx.drawImage(spikeSprite, -R, -R, R * 2, R * 2)
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }

    function drawMeteors() {
      var arr = meteors.active
      if (!arr.length) return
      var q = QUALITY[quality]
      ctx.globalCompositeOperation = opt.overlay ? 'source-over' : 'lighter'
      for (var i = 0; i < arr.length; i += 1) {
        var m = arr[i]
        var t = m.age / m.life
        var a = Math.min(1, m.age / 0.10) * Math.pow(1 - t, 0.85)
        if (a <= 0.01) continue
        ctx.save()
        ctx.translate(m.x, m.y)
        ctx.rotate(m.angle)
        ctx.globalAlpha = a
        ctx.drawImage(meteorSprite, -m.len, -m.height / 2, m.len, m.height)
        if (q.glow) {
          var s = 20 + 10 * (1 - t)
          ctx.globalAlpha = a * 0.85
          ctx.drawImage(headGlow, -s / 2, -s / 2, s, s)
        }
        ctx.restore()
      }
    }

    function drawPetals() {
      var q = QUALITY[quality]
      var arr = petals.active
      var sheen = opt.petalSheen > 0.05
      var detail = sheen && q.glow
      ctx.globalCompositeOperation = 'source-over'   // 花瓣用正常 alpha 叠加
      ctx.lineCap = 'round'
      for (var i = 0; i < arr.length; i += 1) {
        var p = arr[i]
        var L = layers[p.layer]
        var frozen = p.state >= 2
        // 摆动：基频 + 二次谐波，轨迹不是标准正弦，更像落叶摆锤。
        var ph = time * p.swingFreq + p.phase
        var swing = frozen ? 0 : (sinL(ph) +
          opt.swingHarmonic * sinL(2 * ph + p.phase * 0.6)) *
          opt.swingAmplitude * p.swingAmp * (1 + gust * 0.65)
        var wobble = frozen ? 0
          : sinL(time * p.wobbleFreq + p.phase * 1.7) * p.wobbleAmp * 0.35
        var x = p.baseX + swing + p.pushX
        var y = p.fallY + wobble + p.pushY
        if (x < -70 || x > W + 70 || y < -50 || y > H + 60) continue

        var cosT = cosL(p.tumble)
        // 明暗分级：cos 从 -1（反面）到 +1（正面）连续映射到 SHADES 级，
        // 翻面时是渐变过渡，不再是「正/反」二值突变。
        var shade = clamp(Math.round((cosT * 0.5 + 0.5) * (SHADES - 1)), 0, SHADES - 1)
        var scaleX, scaleY, ang
        if (frozen) {
          // 触地后按 landBlendTime 从立体渐变压成贴地椭圆；越远越扁。
          var blend = smoothstep(clamp(p.landT, 0, 1))
          scaleX = cosT >= 0 ? 1 : -1
          scaleY = 1 - (1 - p.flat) * blend
          ang = p.landAngle + sinL(time * 2.1 + p.phase) * gust * opt.settleTremor
          shade = Math.max(shade, SHADES - 3)       // 贴地花瓣不至于过暗
        } else {
          scaleX = Math.abs(cosT) < 0.16 ? (cosT < 0 ? -0.16 : 0.16) : cosT
          scaleY = 1
          ang = p.angle
        }
        // 柔光 / 叠影始终用较亮色阶：翻面时不会在浅色花瓣旁留下一圈暗脏阴影。
        var glowIdx = p.colorIdx * SHADES + Math.max(shade, SHADES - 2)
        var a = p.alpha * p.fade
        var ex = (x / W - 0.5) * 2, ey = (y / H - 0.5) * 2
        a *= 1 - 0.26 * clamp((ex * ex + ey * ey - 0.55) / 1.1, 0, 1)
        if (a <= 0.012) continue

        // 叠影方向沿本片这一帧的真实位移，而不是固定右下角。
        var gdx = (x - p.lastX) * opt.ghostTrail
        var gdy = (y - p.lastY) * opt.ghostTrail
        p.lastX = x; p.lastY = y

        var ca = cosL(ang), sa = sinL(ang), sc = p.size
        var m11 = ca * scaleX * sc, m12 = sa * scaleX * sc
        var m21 = -sa * scaleY * sc, m22 = ca * scaleY * sc
        var shape = petalPaths[p.shapeIdx]

        // 远层（景深最远，尺寸 5~17px、α 只到 0.40）改成一次单色填充：
        // 这个尺度上线性渐变根本分辨不出来，却要额外占一个 shader 和两次描边。
        // 远层占了全场景近一半花瓣，省下的是实打实的每帧光栅化面积。
        if (L.halo) {
          ctx.setTransform(dpr * m11, dpr * m12, dpr * m21, dpr * m22, dpr * x, dpr * y)
          ctx.fillStyle = petalSolid[glowIdx]
          ctx.globalAlpha = a * 0.92
          ctx.fill(shape)
          continue
        }

        // 近层叠影：低透明度同色前移，代替 filter:blur。
        if (q.ghost && L.ghost && p.state === 0) {
          ctx.setTransform(dpr * m11, dpr * m12, dpr * m21, dpr * m22,
            dpr * (x - gdx * 2.4), dpr * (y - gdy * 2.4))
          ctx.fillStyle = petalSolid[glowIdx]
          ctx.globalAlpha = a * 0.18
          ctx.fill(shape)
        }

        ctx.setTransform(dpr * m11, dpr * m12, dpr * m21, dpr * m22, dpr * x, dpr * y)
        // 主体渐变：根部略深 → 腹部本色 → 尖端透亮，横坐标略斜配合不对称轮廓。
        ctx.fillStyle = petalGrad[p.colorIdx * SHADES + shade]
        ctx.globalAlpha = a
        ctx.fill(shape)
        // 主脉 + 侧脉 / 右缘高光：两层描边，低画质自动省略细节层。
        if (sheen && !frozen) {
          ctx.lineWidth = 0.034
          ctx.strokeStyle = opt.colors.vein
          ctx.globalAlpha = a * 0.62 * opt.petalSheen
          ctx.stroke(veinMain)
          // 侧脉线宽 0.026，只有尺寸够大的花瓣上才可能被看见；小花瓣上
          // 纯粹是抗锯齿负担，直接跳过这一趟 stroke。
          if (detail && sc > 11) {
            ctx.lineWidth = 0.026
            ctx.strokeStyle = opt.colors.veinSide
            ctx.globalAlpha = a * 0.52 * opt.petalSheen
            ctx.stroke(veinDetail)
          }
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // 碎花螺旋画在最上层：细小的花瓣屑，正常 alpha 叠加，不遮挡正文。
    function drawShards() {
      var arr = shards.active
      if (!arr.length) return
      var q = QUALITY[quality]
      var ov = opt.overlay ? 0.70 : 1
      var fade = Math.max(0.04, opt.swirlFade)
      ctx.globalCompositeOperation = 'source-over'
      ctx.lineCap = 'round'
      for (var i = 0; i < arr.length; i += 1) {
        var s = arr[i]
        var t = s.age / s.life
        // 绽放碎花：淡入更快、淡出更缓；尺寸随绽放进度放大（0.74 → 1.14 倍），
        // 「边开边大」的一圈比轨迹碎花醒目得多。
        var a, sc
        if (s.mode === 1) {
          a = Math.min(1, s.age / 0.07) * Math.pow(1 - t, 1.15) * s.alpha * ov
          sc = s.size * (0.74 + 0.40 * smoothstep(Math.min(1, t * 1.7)))
        } else {
          a = Math.min(1, s.age / fade) * Math.pow(1 - t, 0.9) * s.alpha * ov
          sc = s.size
        }
        if (a <= 0.012) continue
        var cosT = cosL(s.tumble)
        // 轨迹碎花只用最亮的 4 级；绽放碎花再收窄到最亮 2 级 —— 暗底上整圈都是
        // 粉白，不会混进灰绿 / 褐色的「碎屑感」。
        var shade = s.mode === 1
          ? SHADES - 1 - Math.round((1 - (cosT * 0.5 + 0.5)) * 1.4)
          : SHADES - 1 - Math.round((1 - (cosT * 0.5 + 0.5)) * 3)
        var scaleX = (0.84 + 0.16 * Math.abs(cosT)) * (cosT < 0 ? -1 : 1)
        var ang = s.tilt + s.angle * 0.30    // 沿螺旋切线方向倾斜，像被卷着转
        var ca = cosL(ang), sa = sinL(ang)
        ctx.setTransform(dpr * ca * scaleX * sc, dpr * sa * scaleX * sc,
          dpr * -sa * sc, dpr * ca * sc, dpr * s.x, dpr * s.y)
        ctx.fillStyle = petalSolid[s.colorIdx * SHADES + shade]
        ctx.globalAlpha = a
        ctx.fill(shardPaths[s.shapeIdx])
        if (q.glow && sc > 5.2) {
          ctx.lineWidth = 0.035
          ctx.strokeStyle = opt.colors.vein
          ctx.globalAlpha = a * 0.36
          ctx.stroke(shardVein)
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function render() {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      // 非叠加模式下静态层不透明且铺满全屏，drawImage 自身就完成覆盖：
      // 再 clearRect 一次等于白写 400~800 万像素。只有半透明的叠加模式
      // （博客正文上层）才需要清屏，否则上一帧的星点会留下残影。
      if (opt.overlay) ctx.clearRect(0, 0, W, H)
      ctx.drawImage(bg, 0, 0, W, H)     // 静态层：1:1 blit（bg 已按 dpr 光栅化）
      drawStars()
      drawMeteors()
      drawPetals()
      drawFlares()      // 绽放柔光在碎花片之下，托住整圈碎片
      drawShards()
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }

    // ---- 主循环：deltaTime 驱动、掉帧自动降级、隐藏标签页暂停 ----------------
    function monitor(dtMs) {
      if (!opt.autoQuality) return
      if (warmup > 0) { warmup -= 1; return }
      ema += (dtMs - ema) * 0.07
      if (ema > 20.5) { bad += 1; good = 0 }
      else if (ema < 15.2) { good += 1; bad = 0 }
      else { bad = Math.max(0, bad - 1); good = Math.max(0, good - 1) }
      if (bad > 45 && quality > 0) { setQuality(quality - 1); bad = 0 }
      else if (good > 420 && quality < 3) { setQuality(quality + 1); good = 0 }
    }

    function frame(ts) {
      if (!running || !visible || destroyed) { raf = 0; return }
      raf = root.requestAnimationFrame(frame)
      if (!lastTs) lastTs = ts
      var dtMs = ts - lastTs
      lastTs = ts
      if (dtMs > 50) dtMs = 50            // 切回标签页 / 长任务后不瞬移
      var dt = dtMs / 1000
      time += dt
      var pointerDecay = Math.exp(-6 * dt)
      pointer.energy *= Math.exp(-2.2 * dt)
      pointer.vx *= pointerDecay; pointer.vy *= pointerDecay
      updateWind(dt)
      updateMeteors(dt)
      updatePetals(dt)
      updateShards(dt)
      updateFlares(dt)
      render()
      monitor(dtMs)
    }

    function syncRun() {
      var should = running && visible && !destroyed
      if (should && !raf) { lastTs = 0; raf = root.requestAnimationFrame(frame) }
      else if (!should && raf) { root.cancelAnimationFrame(raf); raf = 0 }
    }

    // ---- 交互：window 级监听，canvas 保持 pointer-events:none 不挡内容 -------
    // 接收裸坐标：预览页的自动轨迹演示可逐帧调用而不产生事件对象。
    function movePointer(x, y) {
      if (!opt.interactive) return
      var now = performance.now()
      var dt = Math.max(8, now - pointer.ts) / 1000
      if (!swirl.seen) {
        // 首次出现：发射器直接落在光标处，避免从屏幕外拉出一条长轨迹。
        swirl.seen = true
        swirl.x = x; swirl.y = y
        pointer.x = x; pointer.y = y
        pointer.ts = now
        pointer.energy = 1
        swirl.inside = true
        emitShards(x, y, opt.swirlPerEmit * 2)
        return
      }
      var dx = x - pointer.x, dy = y - pointer.y
      var d = Math.sqrt(dx * dx + dy * dy)
      pointer.vx = clamp(dx / dt, -900, 900)
      pointer.vy = clamp(dy / dt, -900, 900)
      pointer.x = x; pointer.y = y
      pointer.ts = now
      pointer.energy = 1
      swirl.inside = true
      swirl.x = x; swirl.y = y
      swirl.speed = Math.sqrt(pointer.vx * pointer.vx + pointer.vy * pointer.vy)
      // 旋向随水平移动翻转；静止时极缓慢地随机翻转，整团碎花仍保持同向打旋。
      if (Math.abs(dx) > 2) swirl.dir = dx >= 0 ? 1 : -1
      else if (Math.random() < dt * 0.25) swirl.dir = -swirl.dir
      if (!opt.swirlEnabled || d < 0.5) return
      swirl.dist += d
      var step = Math.max(4, opt.swirlEmitStep)
      var batches = 0
      while (swirl.dist >= step && batches < 3) {
        swirl.dist -= step
        batches += 1
        // 沿光标这一小段轨迹的中点洒下碎花，形成一串连续的小旋涡。
        emitShards(x - dx * 0.25, y - dy * 0.25, opt.swirlPerEmit)
      }
      if (batches >= 3) swirl.dist = 0
    }
    function onPointerMove(e) { movePointer(e.clientX, e.clientY) }
    // 光标离开窗口（或触摸结束）后停止补片，已有碎花自然淡出。
    function onPointerLeave(e) {
      if (e && e.relatedTarget) return
      swirl.inside = false
      swirl.dist = 0
      pointer.vx = pointer.vy = 0
    }
    function onPointerDown(e) {
      if (!opt.interactive) return
      // 点击 = 碎花绽放：只作用于碎花屑 —— 不动风场、不推背景落花，
      // 夜空保持安静；比「一阵风」更聚焦，也不会打断阅读。想手动起风，
      // 预览面板的「强风」按钮（engine.gust）仍然可用。
      emitBloom(e.clientX, e.clientY)
    }
    // 手动强风（engine.gust / 预览面板「强风」按钮）：会推背景落花 ——
    // 这是显式起风，与点击无关；点击本身只做碎花绽放（emitBloom）。
    function triggerGust(x, y, strength) {
      burstEv.active = true; burstEv.age = 0; burstEv.life = 2.2
      burstEv.amp = (strength == null ? 1.2 : strength) * opt.gustStrength
      burstEv.dir = x < W * 0.5 ? 1 : -1
      // 风源处额外给一圈局部推力，附近花瓣立刻改变方向。
      var r2 = opt.pointerRadius * opt.pointerRadius * 1.8
      for (var i = 0; i < petals.active.length; i += 1) {
        var p = petals.active[i]
        if (p.state !== 0) continue
        var dx = p.baseX - x, dy = p.fallY - y
        var d2 = dx * dx + dy * dy
        if (d2 > r2 || d2 < 1) continue
        var f = 1 - d2 / r2, inv = 1 / Math.sqrt(d2)
        p.pvx += dx * inv * 240 * f
        p.pvy += dy * inv * 150 * f
        p.tumbleSpeed += (dx >= 0 ? 1 : -1) * f * 1.4
      }
      // 同一阵风在风源处额外卷起一小簇碎花，与「被吹起」的段落感呼应。
      var prevDir = swirl.dir
      swirl.dir = burstEv.dir
      emitShards(x, y, opt.swirlBurst, 1.45)
      swirl.dir = prevDir
    }
    function onTouchMove(e) { if (e.touches && e.touches[0]) onPointerMove(e.touches[0]) }
    function onTouchStart(e) { if (e.touches && e.touches[0]) onPointerDown(e.touches[0]) }
    function onTouchEnd() { onPointerLeave(null) }
    // 始终绑定、在处理函数里判断开关，configure({interactive}) 才能实时生效。
    function bindInteraction() {
      if (root.PointerEvent) {
        root.addEventListener('pointermove', onPointerMove, { passive: true })
        root.addEventListener('pointerdown', onPointerDown, { passive: true })
        root.addEventListener('pointerout', onPointerLeave, { passive: true })
      } else {
        root.addEventListener('mousemove', onPointerMove, { passive: true })
        root.addEventListener('mousedown', onPointerDown, { passive: true })
        root.addEventListener('mouseout', onPointerLeave, { passive: true })
        root.addEventListener('touchmove', onTouchMove, { passive: true })
        root.addEventListener('touchstart', onTouchStart, { passive: true })
      }
      root.addEventListener('touchend', onTouchEnd, { passive: true })
      root.addEventListener('blur', onPointerLeave)
    }
    function unbindInteraction() {
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('pointerout', onPointerLeave)
      root.removeEventListener('mousemove', onPointerMove)
      root.removeEventListener('mousedown', onPointerDown)
      root.removeEventListener('mouseout', onPointerLeave)
      root.removeEventListener('touchmove', onTouchMove)
      root.removeEventListener('touchstart', onTouchStart)
      root.removeEventListener('touchend', onTouchEnd)
      root.removeEventListener('blur', onPointerLeave)
    }

    function onVisibility() { visible = !document.hidden; syncRun() }
    function onResize() { root.clearTimeout(resizeTimer); resizeTimer = root.setTimeout(resize, 120) }
    function setQuality(n) {
      quality = clamp(Math.round(n), 0, 3)
      resize()
      return quality
    }
    // 预览页调参用：数值类参数即时生效，结构性参数重建静态层 / 星场 / 层级。
    function configure(patch) {
      if (!patch) return api
      var structural = false
      for (var key in patch) {
        if (patch[key] === undefined) continue
        opt[key] = patch[key]
        if (key === 'starCount' || key === 'milkyWayDensity' || key === 'milkyWayAngle' ||
            key === 'milkyWayWidth' || key === 'nebulaLayers' || key === 'groundY' ||
            key === 'perspective' || key === 'layerCount' || key === 'vignette' ||
            key === 'grain' || key === 'colors' || key === 'overlay') structural = true
      }
      if (patch.layerCount !== undefined) {
        buildLayers()
        // 层数减少时，把还指向旧层的花瓣收敛到有效范围，避免读到空层配置。
        for (var i = 0; i < petals.active.length; i += 1) {
          if (petals.active[i].layer >= layers.length) petals.active[i].layer = layers.length - 1
        }
      }
      if (patch.swirlEnabled !== undefined || patch.swirlPerEmit !== undefined ||
          patch.interactive !== undefined) {
        if (!opt.swirlEnabled || !opt.interactive) { shards.clear(); swirl.dist = 0 }
      }
      if (structural) resize()
      else if (patch.petalCount !== undefined) setPetalCount(opt.petalCount * QUALITY[quality].petal)
      return api
    }

    var api = {
      start: function () { running = true; syncRun(); return api },
      stop: function () { running = false; syncRun(); return api },
      pause: function () { return api.stop() },
      resume: function () { return api.start() },
      resize: resize,
      setQuality: setQuality,
      getQuality: function () { return quality },
      configure: configure,
      gust: triggerGust,                 // 手动触发一阵强风（会推落花；点击行为已改为 bloom）
      bloom: emitBloom,                  // 手动触发一次碎花绽放（预览演示 / 自动化测试）
      meteor: triggerMeteor,             // 手动触发流星（预览调试用，不是点击行为）
      swirl: function (x, y, n, boost) { // 手动洒一簇碎花（预览 / 自动化测试）
        emitShards(x, y, n == null ? opt.swirlPerEmit : n, boost || 1)
        return api
      },
      setPointer: function (x, y) { movePointer(x, y); return api }, // 预览自动演示 / 自动化测试
      setWind: function (v) { opt.windBase = v; return api },
      stats: function () {
        var settled = 0
        for (var i = 0; i < petals.active.length; i += 1) {
          if (petals.active[i].state >= 2) settled += 1
        }
        var blooming = 0
        for (var j = 0; j < shards.active.length; j += 1) {
          if (shards.active[j].mode === 1) blooming += 1
        }
        return {
          fps: Math.round(1000 / Math.max(1, ema)),
          quality: quality,
          stars: activeStars,
          petals: petals.active.length,
          settled: settled,
          shards: shards.active.length,          // 当前在场的碎花总数（螺旋 + 绽放）
          bloom: blooming,                       // 其中点击绽放的片数
          swirlDir: swirl.dir,                  // 当前旋向（+1 顺 / -1 逆）
          swirlX: Math.round(swirl.x), swirlY: Math.round(swirl.y),
          pointerX: Math.round(pointer.x), pointerY: Math.round(pointer.y),
          meteors: meteors.active.length,
          dpr: dpr,
          wind: wind,                           // 当前水平风力（验证点击不再起风）
          gust: gust,
          burst: burstEv.active                 // 手动强风是否在进行（点击不会触发）
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
        petals.clear(); meteors.clear(); shards.clear()
        swirl.seen = false; swirl.inside = false; swirl.dist = 0
        for (var flx = 0; flx < flares.length; flx += 1) flares[flx].active = false
        ctx.clearRect(0, 0, W, H)
      }
    }

    buildLayers()
    resize()
    root.addEventListener('resize', onResize, { passive: true })
    root.addEventListener('orientationchange', onResize, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    bindInteraction()
    return api
  }

  root.MistlaneNightSky = { createNightSkyEngine: createNightSkyEngine, CONFIG: CONFIG }
})(typeof window !== 'undefined' ? window : this)
