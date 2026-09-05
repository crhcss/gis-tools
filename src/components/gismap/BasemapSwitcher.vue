<script setup lang="ts">
/**
 * @file Basemap switcher component
 * @description Provides a UI for switching basemaps (vector/imagery by default).
 *              Services come from the runtime config (config.json next to index.html):
 *              a service can be disabled, renamed, or pointed at a custom tile URL.
 *              Services that need an API key are only enabled after the key probe passes;
 *              otherwise the local basemap is used as a fallback.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-06-22
 */
import { computed, onMounted, ref } from 'vue'

import { logger } from '~/common/logger'
import { getBasemapRuntimeConfig, loadBasemapRuntimeConfig, type BasemapServiceConfig } from '~/components/gismap/basemapConfig'
import { TianDiTuGisMapLayer } from '~/components/gismap/layer/GisLayer'
import type { GisMapLayer } from '~/components/gismap/layer/GisLayer'
import {
  buildTianDiTuLayerUrl,
  checkTianDiTuAvailability,
  getTianDiTuProjSuffix,
} from '~/components/gismap/tiandituConfig'

/**
 * 底图类型
 * - none: 无底图
 * - local: 本地底图（保留当前底图）
 * - 其余为 config.json 中配置的服务 id（内置 vec=矢量 / img=影像）
 */
type BasemapId = 'none' | 'local' | string

interface BasemapOption {
  id: BasemapId
  label: string
  available: boolean
  /** 不可用时 tooltip 的补充说明 */
  reason?: string
}

const props = defineProps<{
  /** 获取当前地图视图投影代码 */
  getViewProjCode: () => string
  /** 切换底图图层组 */
  onSwitchBasemap: (layers: GisMapLayer[]) => void
  /** 获取当前本地底图图层组（用于切回本地） */
  getLocalBaseLayers: () => GisMapLayer[]
  /** 初始底图类型，用于设置初始选中状态和降级判断 */
  initialBasemap?: string
}>()

const currentBasemap = ref<BasemapId>(props.initialBasemap ?? 'none')
const tianDiTuAvailable = ref(false)
const checking = ref(false)
/** config.json 中启用后的底图服务（矢量/影像等） */
const services = ref<BasemapServiceConfig[]>([])

/**
 * 服务是否依赖天地图 API Key
 * url / annotationUrl 留空 → 走天地图默认服务，需要 key；模板里带 {key} → 也需要 key
 */
function requiresKey(service: BasemapServiceConfig): boolean {
  return !service.url
    || !service.annotationUrl
    || service.url.includes('{key}')
    || service.annotationUrl.includes('{key}')
}

const basemapOptions = computed<BasemapOption[]>(() => [
  ...services.value.map<BasemapOption>(service => {
    const available = requiresKey(service) ? tianDiTuAvailable.value : true
    return {
      id: service.id,
      label: service.label,
      available,
      reason: available ? undefined : '未配置可用的 API Key',
    }
  }),
  {
    id: 'local',
    label: '本地',
    available: true,
  },
  {
    id: 'none',
    label: '无',
    available: true,
  },
])

/**
 * 解析服务的最终瓦片 URL：优先用 config.json 配的模板，否则拼天地图默认服务
 */
function resolveServiceUrl(service: BasemapServiceConfig, annotation: boolean): string {
  const configured = annotation ? service.annotationUrl : service.url
  if (configured) return configured
  const layerType = annotation ? service.annotationLayerType : service.layerType
  return buildTianDiTuLayerUrl(layerType || 'vec', getTianDiTuProjSuffix(props.getViewProjCode()))
}

/**
 * 构建底图图层组（底图 + 注记）
 */
function buildServiceLayers(service: BasemapServiceConfig): GisMapLayer[] {
  return [
    new TianDiTuGisMapLayer({ url: resolveServiceUrl(service, false), name: `${service.label}底图`, zIndex: -1 }),
    new TianDiTuGisMapLayer({ url: resolveServiceUrl(service, true), name: `${service.label}注记`, zIndex: -1 }),
  ]
}

/**
 * 切换底图
 */
function handleSwitch(id: BasemapId): void {
  const option = basemapOptions.value.find(o => o.id === id)
  if (!option || !option.available) {
    logger.warn(`底图 ${id} 不可用`)
    return
  }

  let layers: GisMapLayer[]
  if (id === 'none') {
    layers = []
  } else if (id === 'local') {
    layers = props.getLocalBaseLayers()
  } else {
    const service = services.value.find(s => s.id === id)
    if (!service) {
      logger.warn(`未找到底图服务配置: ${id}`)
      return
    }
    layers = buildServiceLayers(service)
  }

  props.onSwitchBasemap(layers)
  currentBasemap.value = id
  logger.info(`底图已切换至: ${option.label}`)
}

/**
 * 检测底图服务可达性
 * 只有依赖 key 的服务才需要探测；内部已自动探测并轮换 key（多个 key 时选第一个可用的）
 */
async function checkAvailability(): Promise<void> {
  const needProbe = services.value.some(requiresKey)
  if (!needProbe) {
    tianDiTuAvailable.value = true
    return
  }
  checking.value = true
  try {
    tianDiTuAvailable.value = await checkTianDiTuAvailability()
  } finally {
    checking.value = false
  }
  // 如果服务不可用且当前选中的是该服务，切回本地底图
  const current = basemapOptions.value.find(o => o.id === currentBasemap.value)
  if (current && !current.available) {
    handleSwitch('local')
  }
}

onMounted(async () => {
  await loadBasemapRuntimeConfig()
  services.value = getBasemapRuntimeConfig().services.filter(s => s.enabled)
  await checkAvailability()
})
</script>

<template>
  <div class="gismap-btns-wrap">
    <div class="basemap-switcher gismap-btns">
      <button
        v-for="option in basemapOptions"
        :key="option.id"
        type="button"
        class="gismap-btn"
        :class="{
          active: currentBasemap === option.id,
          disabled: !option.available,
        }"
        :title="option.available ? option.label : `${option.label}（${option.reason || '不可用'}）`"
        :disabled="!option.available"
        @click="handleSwitch(option.id)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 使用全局 .gismap-btns / .gismap-btn 样式 */
</style>
