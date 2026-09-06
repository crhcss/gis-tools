<!--
@file GisMap slot component
@description A map slot wrapper that hosts a GisMapTianditu instance with loading state,
             visibility control, and CRS code binding. Used in the main data view.
@author yuanyu <yuanyu@supermap.com>
@date 2026-06-24
-->
<template>
  <div ref="slotRef" v-show="visible" class="map-slot">
    <gis-map-tianditu
      :map-name="mapName"
      :options="{ projection: epsgCode }"
    />
    <div v-if="loading" class="map-slot-loading">
      <el-icon class="is-loading" :size="24"><Loading /></el-icon>
      <span>地图加载中...</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Loading } from '@element-plus/icons-vue'
import type { Feature as GeoFeature } from 'geojson'
import { computed, ref, watch, onBeforeUnmount, onMounted, nextTick } from 'vue'

import GisDataInfo from '~/components/data/GisDataInfo'
import GisMapTianditu from '~/components/gismap/GisMapTianditu.vue'
import { GisMapAddFeaturesEvent, GisMapflashFeaturesEvent, GisMapStopModifyEvent } from '~/components/gismap/events/GisMapEvents'
import { eventBus } from '~/composables/eventBus'
import { buildSymbolizationStyleFunction } from '~/components/data/symbolization'
import { defaultStyle } from '~/components/gismap/styles/GisStyle'

const props = defineProps<{
  datasetId: string
  data: GisDataInfo
  visible: boolean
}>()

const slotRef = ref<HTMLElement | null>(null)

const emit = defineEmits<{
  'map-ready': []
  'enter-edit-mode': []
  'exit-edit-mode': []
}>()

// 每个地图实例有独立的 mapName（基于 datasetId）
const mapName = computed(() => `map_${props.datasetId}`)
// 规则 R2：地图 projection 直接来源于数据集 data.crs.epsgCode，深度绑定
const epsgCode = computed(() => props.data?.crs?.epsgCode)
const mapReady = ref(false)
const isInEditMode = ref(false)
const loading = ref(true)

let mapReadyHandler: (() => void) | null = null

// 监听地图就绪事件
const setupMapReadyListener = () => {
  const id = mapName.value
  mapReadyHandler = () => {
    mapReady.value = true
    loading.value = false
    renderMapFeatures()
    emit('map-ready')
  }
  eventBus.on(id, 'map-ready', mapReadyHandler)
}

// 渲染要素到地图
const renderMapFeatures = () => {
  if (isInEditMode.value) return
  if (!props.data?.features?.length) return
  if (!mapReady.value) return

  const features = props.data.features
  features.forEach((f, idx) => {
    (f as GeoFeature & { label?: number }).label = idx
  })
  // 符号化：有配置则用自定义样式函数，否则沿用默认样式（几何类型语义色）
  const styleFn = props.data.symbolization
    ? buildSymbolizationStyleFunction(props.data.symbolization)
    : defaultStyle
  eventBus.emit(mapName.value, new GisMapAddFeaturesEvent(features, { clear: true, style: styleFn }))
}

// 闪烁几何体
const flashGeometries = (geometries: Record<string, unknown>[]) => {
  if (!mapName.value) return
  const addFeaturesEvent = new GisMapflashFeaturesEvent(geometries.map(x => ({
    type: "Feature" as const,
    geometry: x as unknown as GeoJSON.Geometry,
    properties: {} as GeoJSON.GeoJsonProperties,
  } satisfies GeoJSON.Feature)))
  eventBus.emit(mapName.value, addFeaturesEvent)
}

// 停止编辑模式
const stopEditMode = () => {
  if (isInEditMode.value) {
    isInEditMode.value = false
    eventBus.emit(mapName.value, new GisMapStopModifyEvent())
    eventBus.emit(mapName.value, { event_type: 'map-event:clear-edit-shadow', options: {}, params: [] })
    renderMapFeatures()
    emit('exit-edit-mode')
  }
}

const enterEditMode = () => {
  isInEditMode.value = true
  emit('enter-edit-mode')
}

// 监听数据变化，重新渲染
watch(() => props.data, () => {
  if (mapReady.value && props.visible) {
    renderMapFeatures()
  }
}, { deep: true })

// 监听可见性变化，触发地图 resize
watch(() => props.visible, (visible) => {
  if (visible) {
    // v-show 从 hidden 到 visible 时，地图容器可能尺寸为 0
    // 延迟触发 window resize 让 OpenLayers 重新计算尺寸
    // （移除 mapReady 条件：地图初始化时容器不可见会导致尺寸 0，
    //   visible 变化时必须始终触发 resize，由 GisMapBase 内部判断是否处理）
    nextTick(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }
})

// ResizeObserver：监听容器尺寸变化（如断点切换、面板拖拽、抽屉展开），
// 确保 OpenLayers 地图始终跟随容器尺寸更新（修复移动端 ol-viewport 尺寸为 0 的问题）
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (slotRef.value) {
    resizeObserver = new ResizeObserver(() => {
      window.dispatchEvent(new Event('resize'))
    })
    resizeObserver.observe(slotRef.value)
  }
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

// 初始化
setupMapReadyListener()

onBeforeUnmount(() => {
  if (mapReadyHandler) {
    eventBus.off(mapName.value, 'map-ready', mapReadyHandler)
    mapReadyHandler = null
  }
})

defineExpose({
  mapReady,
  isInEditMode,
  mapName,
  renderMapFeatures,
  flashGeometries,
  stopEditMode,
  enterEditMode,
})
</script>

<style scoped>
.map-slot {
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
}

.map-slot-loading {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--el-bg-color);
  opacity: 0.85;
  z-index: 10;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
