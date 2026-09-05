<script lang="ts" setup>
/**
 * @file Root application component
 * @description Manages the entry loading screen lifecycle using MutationObserver to detect
 *              when the app DOM stabilizes, then hides the loader. Includes mobile responsive
 *              styles for dialogs and drawers to minimize whitespace on small screens.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2024-08-06
 */
import {reactive, onMounted, onBeforeUnmount} from "vue";

import {hideEntryLoader, updateLoaderProgress, canHideLoader} from "~/composables/entryLoader";

const font = reactive({
  color: 'rgba(0, 0, 0, .05)',
})

/**
 * 入口 loading 隐藏策略：
 *  1) MutationObserver 监听 #app 子树的所有 DOM 变化
 *  2) 当连续 QUIET_MS（默认 1200ms）没有任何 mutation，判定 app 初始化完毕
 *  3) 初始化完毕后再等 MIN_HOLD_MS（默认 1000ms），让首帧资源先到位
 *  4) 检查清单内所有资源是否加载完成（build 模式），未完成则轮询等待
 *  5) 同时设置 HARD_TIMEOUT_MS（默认 30s）兜底，防止异常时永远卡住
 * 满足任一可隐藏条件即调用 hideEntryLoader（内部幂等）
 */
const QUIET_MS = 1200        // 连续无 DOM 变化的"安静期"
const MIN_HOLD_MS = 1000     // 安静期后再等 1s
const HARD_TIMEOUT_MS = 60000 // 兜底（60s，给 Monaco/GisData 等大 chunk 足够时间）
const MANIFEST_POLL_MS = 200  // 清单完成轮询间隔
const MANIFEST_TIMEOUT_MS = 60000 // 清单完成超时兜底（等所有初始必需资源加载完）

let quietTimer: number | null = null
let holdTimer: number | null = null
let hardTimer: number | null = null
let manifestTimer: number | null = null
let observer: MutationObserver | null = null

function tryHide(): void {
  if (canHideLoader()) {
    updateLoaderProgress(90, '即将完成，请稍后')
    hideEntryLoader()
    cleanup()
  } else {
    // 清单内资源还没加载完，轮询等待
    // eslint-disable-next-line no-console
    console.info('[entryLoader] waiting for manifest resources to complete...')
    const startTime = Date.now()
    manifestTimer = window.setInterval(() => {
      if (canHideLoader() || Date.now() - startTime > MANIFEST_TIMEOUT_MS) {
        if (manifestTimer) window.clearInterval(manifestTimer)
        manifestTimer = null
        if (!canHideLoader()) {
          // eslint-disable-next-line no-console
          console.warn('[entryLoader] manifest timeout, force hide')
        }
        updateLoaderProgress(90, '即将完成，请稍后')
        hideEntryLoader()
        cleanup()
      }
    }, MANIFEST_POLL_MS)
  }
}

function resetQuietTimer(): void {
  if (quietTimer !== null) window.clearTimeout(quietTimer)
  quietTimer = window.setTimeout(() => {
    // 进入安静期：再额外等 MIN_HOLD_MS 再 hide
    if (holdTimer !== null) window.clearTimeout(holdTimer)
    holdTimer = window.setTimeout(() => {
      tryHide()
    }, MIN_HOLD_MS)
  }, QUIET_MS)
}

function cleanup(): void {
  if (observer) { observer.disconnect(); observer = null }
  if (quietTimer) { window.clearTimeout(quietTimer); quietTimer = null }
  if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = null }
  if (hardTimer) { window.clearTimeout(hardTimer); hardTimer = null }
  if (manifestTimer) { window.clearInterval(manifestTimer); manifestTimer = null }
}

onMounted(() => {
  // Vue app 挂载完成
  updateLoaderProgress(65, '正在初始化应用')
  // 硬超时兜底
  hardTimer = window.setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn('[entryLoader] hard timeout reached, force hide')
    updateLoaderProgress(90, '即将完成，请稍后')
    hideEntryLoader()
    cleanup()
  }, HARD_TIMEOUT_MS)

  // 监听 #app 整棵子树的变化，连续 QUIET_MS 无变化即视为初始化完成
  const target = document.getElementById('app') || document.body
  observer = new MutationObserver(() => {
    resetQuietTimer()
  })
  observer.observe(target, { childList: true, subtree: true, attributes: true })
  resetQuietTimer()
})

onBeforeUnmount(() => {
  cleanup()
})

</script>
<template>
  <el-config-provider size="small">
    <el-watermark style="height: 100%; width: 100%;" :font="font" :content="[]">
      <!--
        Suspense 包裹 router-view：
        路由组件是 () => import() 的异步 chunk（GisData 达 4.5 MB），
        loading 屏已不再阻塞等它（见 vite.config.ts 的 entryLoaderManifest），
        因此首屏 loading 消失后到 chunk 就绪之间会出现白屏空档。
        用 Suspense fallback 盖住这段空档，避免白屏。
      -->
      <router-view v-slot="{ Component }">
        <Suspense>
          <component :is="Component" />
          <template #fallback>
            <div class="route-loading">
              <div class="route-loading-bar"></div>
              <span>正在加载数据模块…</span>
            </div>
          </template>
        </Suspense>
      </router-view>
    </el-watermark>
  </el-config-provider>
</template>
<style>
html,
body,
#app {
  height: 100%;
}

/* 路由 chunk 加载中的占位（避免首屏 loading 消失后白屏） */
.route-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  height: 100%;
  min-height: 240px;
  color: var(--el-text-color-secondary, #909399);
  font-size: 13px;
}
.route-loading-bar {
  width: 120px;
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, transparent, #ea580c, transparent);
  background-size: 200% 100%;
  animation: route-loading-slide 1s linear infinite;
}
@keyframes route-loading-slide {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

/* 移动端弹窗铺满 + 减少留白 */
@media (max-width: 767px) {
  .el-overlay-dialog .el-dialog {
    width: 100% !important;
    height: 100% !important;
    max-height: 100% !important;
    margin: 0 !important;
    border-radius: 0 !important;
  }

  .el-overlay-dialog .el-dialog__header {
    padding: 8px 12px !important;
    margin-right: 0 !important;
  }

  .el-overlay-dialog .el-dialog__body {
    padding: 8px 12px !important;
    flex: 1;
    overflow: auto;
  }

  .el-overlay-dialog .el-dialog__footer {
    padding: 8px 12px !important;
  }

  .el-overlay-dialog .el-dialog__title {
    font-size: 14px !important;
  }

  .el-message-box {
    width: 90% !important;
  }

  /* 移动端 el-drawer 留白优化 */
  .el-drawer__body {
    padding: 8px 8px 4px !important;
  }

  .el-drawer__header {
    padding: 8px 12px !important;
    margin-bottom: 0 !important;
  }
}
</style>
<style scoped>
#app {
  text-align: center;
}
</style>
