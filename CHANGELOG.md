# 更新日志

所有显著变更记录于此。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增
- **部署包生成脚本**：`pnpm build:deploy`（`scripts/build-deploy.mjs` + 零依赖 zip 写入器 `scripts/lib/zip.mjs`），一次命令完成 构建 → 硬编码路径改写 → 生成构建清单（`BUILD_INFO.json`，含文件 SHA256）→ 打包 zip；支持 `--base` / `--skip-build` / `--no-zip` / `--name` / `--out` / `--dist`。
- **部署模板**：`deploy/nginx.conf.tmpl`（SPA history 回退 + 缓存策略，按 base 渲染）、`deploy/DEPLOY.md.tmpl`（部署说明，随包携带）。
- **IIS 部署支持**：构建后自动在 dist 根生成 `web.config`（注册 `.webmanifest` / woff 等 MIME，修复 IIS 下 manifest 404；对 nginx/GH Pages 无影响）；包内附 `_deploy/web.config.spafallback`（URL Rewrite 版 SPA 回退，按需启用）。`deploy.bat` 一键部署（双击可用，自动装依赖 + 透传参数）。

### 变更
- **部署路径可配置**：`vite.config.ts` 的 `base` 与 PWA `start_url` / `scope` / `share_target.action` 改为读取 `DEPLOY_BASE` 环境变量（默认仍为 `/gis-tools/`，CI 构建行为不变）；路由 history base 改用 `import.meta.env.BASE_URL`。部署脚本会同步改写 `index.html` 启动动画 worker、`sw-share-target.js` 分享路径、chunk 内分享暂存 key 等硬编码路径。
- `.gitignore` 增加 `release/`。

### 修复
- **入口 loading 屏卡死 + 100% 后白屏**：
  - **卡死（73%）**：`entry-loader-manifest` 插件此前会把入口 chunk 的 `dynamicImports`（路由级 lazy import，如 `() => import('~/components/data/GisData.vue')`，4.5 MB）与**所有**顶层 `.css` 都塞进"初始必需资源清单"。但路由级 chunk 只在 vue-router 解析路由时才发起请求、且 vite 不会为它生成 `<link rel="modulepreload">`，导致 PerformanceObserver 永远等不到该请求，`canHideLoader()` 恒为 false（控制台无任何报错，只反复打印 `[entryLoader] waiting for manifest resources to complete...`）。现改为：只收集入口的**静态依赖** + 这些 chunk 自身 `cssFiles` 引用的 CSS，清单由 9 项收敛为 5 项。
  - **100% 后白屏**：`entry-loader-mask` 遮罩未移除，盖在已渲染好的页面上。移除动作只由 Worker 回传 `done` 触发，而 `public/entry-loader-worker.js` 的动画循环使用了 `requestAnimationFrame`——**DedicatedWorkerGlobalScope 中并无该 API**，循环会抛 `ReferenceError` 停摆，`cycleRemaining` 冻结在初始值，`entryLoader.ts` 中 `cycleRemaining <= 50` 永不成立 → 永不触发 `startEnding` → 遮罩留存。Worker 内部错误不打到主页面控制台，故表现为"控制台无报错的纯白屏"。修复：Worker 内加 `requestAnimationFrame` / `cancelAnimationFrame` 的 setTimeout polyfill；并在 `__startEnding` 加 2s 强制清理兜底、`entryLoader.ts` 加 `CYCLE_MAX_WAIT_MS`(5s) 强制 finishing 兜底——即使 Worker 异常也保证遮罩移除。
  - 另修正路由兜底：新增 `{ path: '/:pathMatch(.*)*', redirect: '/' }`。当 base 为 `/gis-tools/` 而访问 `/gis-tools`（无尾斜杠）时 vue-router 的 `stripBase` 匹配不上，`<router-view>` 会渲染空白。
  - `App.vue` 用 `<Suspense>` 包裹 `router-view`：GisData chunk 不再被首屏清单阻塞后，loading 消失到 chunk 就绪之间会出现空白，用 fallback 占位（"正在加载数据模块…"）覆盖。

## [0.1.1] - 2026-06-22

### 新增
- **天地图 API Key 轮换降级**：支持配置多个 key（`VITE_TIANDITU_API_KEYS`），每次启动应用自动探测可用 key，配额耗尽时降级到下一个；全部不可用时自动切回本地底图。状态持久化到 localStorage。
- **坐标系范围提示**：切换投影坐标系时显示左右两条红色虚线边，框出当前坐标系的标准经度范围（不覆盖整个矩形避免性能问题，不参与要素交互）。
- **底图切换器**：新增【无】选项，支持完全关闭底图。
- **天地图瓦片级别限制**：明确设置 `minZoom: 0, maxZoom: 18`，避免请求超出天地图支持的瓦片级别。

### 变更
- **默认底图**：底图切换器默认选中"矢量"，顺序调整为「矢量 → 影像 → 本地 → 无」。
- **GisDataInspactor（编辑&查看）和 MapDrawer（绘制图形）**：默认从天地图底图加载，提供完整的中国轮廓参照。
- **BaseTianDiTuMap**：支持 `options.projection` 自定义投影，初始化时正确传入投影参数。
- **GisMapBase.vue**：默认初始化时不加载本地底图（保持 BlankMap 默认行为）。
- **深色主题滤镜**：移除 `invert(1) hue-rotate(180deg)` 反相滤镜，避免天地图影像被反色成异常颜色，改为轻微降低亮度。
- **底图切换器和工具栏**：统一按钮样式为 `.gismap-btn`，操作区域使用外层 `.gismap-btns-wrap` 包裹圆角 6px 透明容器。

### 修复
- **高斯-克吕格分带投影底图显示**：修复 EPSG:4524/4525 等分带投影下天地图底图无法正确显示的问题，统一使用中国经度范围（68°~140°）+ 全球纬度（±85°）作为 worldExtent。
- **XYZ source projection**：明确设置天地图 source projection 为 EPSG:3857，避免 OL 误判为视图投影导致瓦片不重投影。
- **图层初始化顺序**：BaseTianDiTuMap 显式调用 `addLayer` 添加底图，避免构造时底图未生效。
- **坐标系范围提示框性能**：使用左右两条 LineString 替代大矩形 Polygon，避免 `forEachFeatureAtPixel` 遍历覆盖大量几何导致卡顿；通过 `layerFilter` 跳过坐标系范围图层。

### 优化
- **pointermove 节流**：使用 RAF 节流 + 像素去重，避免每帧多次查询要素和触发响应式更新。
- **坐标显示节流**：鼠标坐标显示使用 RAF 节流，避免拖动时每像素更新。
- **默认禁用要素 hover 高亮**：所有 feature 默认不参与 `pointermove` hover 高亮和 `FeatureOver` 事件，需要交互的图层显式调用 `map.enableFeatureSelect(layer)` 启用。
- **CSS 滤镜性能**：移除深色主题反相滤镜，降低 GPU 开销。

## [0.1.0] - 2026-06-22

初始版本。