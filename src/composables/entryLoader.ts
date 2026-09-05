/**
 * @file Entry loading screen controller
 * @description Controls the main entry loading screen with build manifest tracking and
 *              smooth progress animation. Progress algorithm uses exponential decay toward
 *              target (non-100%) or linear sprint (100% finishing phase).
 *
 *              Build mode (with manifest): 0-95% resource load ratio, 95-100% sprint.
 *              Dev mode (no manifest): 0-60% fake progress, 60-95% milestones, 95-100% sprint.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-06-23
 */
/**
 * 主入口 loading 屏控制（构建时清单 + 平滑推进）
 *
 * 进度算法：
 *   目标值 ≠ 100%：每帧 displayPercent += (targetPercent - displayPercent) * 0.05
 *     → 指数衰减，永远在靠近目标值，不会停滞
 *   目标值 = 100%（finishing 阶段）：200ms 线性推进到 100%
 *
 * build 模式（有清单）：
 *   - 0-95%：清单内 JS/CSS 资源加载比例（PerformanceObserver 匹配清单条目）
 *   - 95-100%：hideEntryLoader() 后 200ms 线性冲刺到 100%
 *
 * dev 模式（无清单）：
 *   - 0-60%：假进度，6s 到 60%（easeOutCubic）
 *   - 60-95%：模块初始化里程碑回调（updateLoaderProgress）
 *   - 95-100%：hideEntryLoader() 后 200ms 线性冲刺到 100%
 */

let hideStarted = false
let displayPercent = 0
let targetPercent = 0

type LoaderPhase = 'loading' | 'waiting' | 'finishing'
let phase: LoaderPhase = 'loading'

const TIPS: { at: number; text: string }[] = [
  { at: 0, text: '正在加载地图核心模块' },
  { at: 18, text: '正在注册投影坐标系' },
  { at: 36, text: '正在构建地图视图' },
  { at: 54, text: '正在加载底图服务' },
  { at: 72, text: '正在绑定交互事件' },
  { at: 90, text: '即将完成，请稍后' },
]

function pickTipIndex(percent: number): number {
  let idx = 0
  for (let i = 0; i < TIPS.length; i++) {
    if (percent >= TIPS[i].at) idx = i
  }
  return idx
}

declare global {
  interface Window {
    __loaderText?: { percent: string; tip: string }
    __startEnding?: () => void
    __loaderCycleRemaining?: number
    __loaderResourceLoaded?: number
    __loaderResourceTotal?: number
    __loaderManifestReady?: boolean
    __entryLoaderManifest?: string[] | null
  }
}

function pushLoaderText(percent: string, tip: string): void {
  if (typeof window === 'undefined') return
  window.__loaderText = { percent, tip }
}

let fakeRafId: number | null = null
let finishStartTs = 0
const FINISH_DURATION = 200

/** build 模式：清单资源加载比例映射到 0-95%
 *  给 2% 初始进度，避免 PerformanceObserver 回调前一直显示 0%
 */
function getManifestPercent(): number {
  if (!window.__loaderManifestReady) return -1
  const loaded = window.__loaderResourceLoaded || 0
  const total = window.__loaderResourceTotal || 1
  if (total <= 0) return 0
  if (loaded === 0) return 2 // 初始进度，避免一直 0%
  return Math.min(95, Math.floor((loaded / total) * 95))
}

// ---- dev 模式假进度 ----
let fakeStartTs = 0
const FAKE_DURATION_MS = 6000
const FAKE_TARGET = 60

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

const CHASE_RATIO = 0.05    // 每帧按差值的 5% 追赶

/** hideStarted 后等待 Worker 回传 cycleRemaining 归零的最长时间（超时强制 finishing） */
const CYCLE_MAX_WAIT_MS = 5000
/** hideStarted 的时间戳（用于上面的超时判定） */
let hideStartedTs = 0

function tick(ts: number): void {
  if (phase === 'loading') {
    tickLoading(ts)
  } else if (phase === 'waiting') {
    tickWaiting(ts)
  } else if (phase === 'finishing') {
    tickFinishing(ts)
  }
}

function tickLoading(ts: number): void {
  const manifestPercent = getManifestPercent()

  if (manifestPercent >= 0) {
    // build 模式：用清单资源比例
    targetPercent = Math.max(manifestPercent, targetPercent)
  } else {
    // dev 模式：假进度 + 里程碑
    if (!fakeStartTs) fakeStartTs = ts
    const elapsed = ts - fakeStartTs
    const t = Math.min(elapsed / FAKE_DURATION_MS, 1)
    const fakeVal = Math.floor(easeOutCubic(t) * FAKE_TARGET)
    targetPercent = Math.max(fakeVal, targetPercent)
  }

  // 每帧按差值的 CHASE_RATIO 追赶目标值，永远在推进，不会停滞
  const diff = targetPercent - displayPercent
  if (Math.abs(diff) < 0.5) {
    displayPercent = targetPercent
  } else {
    displayPercent += diff * CHASE_RATIO
  }
  displayPercent = Math.min(displayPercent, 95)

  const displayValue = Math.floor(displayPercent)
  const tipIdx = pickTipIndex(displayValue)
  pushLoaderText(displayValue + '%', TIPS[tipIdx].text)

  // 检查是否可以进入 finishing
  //
  // cycleRemaining 由 Worker 的动画循环持续回传；若 Worker 异常（例如其内部
  // requestAnimationFrame 不可用导致循环停摆），该值会冻结在初始的大数值上，
  // 条件永不成立 → 永远不触发 startEnding → 遮罩不移除 → "进度 100% 后白屏"。
  // 因此加时间兜底：hideStarted 后超过 CYCLE_MAX_WAIT_MS 直接进 finishing。
  if (hideStarted) {
    if (!hideStartedTs) hideStartedTs = Date.now()
    const cycleOk = (window.__loaderCycleRemaining || 0) <= 50
    const cycleTimedOut = Date.now() - hideStartedTs > CYCLE_MAX_WAIT_MS
    if (cycleOk || cycleTimedOut) {
      if (cycleTimedOut && !cycleOk) {
        // eslint-disable-next-line no-console
        console.warn('[entryLoader] cycleRemaining timeout, force finishing')
      }
      phase = 'finishing'
      finishStartTs = 0
    }
  }

  fakeRafId = requestAnimationFrame(tick)
}

function tickWaiting(_ts: number): void {
  const cycleRemaining = window.__loaderCycleRemaining || 0
  if (cycleRemaining <= 50) {
    phase = 'finishing'
    finishStartTs = 0
  }
  fakeRafId = requestAnimationFrame(tick)
}

function tickFinishing(ts: number): void {
  if (!finishStartTs) finishStartTs = ts
  const elapsed = ts - finishStartTs
  const t = Math.min(elapsed / FINISH_DURATION, 1)
  const startVal = displayPercent
  const finishPercent = startVal + (100 - startVal) * t
  const displayValue = Math.floor(finishPercent)
  pushLoaderText(displayValue + '%', '欢迎使用 GIS Tools')

  if (t >= 1) {
    pushLoaderText('100%', '欢迎使用 GIS Tools')
    fakeRafId = null
    if (typeof window.__startEnding === 'function') {
      window.__startEnding()
    }
    return
  }
  fakeRafId = requestAnimationFrame(tick)
}

export function showEntryLoader(): void {
  if (typeof window === 'undefined') return
  if (hideStarted) return
  const mask = document.getElementById('entry-loader-mask')
  if (!mask) return
  displayPercent = 0
  targetPercent = 0
  phase = 'loading'
  if (fakeRafId) cancelAnimationFrame(fakeRafId)
  // build 模式：给 2% 初始进度，避免 PerformanceObserver 回调前一直显示 0%
  if (window.__loaderManifestReady) {
    displayPercent = 2
    targetPercent = 2
  }
  pushLoaderText(Math.floor(displayPercent) + '%', TIPS[0].text)
  fakeRafId = requestAnimationFrame(tick)
}

/**
 * 更新模块初始化进度（dev 模式 60-95%，build 模式作为兜底）
 */
export function updateLoaderProgress(percent: number, tip?: string): void {
  const clamped = Math.max(0, Math.min(95, percent))
  if (clamped > targetPercent) {
    targetPercent = clamped
  }
  if (tip) {
    const tipIdx = pickTipIndex(clamped)
    TIPS[tipIdx] = { at: TIPS[tipIdx].at, text: tip }
  }
}

/**
 * 检查清单内资源是否已全部加载完成
 * build 模式：清单只包含初始加载必需的资源，必须 100% 完成
 * dev 模式：始终返回 true
 */
function isManifestComplete(): boolean {
  if (!window.__loaderManifestReady) return true // dev 模式不检查
  const loaded = window.__loaderResourceLoaded || 0
  const total = window.__loaderResourceTotal || 0
  if (total <= 0) return true
  return loaded >= total // 100% 阈值：清单只含初始必需资源
}

/**
 * 隐藏入口 loading 屏
 * App.vue 调用前应确保清单内资源已加载完成（build 模式）
 */
export function hideEntryLoader(): void {
  if (typeof window === 'undefined') return
  if (hideStarted) return
  hideStarted = true
  hideStartedTs = Date.now()
  // eslint-disable-next-line no-console
  console.info('[entryLoader] hide requested, phase=' + phase + ', manifest complete=' + isManifestComplete())
}

/**
 * 查询是否可以安全隐藏 loading 屏
 * build 模式：清单内所有资源必须加载完成
 * dev 模式：始终返回 true
 */
export function canHideLoader(): boolean {
  return isManifestComplete()
}
