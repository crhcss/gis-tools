/**
 * @file Basemap runtime configuration
 * @description 底图服务的运行时配置。构建产物根目录下的 config.json 会被原样部署，
 *              部署后直接改这个文件、刷新页面即可生效，不需要重新打包。
 *
 *              配置结构（全部字段可选，缺失时回退到构建期环境变量）：
 *              {
 *                "basemap": {
 *                  "tianditu": {
 *                    "enabled": true,          // 总开关，false 时矢量/影像都不可用
 *                    "baseUrl": "",            // 服务域名，留空按页面协议自动 http/https
 *                    "keys": ["key1", "key2"]  // API Key 列表，按顺序探测轮换
 *                  },
 *                  "services": [
 *                    {
 *                      "id": "vec",            // 与内置一致：vec=矢量，img=影像
 *                      "label": "矢量",         // 切换按钮文案
 *                      "enabled": true,        // false 时切换器不显示该按钮
 *                      "url": "",              // 底图瓦片 URL 模板，留空用天地图默认服务
 *                      "annotationUrl": "",    // 注记图层 URL 模板，留空用天地图默认服务
 *                      "layerType": "vec",     // 天地图图层类型（仅 url 为空时生效）
 *                      "annotationLayerType": "cva"
 *                    }
 *                  ]
 *                }
 *              }
 *
 *              url / annotationUrl 支持占位符 {z} {x} {y} {key}，例：
 *                "https://my-gis.example.com/vec/{z}/{x}/{y}.png"
 *                "https://t0.tianditu.gov.cn/DataServer?T=vec_w&x={x}&y={y}&l={z}&tk={key}"
 * @author yuanyu
 * @date 2026-09-05
 */
import { logger } from '~/common/logger'

/**
 * 单个底图服务配置
 */
export interface BasemapServiceConfig {
  /** 服务标识，内置 vec（矢量）/ img（影像） */
  id: string
  /** 切换器按钮文案 */
  label: string
  /** 是否启用，false 时切换器不显示 */
  enabled: boolean
  /** 底图瓦片 URL 模板（含 {z}/{x}/{y}，需要 key 时用 {key}）；留空用天地图默认服务 */
  url: string
  /** 注记图层 URL 模板；留空用天地图默认服务 */
  annotationUrl: string
  /** 天地图底图图层类型，仅 url 为空时生效 */
  layerType?: string
  /** 天地图注记图层类型，仅 annotationUrl 为空时生效 */
  annotationLayerType?: string
}

/**
 * 天地图服务配置
 */
export interface TianDiTuRuntimeConfig {
  /** 总开关 */
  enabled: boolean
  /** 服务域名，留空时按页面协议自动选择 */
  baseUrl: string
  /** API Key 列表，按顺序探测轮换 */
  keys: string[]
}

/**
 * 底图运行时配置
 */
export interface BasemapRuntimeConfig {
  tianditu: TianDiTuRuntimeConfig
  services: BasemapServiceConfig[]
}

/** 配置文件名（部署后与 index.html 同级） */
const CONFIG_FILE = 'config.json'

/** 内置服务默认值：矢量（vec_w + cva_w）、影像（img_w + cia_w） */
const DEFAULT_SERVICES: BasemapServiceConfig[] = [
  {
    id: 'vec',
    label: '矢量',
    enabled: true,
    url: '',
    annotationUrl: '',
    layerType: 'vec',
    annotationLayerType: 'cva',
  },
  {
    id: 'img',
    label: '影像',
    enabled: true,
    url: '',
    annotationUrl: '',
    layerType: 'img',
    annotationLayerType: 'cia',
  },
]

/**
 * 从构建期环境变量加载 key（兼容 VITE_TIANDITU_API_KEYS 和 VITE_TIANDITU_API_KEY）
 */
function loadEnvKeys(): string[] {
  const multi = import.meta.env.VITE_TIANDITU_API_KEYS as string | undefined
  const single = import.meta.env.VITE_TIANDITU_API_KEY as string | undefined
  const set = new Set<string>()
  if (multi) {
    multi.split(',').map(s => s.trim()).filter(Boolean).forEach(k => set.add(k))
  }
  if (single) {
    set.add(single.trim())
  }
  return Array.from(set)
}

function cloneDefaults(): BasemapServiceConfig[] {
  return DEFAULT_SERVICES.map(s => ({ ...s }))
}

/**
 * 默认配置：无 config.json 时的行为与改造前一致（仅用环境变量里的 key）
 */
function defaultConfig(): BasemapRuntimeConfig {
  return {
    tianditu: { enabled: true, baseUrl: '', keys: loadEnvKeys() },
    services: cloneDefaults(),
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return value === undefined || value === null ? fallback : Boolean(value)
}

/**
 * 归一化 services 配置
 * 无效条目丢弃；整段非法时回退到内置默认值，避免手误写坏配置导致底图全没了
 */
function normalizeServices(raw: unknown): BasemapServiceConfig[] {
  if (!Array.isArray(raw)) return cloneDefaults()
  const list = raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const id = asString(item.id)
      const preset = DEFAULT_SERVICES.find(s => s.id === id)
      return {
        id,
        label: asString(item.label) || preset?.label || id,
        enabled: asBoolean(item.enabled, true),
        url: asString(item.url),
        annotationUrl: asString(item.annotationUrl),
        layerType: asString(item.layerType) || preset?.layerType,
        annotationLayerType: asString(item.annotationLayerType) || preset?.annotationLayerType,
      }
    })
    .filter(s => !!s.id)
  return list.length > 0 ? list : cloneDefaults()
}

/**
 * 合并远端配置，缺字段用默认值补齐
 */
function mergeConfig(raw: Record<string, unknown>): BasemapRuntimeConfig {
  // 兼容直接把配置写在顶层的写法
  const basemap = (raw.basemap && typeof raw.basemap === 'object'
    ? raw.basemap
    : raw) as Record<string, unknown>
  const tianditu = (basemap.tianditu && typeof basemap.tianditu === 'object'
    ? basemap.tianditu
    : {}) as Record<string, unknown>

  const configKeys = Array.isArray(tianditu.keys)
    ? tianditu.keys.map(k => asString(k)).filter(Boolean)
    : []
  // config.json 的 key 优先，环境变量的 key 作为兜底
  const keys = Array.from(new Set([...configKeys, ...loadEnvKeys()]))

  return {
    tianditu: {
      enabled: asBoolean(tianditu.enabled, true),
      baseUrl: asString(tianditu.baseUrl),
      keys,
    },
    services: normalizeServices(basemap.services),
  }
}

let cachedConfig: BasemapRuntimeConfig = defaultConfig()
let loadingPromise: Promise<BasemapRuntimeConfig> | null = null
const configLoadedHandlers: Array<(config: BasemapRuntimeConfig) => void> = []

/**
 * 获取当前生效的运行时配置（同步）
 * 未加载完成时返回默认配置（环境变量 key + 内置矢量/影像）
 */
export function getBasemapRuntimeConfig(): BasemapRuntimeConfig {
  return cachedConfig
}

/**
 * 加载部署目录下的 config.json
 * 可重复调用，只真正请求一次；读取失败时静默回退默认配置
 */
export function loadBasemapRuntimeConfig(): Promise<BasemapRuntimeConfig> {
  if (loadingPromise) return loadingPromise

  const base = import.meta.env.BASE_URL || '/'
  const url = `${base.endsWith('/') ? base : `${base}/`}${CONFIG_FILE}`

  loadingPromise = (async () => {
    try {
      // 加时间戳绕开缓存，保证改完 config.json 刷新即可生效
      const resp = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-cache' })
      if (!resp.ok) {
        logger.warn(`未读取到底图配置文件 ${url}（HTTP ${resp.status}），回退到构建期配置`)
        return cachedConfig
      }
      const raw = (await resp.json()) as Record<string, unknown>
      cachedConfig = mergeConfig(raw)
      const { tianditu, services } = cachedConfig
      logger.info(
        `底图配置已加载：${services.filter(s => s.enabled).map(s => s.label).join('/') || '无可用服务'}`
        + `，key ${tianditu.keys.length} 个`,
      )
    } catch (e) {
      logger.warn(`未读取到底图配置文件 ${url}，回退到构建期配置`, e)
    }
    configLoadedHandlers.forEach(handler => handler(cachedConfig))
    return cachedConfig
  })()

  return loadingPromise
}

/**
 * 注册配置加载完成回调（供 key 轮换等模块重置内部缓存）
 */
export function onBasemapConfigLoaded(handler: (config: BasemapRuntimeConfig) => void): void {
  configLoadedHandlers.push(handler)
}

/**
 * 按 id 取服务配置
 */
export function getBasemapService(id: string): BasemapServiceConfig | undefined {
  return cachedConfig.services.find(s => s.id === id)
}

/**
 * 服务是否可用（配置存在且启用）
 */
export function isBasemapServiceEnabled(id: string): boolean {
  const service = getBasemapService(id)
  return !!service && service.enabled && cachedConfig.tianditu.enabled
}
