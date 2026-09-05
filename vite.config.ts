import path from 'path'
import { fileURLToPath } from 'url'

import vue from '@vitejs/plugin-vue'
import {
  presetAttributify,
  presetIcons,
  presetUno,
  transformerDirectives,
  transformerVariantGroup,
} from 'unocss'
import Unocss from 'unocss/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import Components from 'unplugin-vue-components/vite'
import { defineConfig, Plugin } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { VitePWA } from 'vite-plugin-pwa'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pathSrc = path.resolve(__dirname, 'src')

/**
 * 部署基础路径
 *
 * 默认 /gis-tools/（GitHub Pages）。改部署路径时不要手改这里，改用部署脚本：
 *   pnpm build:deploy -- --base=/
 * 脚本会注入 DEPLOY_BASE 环境变量，base 与 PWA manifest 的 start_url / scope /
 * share_target.action 会一并跟着变，保证三者始终一致。
 */
const BASE = process.env.DEPLOY_BASE || '/gis-tools/'

/**
 * Vite 插件：build 时收集"初始加载必需"的资源清单，内联到 index.html
 *
 * 算法（BFS）：
 *   1. 从入口 chunk（isEntry）出发
 *   2. 递归收集静态依赖（imports）—— 这些是初始加载必需的
 *   3. 不收集动态依赖（dynamicImports）—— 路由级 lazy import（如
 *      () => import('~/components/data/GisData.vue')）只在 vue-router 解析路由时
 *      才发起请求，时机晚于首屏 DOMContentLoaded；PerformanceObserver 在
 *      entry-loader-manifest 注入的清单里等它，必然超时。
 *      这些 chunk 由 vite 自动加 <link rel="modulepreload"> 或路由导航时按需加载，
 *      loading 屏不应该阻塞自己等不到的请求。
 *   4. 顶层 .css 资源加入清单
 *
 * 这样清单只包含初始渲染必需的资源，运行时等 100% 完成才隐藏 loading
 * dev 模式下不生成清单，loading 屏降级为里程碑驱动
 */
function entryLoaderManifest(): Plugin {
  let chunkAssets: string[] = []
  return {
    name: 'entry-loader-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const initialChunks = new Set<string>()
      const visited = new Set<string>()

      // 找到入口 chunk
      const entryNames = Object.entries(bundle)
        .filter(([, c]) => c.type === 'chunk' && c.isEntry)
        .map(([name]) => name)

      // BFS 队列：只递归静态依赖
      const queue: string[] = [...entryNames]

      while (queue.length > 0) {
        const name = queue.shift()!
        if (visited.has(name)) continue
        visited.add(name)

        const chunk = bundle[name]
        if (!chunk || chunk.type !== 'chunk') continue

        initialChunks.add(name)

        // 只递归静态依赖；dynamicImports（路由级 lazy / 按需功能模块）不收集
        for (const dep of chunk.imports || []) {
          if (!visited.has(dep)) {
            queue.push(dep)
          }
        }
      }

      // CSS 文件：只收集被初始 chunks 引用的 css（chunk.cssFiles 是 vite 在
      // generateBundle 阶段给出的、被该 chunk import 引入的 css 列表）。
      // 不要全收所有顶层 .css，否则 lazy 视图（如 GisData.vue）的 css 也会被
      // 塞进 manifest，但它的请求时机晚于首屏，loading 屏永远等不到。
      const cssSet = new Set<string>()
      for (const name of initialChunks) {
        const chunk = bundle[name]
        if (!chunk || chunk.type !== 'chunk') continue
        for (const css of chunk.cssFiles || []) {
          cssSet.add(css)
        }
      }
      const cssAssets = [...cssSet]

      chunkAssets = [...initialChunks, ...cssAssets]
    },
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string) {
        const manifestScript = `<script>window.__entryLoaderManifest=${JSON.stringify(chunkAssets)}</script>`
        return html.replace('<!--__ENTRY_LOADER_MANIFEST__-->', manifestScript)
      },
    },
  }
}

export default defineConfig({
  base: BASE,
  resolve: {
    alias: {
      '~/': `${pathSrc}/`,
      'vue': 'vue/dist/vue.esm-bundler.js'
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "~/styles/element/index.scss" as *;`,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-vue': ['vue', 'vue-router'],
          'vendor-element': ['element-plus', '@element-plus/icons-vue'],
          'vendor-geo': ['ol', '@turf/turf', 'proj4', '@sphinx_hq/shapefile-parser', 'wkx'],
          'vendor-monaco': ['monaco-editor']
        }
      }
    }
  },
  plugins: [
    entryLoaderManifest(),
    vue(),
    nodePolyfills(),
    Components({
      extensions: ['vue', 'md'],
      include: [/\.vue$/, /\.vue\?vue/, /\.md$/],
      resolvers: [
        ElementPlusResolver({
          importStyle: 'sass',
        }),
      ],
      dts: 'src/components.d.ts',
    }),

    Unocss({
      presets: [
        presetUno(),
        presetAttributify(),
        presetIcons({
          scale: 1.2,
          warn: true,
        }),
      ],
      transformers: [
        transformerDirectives(),
        transformerVariantGroup(),
      ]
    }),

    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'GIS Tools',
        short_name: 'GIS Tools',
        description: 'GIS 数据处理与可视化工具',
        theme_color: '#1d1e1f',
        background_color: '#1d1e1f',
        display: 'standalone',
        // 显式声明 start_url 和 scope，确保 PWA 注册路径与 share_target.action 一致
        // 已安装的 PWA 缓存旧 manifest，新增 share_target 后需用户重装 PWA 才能注册分享目标
        start_url: BASE,
        scope: BASE,
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        // Web Share Target：让已安装的 PWA 出现在移动端系统分享面板
        // 接收空间数据文件（GeoJSON/WKT/SHP/ShapeZip/DXF/EXF/电子报盘）
        share_target: {
          action: `${BASE}share-receiver`,
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              {
                name: 'files',
                accept: [
                  'application/json',
                  '.geojson',
                  'text/plain',
                  '.wkt',
                  '.txt',
                  'application/octet-stream',
                  '.shp',
                  '.exf',
                  'application/zip',
                  '.zip',
                  'application/dxf',
                  '.dxf',
                ],
              },
            ],
          },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,txt,woff2}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024, // 8 MiB，覆盖 Monaco/GisData 等大 chunk
        // 引入自定义 SW 脚本：拦截系统分享的 POST 请求并暂存文件
        importScripts: ['sw-share-target.js'],
      },
    }),
  ],
})
