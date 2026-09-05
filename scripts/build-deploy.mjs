#!/usr/bin/env node
/**
 * @file build-deploy.mjs
 * @description GIS Tools 部署包生成脚本
 *
 * 一次命令完成：构建 → 基础路径改写 → 生成构建清单 → 打包 zip（零第三方依赖）
 *
 *   pnpm build:deploy                          # 默认 /gis-tools/ 基础路径
 *   pnpm build:deploy -- --base=/               # 部署到站点根目录
 *   pnpm build:deploy -- --base=/tools/ --no-zip   # 只产出目录，不压缩
 *   pnpm build:deploy -- --skip-build          # 跳过构建，直接打包现有 dist
 *
 * 为什么需要"基础路径改写"：
 *   仓库里有几处绝对路径是写死的、Vite 的 base 配置覆盖不到：
 *     - index.html            启动动画 worker：`/gis-tools/entry-loader-worker.js`
 *     - public/sw-share-target.js   PWA 分享拦截：`SHARE_ACTION` / `META_KEY` / `BASE_PATH`
 *     - src/composables/useShareReceiver.ts  分享暂存 key：编译进 chunk 的字符串常量
 *     - manifest.webmanifest  PWA 的 start_url / scope / share_target.action
 *   只有 `--base` 与默认路径不一致时才会触发改写，默认路径下产物与原先逐字节一致。
 *
 * @author yuanyu
 */
import crypto from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip } from './lib/zip.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** 与 vite.config.ts / router 中的默认基础路径保持一致 */
const DEFAULT_BASE = '/gis-tools/'

// ---------------------------------------------------------------- 参数解析

function printHelp() {
  console.log(`
GIS Tools 部署包生成脚本

用法:
  node scripts/build-deploy.mjs [选项]

选项:
  --base=<path>     部署基础路径，必须以 / 开头且以 / 结尾，默认 ${DEFAULT_BASE}
  --out=<dir>       打包产物输出目录，默认 release
  --dist=<dir>      构建输出目录，默认 dist
  --name=<name>     自定义包名（不含扩展名），默认 名称-版本-时间戳-提交号
  --skip-build      跳过构建，直接打包已有的 dist
  --no-zip          只生成部署目录，不生成 zip
  -h, --help        显示本帮助

示例:
  node scripts/build-deploy.mjs
  node scripts/build-deploy.mjs --base=/
  node scripts/build-deploy.mjs --base=/tools/ --out=release
  node scripts/build-deploy.mjs --skip-build --name=gis-tools-hotfix
`)
}

const args = process.argv.slice(2)
if (args.includes('-h') || args.includes('--help')) {
  printHelp()
  process.exit(0)
}

const opts = {
  base: DEFAULT_BASE,
  out: 'release',
  dist: 'dist',
  name: '',
  skipBuild: false,
  zip: true,
}

for (const arg of args) {
  const [key, value] = arg.split('=')
  switch (key) {
    case '--base':
      opts.base = normalizeBase(value)
      break
    case '--out':
      opts.out = value
      break
    case '--dist':
      opts.dist = value
      break
    case '--name':
      opts.name = value
      break
    case '--skip-build':
      opts.skipBuild = true
      break
    case '--no-zip':
      opts.zip = false
      break
    default:
      console.warn(`[warn] 忽略未知参数: ${arg}`)
  }
}

function normalizeBase(value) {
  if (!value || typeof value !== 'string') return DEFAULT_BASE
  let base = value.trim()
  if (!base.startsWith('/')) base = `/${base}`
  if (!base.endsWith('/')) base = `${base}/`
  return base
}

// ---------------------------------------------------------------- 日志

const LOG_PREFIX = '[deploy]'
const log = (msg) => console.log(`${LOG_PREFIX} ${msg}`)
const step = (msg) => console.log(`\n${LOG_PREFIX} ${msg}`)

function fail(msg) {
  console.error(`\n${LOG_PREFIX} [ERROR] ${msg}`)
  process.exit(1)
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

// ---------------------------------------------------------------- 元信息

function readPackageJson() {
  const pkgPath = path.join(ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) fail('未找到 package.json')
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function collectGitInfo() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown'
  const commit = git(['rev-parse', '--short', 'HEAD']) || 'nogit'
  const fullCommit = git(['rev-parse', 'HEAD']) || ''
  const dirty = git(['status', '--porcelain']) !== ''
  return { branch, commit, fullCommit, dirty }
}

function timestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// ---------------------------------------------------------------- 构建

function runBuild(base, distDir) {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!fs.existsSync(viteBin)) {
    fail('未找到 vite，请先安装依赖：pnpm install（或 npm install）')
  }

  // vite 的 --outDir 相对 root 解析，绝对路径也接受；这里统一转成相对路径输出更友好
  const outDir = path.isAbsolute(distDir) ? path.relative(ROOT, distDir) : distDir

  log(`执行 vite build  (base=${base}, outDir=${outDir})`)
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        // vite.config.ts 读取 DEPLOY_BASE 决定 base 与 PWA manifest 路径
        DEPLOY_BASE: base,
        VITE_DEPLOY_BASE: base,
      },
    },
  )

  if (result.status !== 0) fail(`构建失败（退出码 ${result.status}）`)
}

// ---------------------------------------------------------------- 基础路径改写

/** 需要改写的硬编码路径（仅在 base != 默认时执行） */
const LEGACY_PATHS = [
  '/gis-tools/entry-loader-worker.js',
  '/gis-tools/share-receiver',
  '/gis-tools/share-pending-meta',
  '/gis-tools/share-pending-file-',
  '/gis-tools/',
]

function replaceLegacyPaths(content, base) {
  let out = content
  for (const legacy of LEGACY_PATHS) {
    if (!out.includes(legacy)) continue
    // '/gis-tools/' → base；'/gis-tools/xxx' → base + 'xxx'
    const replacement = legacy === DEFAULT_BASE ? base : base + legacy.slice(DEFAULT_BASE.length)
    out = out.split(legacy).join(replacement)
  }
  return out
}

function walkFiles(dir) {
  const result = []
  const walk = (current) => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, item.name)
      if (item.isDirectory()) walk(abs)
      else if (item.isFile()) result.push(abs)
    }
  }
  walk(dir)
  return result
}

function rewriteBasePath(distDir, base) {
  if (base === DEFAULT_BASE) {
    log('基础路径与默认一致，跳过路径改写')
    return 0
  }
  let changed = 0
  for (const file of walkFiles(distDir)) {
    const ext = path.extname(file).toLowerCase()
    // 只处理文本类产物；图片/字体等二进制不参与
    const isText = ['.html', '.js', '.json', '.webmanifest', '.txt', '.xml', '.css'].includes(ext)
    if (!isText) continue

    const before = fs.readFileSync(file, 'utf8')
    if (!LEGACY_PATHS.some((p) => before.includes(p))) continue

    let after = replaceLegacyPaths(before, base)

    // manifest：结构化改写，避免字符串替换误伤
    if (file.endsWith('.webmanifest')) {
      try {
        const manifest = JSON.parse(after)
        manifest.start_url = base
        manifest.scope = base
        if (manifest.share_target) manifest.share_target.action = `${base}share-receiver`
        if (Array.isArray(manifest.icons)) {
          manifest.icons = manifest.icons.map((icon) => ({
            ...icon,
            src: String(icon.src || '').replace(/^\//, ''),
          }))
        }
        after = JSON.stringify(manifest, null, 2)
      } catch (err) {
        console.warn(`[warn] manifest 解析失败，已跳过结构化改写: ${path.relative(distDir, file)} (${err.message})`)
      }
    }

    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8')
      changed++
    }
  }

  log(`已改写 ${changed} 个文件中的硬编码路径  →  ${base}`)
  return changed
}

/**
 * IIS 部署支持：在 dist 根目录补 web.config（MIME 修复版）
 *
 * IIS 静态文件处理对未注册 MIME 的扩展名（.webmanifest 等）直接返回 404，
 * 文件存在也会 404，这是 IIS 部署后 manifest 报 404 的根因。
 * web.config 对 nginx / GitHub Pages 部署无影响，因此每次构建都自动补上。
 * 用户若手工改过 web.config（不含本脚本标记）则不覆盖。
 */
function ensureIisWebConfig(distDir, vars) {
  const target = path.join(distDir, 'web.config')
  const marker = 'scripts/build-deploy.mjs 自动生成'

  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8')
    if (!existing.includes(marker)) {
      console.warn('[warn] dist/web.config 已存在且非本脚本生成，跳过覆盖')
      return false
    }
  }

  const tpl = loadTemplate('web.config.mime.tmpl')
  if (!tpl) {
    console.warn('[warn] 缺少 deploy/web.config.mime.tmpl，跳过 IIS 配置')
    return false
  }
  fs.writeFileSync(target, renderTemplate(tpl, vars), 'utf8')
  return true
}

// ---------------------------------------------------------------- 运行时配置

/**
 * 底图服务运行时配置（dist/config.json）
 *
 * public/config.json 随构建原样拷贝到 dist 根目录，站点部署后可直接修改、刷新生效
 * （地图右下角矢量/影像底图的 key、域名、自定义服务地址都在这里配）。
 * 构建机设置 TIANDITU_API_KEYS（或 VITE_TIANDITU_API_KEYS）环境变量时，
 * 会把 key 注入 dist/config.json，实现"打包时注入、部署后仍可手工修改"。
 */
function ensureBasemapConfig(distDir) {
  const target = path.join(distDir, 'config.json')
  const source = path.join(ROOT, 'public', 'config.json')

  if (!fs.existsSync(target)) {
    if (!fs.existsSync(source)) {
      console.warn('[warn] 缺少 public/config.json，跳过底图运行时配置')
      return false
    }
    fs.copyFileSync(source, target)
  }

  const envKeys = (process.env.TIANDITU_API_KEYS || process.env.VITE_TIANDITU_API_KEYS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (envKeys.length === 0) {
    log('底图运行时配置: dist/config.json 就绪（未设置 TIANDITU_API_KEYS，key 留待部署后填写）')
    return true
  }

  let config
  try {
    config = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch (err) {
    console.warn(`[warn] dist/config.json 解析失败，跳过 key 注入: ${err.message}`)
    return false
  }
  config.basemap ??= {}
  config.basemap.tianditu ??= {}
  // 环境变量的 key 放前面，config 里已写的 key 保留在后
  const existing = Array.isArray(config.basemap.tianditu.keys) ? config.basemap.tianditu.keys : []
  config.basemap.tianditu.keys = [...new Set([...envKeys, ...existing])]
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  log(`底图运行时配置: 已注入 ${envKeys.length} 个天地图 key 到 dist/config.json`)
  return true
}

// ---------------------------------------------------------------- 清单与模板

function buildFileList(distDir) {
  return walkFiles(distDir).map((abs) => ({
    path: path.relative(distDir, abs).split(path.sep).join('/'),
    size: fs.statSync(abs).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
  }))
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/\$\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match))
}

function loadTemplate(name) {
  const file = path.join(ROOT, 'deploy', name)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8')
}

// ---------------------------------------------------------------- 打包

function collectEntries(distDir, prefix, generated) {
  const entries = [{ name: `${prefix}` }]
  const seenDirs = new Set([''])

  const ensureDir = (rel) => {
    const parts = rel.split('/')
    let cur = ''
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur ? `${cur}/${parts[i]}` : parts[i]
      if (!seenDirs.has(cur)) {
        seenDirs.add(cur)
        entries.push({ name: `${prefix}${cur}/` })
      }
    }
  }

  for (const file of walkFiles(distDir)) {
    const rel = path.relative(distDir, file).split(path.sep).join('/')
    ensureDir(rel)
    entries.push({ name: `${prefix}${rel}`, abs: file })
  }

  for (const [rel, data] of Object.entries(generated)) {
    ensureDir(rel)
    entries.push({ name: `${prefix}${rel}`, data: Buffer.from(data, 'utf8') })
  }

  // 目录项排在同级文件之前，保持输出稳定
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return entries
}

function writePackageDir(targetDir, distDir, generated) {
  fs.mkdirSync(targetDir, { recursive: true })

  for (const file of walkFiles(distDir)) {
    const rel = path.relative(distDir, file)
    const dest = path.join(targetDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(file, dest)
  }

  for (const [rel, data] of Object.entries(generated)) {
    const dest = path.join(targetDir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data, 'utf8')
  }
}

// ---------------------------------------------------------------- 主流程

function main() {
  const pkg = readPackageJson()
  const gitInfo = collectGitInfo()
  const buildTime = new Date()
  const distDir = path.resolve(ROOT, opts.dist)
  const outDir = path.resolve(ROOT, opts.out)

  const packageName =
    opts.name ||
    `${pkg.name}-v${pkg.version}-${timestamp()}-${gitInfo.commit}${gitInfo.dirty ? '-dirty' : ''}`

  log('='.repeat(64))
  log(`项目   ${pkg.name} v${pkg.version}`)
  log(`分支   ${gitInfo.branch} @ ${gitInfo.commit}${gitInfo.dirty ? ' (工作区有未提交改动)' : ''}`)
  log(`基础   ${opts.base}`)
  log(`包名   ${packageName}`)
  log('='.repeat(64))

  // 1. 构建
  step("[1/5] 构建生产产物")
  if (opts.skipBuild) {
    log('--skip-build：跳过构建')
  } else {
    runBuild(opts.base, opts.dist)
  }
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    fail(`构建产物缺失：${path.join(distDir, 'index.html')} 不存在`)
  }

  // 2. 基础路径改写
  step("[2/5] 改写硬编码基础路径")
  rewriteBasePath(distDir, opts.base)

  // 2.5 底图服务运行时配置（部署后可直接改 dist/config.json）
  if (ensureBasemapConfig(distDir)) {
    log('已生成 dist/config.json（底图服务运行时配置）')
  }

  // 3. 生成清单与部署说明
  step("[3/5] 生成构建清单与部署说明")

  const vars = {
    VERSION: pkg.version,
    COMMIT: gitInfo.commit,
    BRANCH: gitInfo.branch,
    BUILDTIME: buildTime.toISOString(),
    BASE: opts.base,
    PACKAGE: packageName,
    ROOT_HINT: '/var/www/gis-tools',
  }

  // IIS 支持：dist 根补 web.config（MIME 修复），随产物一起进包
  if (ensureIisWebConfig(distDir, vars)) {
    log('已生成 dist/web.config（IIS MIME 修复，nginx/GH Pages 不受影响）')
  }

  const files = buildFileList(distDir)
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  const buildInfo = {
    name: pkg.name,
    version: pkg.version,
    base: opts.base,
    buildTime: buildTime.toISOString(),
    node: process.version,
    git: {
      branch: gitInfo.branch,
      commit: gitInfo.commit,
      fullCommit: gitInfo.fullCommit,
      dirty: gitInfo.dirty,
    },
    package: packageName,
    fileCount: files.length,
    totalSize,
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
  }

  vars.FILE_COUNT = files.length
  vars.TOTAL_SIZE = humanSize(totalSize)

  const generated = {
    'BUILD_INFO.json': `${JSON.stringify(buildInfo, null, 2)}\n`,
  }

  const nginxTpl = loadTemplate('nginx.conf.tmpl')
  if (nginxTpl) generated['_deploy/nginx.conf'] = renderTemplate(nginxTpl, vars)

  const deployTpl = loadTemplate('DEPLOY.md.tmpl')
  if (deployTpl) generated['_deploy/DEPLOY.md'] = renderTemplate(deployTpl, vars)

  // IIS SPA 回退版（含 URL Rewrite，需模块支持）：放 _deploy 供按需启用
  const spaTpl = loadTemplate('web.config.spafallback.tmpl')
  if (spaTpl) generated['_deploy/web.config.spafallback'] = renderTemplate(spaTpl, vars)

  log(`清单   ${files.length} 个文件，共 ${humanSize(totalSize)}`)

  // 4. 打包
  step("[4/5] 生成部署包")
  fs.mkdirSync(outDir, { recursive: true })

  let finalPath
  if (opts.zip) {
    const zipPath = path.join(outDir, `${packageName}.zip`)
    const { entries, bytes } = writeZip(
      zipPath,
      collectEntries(distDir, `${packageName}/`, generated),
    )
    finalPath = zipPath
    log(`zip    ${path.relative(ROOT, zipPath)}  (${entries} 个条目, 原始 ${humanSize(bytes)}, 压缩后 ${humanSize(fs.statSync(zipPath).size)})`)
  } else {
    const targetDir = path.join(outDir, packageName)
    writePackageDir(targetDir, distDir, generated)
    finalPath = targetDir
    log(`目录   ${path.relative(ROOT, targetDir)}`)
  }

  console.log(`\n${LOG_PREFIX} ${'='.repeat(56)}`)
  console.log(`${LOG_PREFIX} 部署包生成完成`)
  console.log(`${LOG_PREFIX} 路径: ${finalPath}`)
  console.log(`${LOG_PREFIX} 版本: v${pkg.version}  提交: ${gitInfo.commit}  基础路径: ${opts.base}`)
  console.log(`${LOG_PREFIX} ${'='.repeat(56)}\n`)
}

main()
