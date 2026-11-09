'use strict'

/**
 * Hexo 站点回归检查。
 *
 * 在 `hexo generate` 之后运行，直接读取 public/ 输出，
 * 确认资源管线（manifest 打包）、PJAX、搜索索引、订阅源与各功能页都在，防止改配置或改主题时静默回退。
 */

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')
const failures = []
const passes = []

const assert = (condition, message) => {
  if (condition) passes.push(message)
  else failures.push(message)
}

const read = relative => {
  const target = path.join(publicDir, relative)
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
}

assert(fs.existsSync(publicDir), 'public output exists')
const home = read('index.html')
assert(Boolean(home), 'home page generated')

// --- 资源管线：manifest 中的每个包都必须构建并复制到 public ---
const manifest = (() => {
  const file = path.join(root, 'themes', 'mistlane', 'source', 'js', 'mistlane', 'dist', 'manifest.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
})()

assert(Boolean(manifest), 'asset manifest exists (run npm run assets:prepare)')

const bundleRef = (kind, name) => `/${kind}/mistlane/dist/${manifest[kind][name]}`

// 从页面标记中解析该页需要的资源包（与 assets-src/js/lib/page-assets.js 一致）
const markerBundles = html => {
  const marker = html.match(/<div[^>]*id="mistlane-page-bundles"[^>]*>/)
  const attr = marker && marker[0].match(/data-bundles='([^']*)'/)
  if (!attr) return null
  try {
    return JSON.parse(attr[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"))
  } catch {
    return null
  }
}

const pages = (() => {
  const list = []
  const stack = [publicDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === 'index.html') list.push({ path: full, html: fs.readFileSync(full, 'utf8') })
    }
  }
  return list
})()
// /archives/ 这类迁移跳转页（meta refresh）不套主题布局，只有壳没有正文，不参与页面级断言
const isRedirectPage = html => /http-equiv=["']refresh["']/i.test(html)
const contentPages = pages.filter(page => !isRedirectPage(page.html))
const postPages = pages.filter(page => /class="post[^"]*" id="body-wrap"/.test(page.html))

if (manifest) {
  const jsNames = Object.keys(manifest.js)
  const cssNames = Object.keys(manifest.css)
  assert(jsNames.length === 6 && cssNames.length === 7, `manifest covers all bundles (${jsNames.length} js, ${cssNames.length} css)`)

  Object.entries(manifest.js).forEach(([name, file]) =>
    assert(fs.existsSync(path.join(publicDir, 'js', 'mistlane', 'dist', file)), `bundle built and copied: js/${name} -> ${file}`))
  Object.entries(manifest.css).forEach(([name, file]) =>
    assert(fs.existsSync(path.join(publicDir, 'css', 'mistlane', 'dist', file)), `bundle built and copied: css/${name} -> ${file}`))

  assert(home.includes(bundleRef('css', 'core')) && home.includes(bundleRef('js', 'core')), 'home loads the core bundle')
  assert(home.includes(bundleRef('js', 'sidebar')), 'home loads the sidebar bundle')
  assert(home.includes(bundleRef('css', 'sidebar')), 'home loads the sidebar css bundle')
  assert(home.includes(bundleRef('js', 'home')), 'home loads the home bundle')
  assert(!home.includes(bundleRef('js', 'album')) && !home.includes(bundleRef('css', 'album')), 'home does not load the album bundle')
  assert(home.includes('data-mistlane="core"'), 'core script is tagged with its bundle name')

  const homeBundles = markerBundles(home)
  assert(Boolean(homeBundles), 'page bundle marker is present on home')
  assert(Boolean(homeBundles) && ['core', 'sidebar', 'home'].every(name => homeBundles.js[name]), 'home marker lists core/sidebar/home bundle urls')

  assert(postPages.length > 0, 'post pages generated')
  if (postPages.length) {
    const post = postPages[0].html
    assert(post.includes(bundleRef('js', 'core')), 'post loads the core bundle')
    assert(!post.includes(bundleRef('js', 'sidebar')) && !post.includes(bundleRef('js', 'home')), 'post skips sidebar/home bundles')
    assert(!post.includes(bundleRef('css', 'sidebar')), 'post skips the sidebar css bundle')
    const postBundles = markerBundles(post)
    assert(Boolean(postBundles) && Object.keys(postBundles.js).join(',') === 'core', 'post marker lists only the core bundle')
  }

  const about = read('about/index.html')
  assert(about.includes(bundleRef('css', 'about')), 'about page loads about.css')
  assert(about.includes('class="about-intro"') && about.includes('about-person-quote') && about.includes('about-site-grid') && about.includes('about-contact-links'), 'about page keeps the redesigned profile sections')
  const aboutCss = read(`css/mistlane/dist/${manifest.css.about}`)
  assert(aboutCss.includes('.about-intro') && aboutCss.includes('.about-site-grid') && aboutCss.includes('.about-contact-links'), 'about styles ship in the page-only bundle')
  assert(!aboutCss.includes('.about-envelope'), 'about bundle drops the retired envelope styles')
  const album = read('album/index.html')
  assert(album.includes(bundleRef('js', 'album')) && album.includes(bundleRef('css', 'album')), 'album page loads the album bundle')
  const link = read('link/index.html')
  assert(link.includes(bundleRef('js', 'browse')) && link.includes(bundleRef('css', 'link')), 'link page loads browse.js and link.css')
  const music = read('music/index.html')
  assert(music.includes('id="music-room"') && music.includes('data-music-lyrics') && music.includes('data-music-search'), 'music room includes the player, lyrics and searchable collection')
  assert(music.includes(bundleRef('css', 'music')) && !home.includes(bundleRef('css', 'music')), 'music room styles load only where needed')
  const musicBundles = markerBundles(music)
  assert(Boolean(musicBundles?.css.music), 'PJAX marker carries music page styles')
  assert((music.match(/<audio\b/g) || []).length === 1, 'music room shares the single persistent audio element')
  // 双音源开关：听音室与随身听各一份，切换结果由 localStorage 记住
  assert(music.includes('data-music-source="local"') && music.includes('data-music-source="meting"'), 'music room exposes the local/online source switch')
  assert(home.includes('data-music-source="local"') && home.includes('data-music-source="meting"'), 'pocket player ships the same source switch')
  assert(home.includes('id="mistlane-music-handle"') && home.includes('data-music-dock-hide'), 'mobile dock collapses into a restore handle')
  assert(contentPages.every(page => page.html.includes('id="mistlane-music-handle"')), 'every page can restore the hidden dock')

  // 旧的无哈希注入必须彻底移除，避免重复加载
  assert(!home.includes('/css/mistlane/markdown.css') && !home.includes('/js/mistlane/petals.js'), 'legacy unhashed inject entries are removed')

  // CSS 拆分：共享样式留在 core，双栏侧边栏样式只在非文章页加载
  const coreCss = read(`css/mistlane/dist/${manifest.css.core}`)
  const sidebarCss = read(`css/mistlane/dist/${manifest.css.sidebar}`)
  assert(coreCss.includes('.author-role') && coreCss.includes('.mistlane-post-series'), 'core css keeps shared author card and post series styles')
  assert(sidebarCss.includes('.mistlane-double-aside') && sidebarCss.includes('.calendar-day'), 'sidebar css carries the double aside and calendar styles')
  assert(!coreCss.includes('.mistlane-double-aside') && !coreCss.includes('.calendar-day'), 'core css drops the non-post sidebar styles')
  assert(!coreCss.includes('.about-intro') && !coreCss.includes('.about-site-grid'), 'core css excludes about-page styles')
  assert(coreCss.includes('.motion-pending') && coreCss.includes('.motion-page-enter'), 'core css ships the global motion system')
  assert(coreCss.includes('.music-source-switch button.is-active') && coreCss.includes('.music-dock-handle{position:fixed'), 'core css ships the source switch and the dock restore handle')
  // 手机端评论：触屏没有 hover，回复/点赞必须常显；预览框不再左缩 3rem，头像收小
  assert(coreCss.includes('@media(hover:none)') && coreCss.includes('#twikoo .tk-actions{display:inline-flex'), 'touch devices always show reply and like actions')
  assert(coreCss.includes('#twikoo .tk-preview-container{margin-left:0'), 'mobile comments drop the 3rem preview indent')
  assert(coreCss.includes('#twikoo .tk-avatar{width:30px;height:30px'), 'mobile comments use a smaller avatar')
  assert(coreCss.includes('.mistlane-reading-progress') && coreCss.includes('.site-page.is-current'), 'core css ships navigation and reading progress polish')
  // 移动端抽屉：关闭按钮必须存在，且层级隔离样式随 core 一起加载
  assert(home.includes('id="sidebar-close"'), 'mobile drawer ships an explicit close button')
  assert(coreCss.includes('.mobile-sidebar-open') && coreCss.includes('#sidebar .sidebar-close'), 'core css keeps ambient effects and the music dock below the mobile drawer')
  // 移动端导航：品牌副标题与图标按钮样式随 core 加载
  assert(home.includes('nav-site-tagline') && coreCss.includes('.nav-site-tagline'), 'mobile nav renders the brand tagline with its styles')
  // 首页大标题不能被 -webkit-box 行裁切吃掉降部和投影
  assert(coreCss.includes('#page-header.full_page #site-title{display:block') && coreCss.includes('overflow:visible;-webkit-line-clamp:unset'), 'hero title paints outside its line box instead of being clipped')
  // Twikoo 管理面板：.tk-admin 是整块面板（博主徽章是 .tk-master），
  // 不能再被徽章规则刷成琥珀底 + 琥珀字，否则邮件设置等配置项白底白字看不清。
  assert(coreCss.includes('#twikoo .tk-admin{border:0!important;background:color-mix(in srgb,var(--ui-surface-solid)'), 'twikoo admin panel uses the site surface instead of the amber badge fill')
  assert(coreCss.includes('#twikoo .tk-admin{') && !/#twikoo \.tk-admin\{[^}]*--ui-amber-soft/.test(coreCss), 'twikoo admin panel no longer inherits the amber badge colors')
  assert(coreCss.includes('#twikoo .tk-admin .tk-admin-config-title{color:var(--ui-ink)'), 'twikoo admin config labels are forced back to --ui-ink')
  assert(coreCss.includes('#twikoo .tk-admin .tk-admin-config-item{grid-template-columns:minmax(0,1fr)'), 'twikoo admin config items stack in a single column on narrow screens')
}

const idCount = (html, id) => (html.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length
assert(idCount(home, 'mistlane-settings-toggle') === 1, 'one settings toggle on home page')
assert(/id=["']rightside["'][\s\S]*id=["']mistlane-settings-toggle["']/.test(home), 'settings toggle is integrated into rightside tools')
assert(idCount(home, 'mistlane-global-audio') === 1, 'one persistent audio element on home page')
assert(contentPages.every(page => idCount(page.html, 'mistlane-music-orb') === 1), 'every page includes one persistent music orb')
assert(home.includes('href="/music/"') && home.includes('data-music-room-link'), 'music room is reachable from navigation and pocket player')
assert(home.includes('aria-labelledby="mistlane-music-title" inert'), 'closed music panel starts outside keyboard navigation')
assert(home.includes('new Pjax('), 'PJAX navigation is initialized')
assert(/<script[^>]+src=["'][^"']*pjax[^"']*\.js/.test(home), 'PJAX runtime is loaded')
assert(home.includes('src="/js/pjax.min.js"'), 'PJAX runtime is served locally')
assert(home.includes('data-pjax'), 'persistent third-party scripts retain PJAX marker')

// 音乐内核已并入 core 包；因压缩会重命名函数，只断言字符串字面量
const coreBundle = manifest ? read(`js/mistlane/dist/${manifest.js.core}`) : ''
assert(coreBundle.includes('IntersectionObserver') && coreBundle.includes('motion-pending'), 'core script reveals content with the motion observer')
assert(coreBundle.includes('mistlane-reading-progress') && coreBundle.includes('aria-current'), 'core script syncs navigation state and reading progress')
assert(coreBundle.includes('effects-paused') && coreBundle.includes('visibilitychange'), 'ambient effects pause while the page is hidden')
assert(coreBundle.includes('fm:play-state'), 'music views share Firefly-style state events')
assert(coreBundle.includes('fm:source') && coreBundle.includes('mistlane-music-source'), 'music kernel switches between the local and online playlists')
assert(coreBundle.includes('mistlane-music-dock-hidden'), 'dock visibility is remembered on phones')
assert(coreBundle.includes('/data/music.json'), 'music kernel loads the playlist lazily')
assert(!coreBundle.includes('mistlane-music-state-v2'), 'music kernel does not restore playback after navigation')
assert(!coreBundle.includes('mistlane-music-mode'), 'play mode remains in memory only')
assert(coreBundle.includes('cdn.jsdelivr.net'), 'vendor fallback keeps the CDN as a safety net')

// 第三方库本地化：/vendor 必须构建出来，页面 HTML 不再引用 jsdelivr
const exists = relative => fs.existsSync(path.join(publicDir, relative))
const vendorFiles = [
  'vendor/typed/typed.umd.min.js',
  'vendor/infinitegrid/infinitegrid.min.js',
  'vendor/sharejs/js/social-share.min.js',
  'vendor/sharejs/css/share.min.css',
  'vendor/sharejs/fonts/iconfont.woff2'
]
vendorFiles.forEach(relative => assert(exists(relative), `vendored third-party file exists: ${relative}`))
assert(contentPages.every(page => !page.html.includes('cdn.jsdelivr.net')), 'no page references cdn.jsdelivr.net')
assert(postPages.some(page => page.html.includes('/vendor/sharejs/js/social-share.min.js')), 'post pages serve the share script locally')
assert(home.includes('preload="none"'), 'global audio does not preload or autoplay')

// MathJax 仅在含数学的页面加载
assert(!home.includes('MathJax-script'), 'pages without math skip MathJax')
assert(postPages.some(page => page.html.includes('MathJax-script')), 'pages with math load MathJax')

const rss = read('rss/index.html')
assert(Boolean(rss), 'rss page generated')
assert(rss.includes('/atom.xml'), 'rss page exposes Atom feed address')
assert(rss.includes('/rss2.xml'), 'rss page exposes RSS2 feed address')
assert(rss.includes('/sitemap.xml'), 'rss page exposes the sitemap address')
assert(rss.includes('data-rss-copy'), 'rss page includes copy action')
assert(Boolean(read('atom.xml')), 'atom feed generated')
assert(Boolean(read('rss2.xml')), 'rss2 feed generated')
const atomFeed = read('atom.xml')
assert(atomFeed.includes('rel="self"'), 'atom feed declares its own address')
assert(atomFeed.includes('<entry>'), 'atom feed includes post entries')
assert(home.includes('application/atom+xml') && home.includes('application/rss+xml'), 'feed autodiscovery links are injected into the head')
const sitemapContent = read('sitemap.xml')
assert(Boolean(sitemapContent), 'sitemap generated')
assert(!sitemapContent.includes('/album/private/'), 'private album paths are excluded from sitemap')
assert(!sitemapContent.includes('data/music.json') && !sitemapContent.includes('data/category-cards.json'), 'raw json data files are excluded from sitemap')

assert(Boolean(read(path.join('series', 'index.html'))), 'learning paths page generated')
assert(Boolean(read(path.join('moments', 'index.html'))), 'moments page generated')
assert(!fs.existsSync(path.join(publicDir, 'projects', 'index.html')), 'removed projects page stays absent')

const search = read('search.xml') || read('search.json')
assert(Boolean(search), 'local search index generated')
assert(!search.includes('/album/private/'), 'private album paths are excluded from search')

// 搜索面板：推荐查找 / 键盘提示 / 结果计数容器必须存在，否则面板会退化成光秃秃的输入框
assert(home.includes('mistlane-search-suggest') && home.includes('mistlane-search-suggest-chips'), 'search panel keeps the quick-search suggestions')
assert(home.includes('data-suggestions='), 'search panel ships suggestion data')
assert(home.includes('mistlane-search-count') && home.includes('local-search-count'), 'search panel keeps the result counter')
assert(home.includes('mistlane-search-tip') && home.includes('<kbd>'), 'search panel keeps the keyboard hints')
assert(!home.includes('<script src="/js/search/local-search.js"'), 'local search script is not statically embedded')
assert(home.includes('data-script="/js/search/local-search.js"'), 'search panel carries the lazy load url')
assert(!home.includes('events.vercount.one/js'), 'third-party counter script is not loaded')

const featurePages = ['about/index.html', 'album/index.html', 'link/index.html', 'categories/index.html', 'tags/index.html']
featurePages.forEach(relative => assert(Boolean(read(relative)), `${relative} generated`))
assert(home.includes('/series/') && home.includes('/moments/'), 'learning paths and moments are present in navigation')
assert(!home.includes('id="pagination"'), 'home pagination is removed')
assert(home.includes('card-today') && home.includes('card-calendar'), 'left sidebar includes year progress and calendar')
assert(home.includes('card-announcement') && home.includes('card-visitor-stats') && home.includes('card-quick-links'), 'right sidebar includes announcement, visitor stats and quick links')
assert(home.includes('href="/rss/"') && home.includes('SUBSCRIBE'), 'quick links include RSS subscription')
assert(home.includes('/images/moe-icp.svg') && home.includes('footer-record-badge'), 'footer shows the moe icp badge')
assert(exists('images/moe-icp.svg'), 'moe icp badge asset is copied')
assert(!home.includes('astro-island') && !home.includes('component-export='), 'output has no Astro islands left')

passes.forEach(message => console.log(`[pass] ${message}`))
if (failures.length) {
  failures.forEach(message => console.error(`[fail] ${message}`))
  process.exitCode = 1
} else {
  console.log(`Regression check complete: ${passes.length} checks passed.`)
}
