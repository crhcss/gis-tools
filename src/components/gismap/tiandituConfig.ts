/**
 * @file Tianditu basemap configuration
 * @description Provides configuration for Tianditu (TianDiTu) basemap services including
 *              basemap types (vector/imagery), layer URLs, API key rotation with probe-based
 *              failover, and availability checking. Supports multi-key fallback via localStorage.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-06-22
 */
import Common from '~/common/Common'
import { logger } from '~/common/logger'
import { getBasemapRuntimeConfig, onBasemapConfigLoaded } from '~/components/gismap/basemapConfig'

/**
 * 天地图投影类型
 * - c: 经纬度投影 (EPSG:4326/4490)
 * - w: 球面墨卡托投影 (EPSG:3857)
 */
export type TianDiTuProjectionSuffix = 'c' | 'w'

/**
 * 根据视图投影代码获取天地图 URL 后缀
 * 始终使用 'w'（球面墨卡托 EPSG:3857）瓦片，由 OL 自动重投影到视图坐标系
 * @param _viewProjCode 视图投影代码（未使用）
 * @returns 固定返回 'w'
 */
export function getTianDiTuProjSuffix(_viewProjCode: string): TianDiTuProjectionSuffix {
  return 'w'
}

/**
 * 根据当前页面协议获取天地图基础 URL 前缀
 * 使用新域名 tianditu.gov.cn（同时支持 HTTP 和 HTTPS）
 * 旧域名 tianditu.com 不支持 HTTPS，在 HTTPS 页面下会被浏览器拦截
 * config.json 里配了 baseUrl 时以其为准（内网镜像/自建节点场景）
 */
function getTianDiTuBaseUrl(): string {
  const configured = getBasemapRuntimeConfig().tianditu.baseUrl.replace(/\/+$/, '')
  if (configured) return configured
  const protocol = typeof location !== 'undefined' && location.protocol === 'https:' ? 'https' : 'http'
  return `${protocol}://t0.tianditu.gov.cn`
}

/**
 * 构建天地图图层 URL
 * @param layerType 图层类型 (vec/cva/img/cia)，也支持 config.json 里自定义的类型
 * @param projSuffix 投影后缀 (c/w)
 * @returns 完整的天地图 DataServer URL
 */
export function buildTianDiTuLayerUrl(
  layerType: string,
  projSuffix: TianDiTuProjectionSuffix,
): string {
  return `${getTianDiTuBaseUrl()}/DataServer?T=${layerType}_${projSuffix}`
}

// ============ 天地图 API Key 轮换与降级 ============

const TDT_KEYS_STORAGE = 'gis-tools:tianditu-keys'
const TDT_ACTIVE_INDEX_STORAGE = 'gis-tools:tianditu-active-index'

interface TianDiTuKeyState {
  /** 探测通过的 key 列表（按顺序保留，未通过的放到末尾） */
  keys: string[]
  /** 当前激活的 key 在 keys 数组中的索引 */
  activeIndex: number
}

let cachedState: TianDiTuKeyState | null = null

/**
 * 加载所有可用 key：config.json 的 basemap.tianditu.keys + 构建期环境变量
 * 部署后只需改 config.json，无需重新打包
 */
function loadKeys(): string[] {
  return getBasemapRuntimeConfig().tianditu.keys.filter(Boolean)
}

// config.json 加载完成后（key 可能已变），重置轮换缓存让新配置立即生效
onBasemapConfigLoaded(() => {
  cachedState = null
})

/**
 * 从 localStorage 恢复 key 状态
 */
function loadState(): TianDiTuKeyState | null {
  if (cachedState) return cachedState
  const configuredKeys = loadKeys()
  if (configuredKeys.length === 0) return null
  try {
    const raw = localStorage.getItem(TDT_KEYS_STORAGE)
    const idxRaw = localStorage.getItem(TDT_ACTIVE_INDEX_STORAGE)
    if (raw) {
      const stored = JSON.parse(raw) as string[]
      // 只保留仍在配置中的 key
      const valid = stored.filter(k => configuredKeys.includes(k))
      // 追加新加入的 key 到末尾
      for (const k of configuredKeys) {
        if (!valid.includes(k)) valid.push(k)
      }
      if (valid.length > 0) {
        const idx = idxRaw ? Math.max(0, Math.min(parseInt(idxRaw, 10) || 0, valid.length - 1)) : 0
        cachedState = { keys: valid, activeIndex: idx }
        return cachedState
      }
    }
  } catch {
    // ignore
  }
  cachedState = { keys: configuredKeys, activeIndex: 0 }
  return cachedState
}

/**
 * 持久化 key 状态
 */
function saveState(state: TianDiTuKeyState): void {
  try {
    localStorage.setItem(TDT_KEYS_STORAGE, JSON.stringify(state.keys))
    localStorage.setItem(TDT_ACTIVE_INDEX_STORAGE, String(state.activeIndex))
  } catch {
    // ignore
  }
}

/**
 * 探测单个 key 的可用性
 * 通过拉一张最小瓦片（zoom 0，瓦片 0/0/0）验证
 * @returns true 表示可用
 */
async function probeKey(key: string, timeoutMs = 4000): Promise<boolean> {
  // 天地图 tile (0,0,0) 在 3857 下是全球一张图
  const url = `${getTianDiTuBaseUrl()}/DataServer?T=vec_w&x=0&y=0&l=0&tk=${key}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { method: 'GET', signal: controller.signal, mode: 'cors' })
    clearTimeout(timer)
    if (!resp.ok) return false
    const ct = resp.headers.get('content-type') || ''
    // 图片返回 image/png 或 image/jpeg；其他（如 XML/HTML 错误页）说明 key 无效
    return ct.startsWith('image/')
  } catch {
    clearTimeout(timer)
    return false
  }
}

/**
 * 探测并轮换到第一个可用的 key
 * @returns 选中的可用 key，若全部不可用则返回空字符串
 */
export async function selectAvailableTianDiTuKey(): Promise<string> {
  const state = loadState()
  if (!state || state.keys.length === 0) {
    logger.warn('天地图 API Key 未配置：请在部署目录 config.json 的 basemap.tianditu.keys 中配置')
    return ''
  }

  // 从当前 activeIndex 开始探测，找到第一个可用的 key
  const startIdx = state.activeIndex
  // 先探测当前 key 是否仍可用
  const cur = state.keys[startIdx]
  if (cur && await probeKey(cur)) {
    logger.info(`天地图 key 探测通过（当前）: index=${startIdx}`)
    saveState(state)
    return cur
  }

  // 当前 key 不可用，顺序探测后续 key
  for (let i = 0; i < state.keys.length; i++) {
    if (i === startIdx) continue
    const key = state.keys[i]
    if (await probeKey(key)) {
      logger.info(`天地图 key 降级到 index=${i}`)
      state.activeIndex = i
      saveState(state)
      // 把探测失败的旧 key 移到最后（保证下次仍会重新探测）
      // 这里不动顺序，仅更新 activeIndex
      return key
    }
    logger.warn(`天地图 key 探测失败: index=${i}`)
  }

  // 全部不可用
  logger.error('所有天地图 API Key 均不可用，将降级到本地底图')
  return ''
}

/**
 * 获取当前应使用的天地图 key（同步，无探测）
 * 注意：仅用于某些需要同步 key 的场景（如 TianDiTuGisMapLayer 默认构造）
 * 推荐在异步流程中调用 selectAvailableTianDiTuKey 获取真实可用 key
 */
export function getCurrentTianDiTuKey(): string {
  const state = loadState()
  if (!state || state.keys.length === 0) {
    // 回退到 Common 中的旧逻辑
    return Common.getTiandituApiKey()
  }
  return state.keys[state.activeIndex] || ''
}

/**
 * 重置 key 状态（用于调试或手动重新探测）
 */
export function resetTianDiTuKeyState(): void {
  cachedState = null
  try {
    localStorage.removeItem(TDT_KEYS_STORAGE)
    localStorage.removeItem(TDT_ACTIVE_INDEX_STORAGE)
  } catch {
    // ignore
  }
}

/**
 * 检测天地图服务可达性
 * 异步探测当前激活的 key 是否可用
 * @returns true 表示可用
 */
export async function checkTianDiTuAvailability(): Promise<boolean> {
  if (!getBasemapRuntimeConfig().tianditu.enabled) {
    logger.warn('天地图底图服务已在 config.json 中禁用')
    return false
  }
  const state = loadState()
  if (!state || state.keys.length === 0) {
    logger.warn('天地图 API Key 未配置，底图切换不可用：请在部署目录 config.json 的 basemap.tianditu.keys 中配置')
    return false
  }
  const key = await selectAvailableTianDiTuKey()
  return Boolean(key)
}