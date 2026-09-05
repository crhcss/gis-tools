<!--
@file GisMap base component
@description The base map component providing the OpenLayers map container, mouse coordinate
             display, feature properties popup, and map type slot. Used as the foundation
             for GisMapBlank, GisMapSlot, and GisMapTianditu variants.
@author yuanyu <yuanyu@supermap.com>
@date 2026-04-13
-->
<template>
  <div class="main-map-container">
    <div v-if="featureProps" class="fea-props">
      <div v-for="(value,key) in featureProps" :key="key" class="row">
          <span class="key">{{ key }}</span>
          <span class="value">&nbsp;{{ `${value}` }}</span>
      </div>
    </div>
    <div v-if="mouseCoord" class="mouse-coord">{{ mouseCoord }}</div>
    <div ref="mapContainerRef" class="main-map" />
    <BasemapSwitcher
      v-if="mapReady"
      class="basemap-switcher-wrap"
      :get-view-proj-code="getViewProjCode"
      :on-switch-basemap="handleSwitchBasemap"
      :get-local-base-layers="getLocalBaseLayers"
      :initial-basemap="initialBasemapId"
    />
  </div>
</template>
<script setup lang="ts">
import Feature from 'ol/Feature';
import {applyTransform} from 'ol/extent';
import GeoJSON from 'ol/format/GeoJSON';
import LineString from 'ol/geom/LineString';
import VectorLayer from 'ol/layer/Vector';
import {toLonLat, getTransform} from 'ol/proj';
import VectorSource from 'ol/source/Vector';
import Stroke from 'ol/style/Stroke';
import Style from 'ol/style/Style';
import { computed, nextTick, onBeforeUnmount, onMounted, ref} from 'vue';

import {logger} from '~/common/logger';
import {CrsBounds} from '~/components/data/GisProjectedBounds';
import {hideEntryLoader, updateLoaderProgress} from '~/composables/entryLoader';
import {eventBus, GisEvent} from '~/composables/eventBus';
import {setMainMap} from '~/composables/gisMap';

import BasemapSwitcher from './BasemapSwitcher.vue';
import {BaseTianDiTuMap, BlankMap, GisMap, GisMapOption} from './GisMap';
import { isBasemapServiceEnabled, loadBasemapRuntimeConfig } from './basemapConfig';
import {getChinaBoundaryImage} from './data/chinaBoundaryCache';
import {Types as MapTypes} from './events/GisMapEvents';
import type {GisMapLayer} from './layer/GisLayer';
import {ImageGisMapLayer, SysGisMapLayer} from './layer/GisLayer';
import { selectAvailableTianDiTuKey } from './tiandituConfig';




const mapContainerRef = ref<HTMLElement | null>(null);
let map: GisMap;
const mouseCoord = ref<string>('');
const mapReady = ref(false);
const mapTypes = {
  blank: BlankMap,
  tianditu: BaseTianDiTuMap
}
const props = defineProps({
  mapName: { type: String, default: '' },
  options: { type: Object, default: () => ({}) },
  mapType: { type: String, default: 'blank' }
})
const featureProps = ref<Record<string, unknown>>();
const handles: Record<string, (...args: unknown[]) => unknown> = {
  [MapTypes.DRAWTOOL]: async (_options: unknown, data: unknown) => map.drawTool(data as { type: 'Polygon' | 'Point' | 'LineString' | 'None'; cleanBefore?: boolean; once?: boolean; keep?: boolean; allowHole?: boolean }),
  [MapTypes.CLEANDRAW]: async () => map.cleanDraw(),
  [MapTypes.ADD_FEATURES]: async (_options: unknown, features: unknown) => map.addFeatures(features as GeoJSON.Feature[], _options as { layerName?: string; clear?: boolean; fit?: unknown; style?: unknown } | undefined),
  [MapTypes.FLY_TO]: async (_options: unknown, center: unknown, zoom?: unknown) => await map.flyTo(center as number[], zoom as number | undefined),
  [MapTypes.ZOOM_TO]: async (_options: unknown, center: unknown, zoom?: unknown) => map.zoomTo(center as number[], zoom as number | undefined),
  [MapTypes.FLASH]: async (_options: unknown, features: unknown) => map.flashFeatures(features as GeoJSON.Feature[], _options as { layerName?: string; clear?: boolean; fit?: unknown; style?: unknown } | undefined),
  [MapTypes.START_MODIFY]: async (_options: unknown, feature: unknown) => map.startModify(feature as GeoJSON.Feature, _options as { originalFeature?: GeoJSON.Feature; skipLayerSetup?: boolean } | undefined),
  [MapTypes.STOP_MODIFY]: async (_options: unknown) => map.stopModify(_options as { skipLayerCleanup?: boolean } | undefined),
  [MapTypes.UPDATE_EDIT_FEATURE]: async (_options: unknown, feature: unknown) => map.updateEditFeature(feature as GeoJSON.Feature),
  [MapTypes.SHOW_EDIT_SHADOW]: async (_options: unknown, features: unknown) => map.showEditShadow(features as GeoJSON.Feature[]),
  [MapTypes.CLEAR_EDIT_SHADOW]: async () => map.clearEditShadow(),
  [MapTypes.SET_LAYER_VISIBILITY]: async (_options: unknown, layerName: unknown, visible: unknown) => map.setLayerVisibility(layerName as string, visible as boolean),
  [MapTypes.CLEAN_LAYER]: async (_options: unknown, layerName: unknown) => map.cleanLayer(layerName as string),
  [MapTypes.REMOVE_DRAW_FEATURE]: async (_options: unknown, featureId: unknown) => map.removeDrawFeature(featureId as string),
  [MapTypes.TOGGLE_DRAW_FEATURE_VISIBLE]: async (_options: unknown, featureId: unknown, visible: unknown) => map.toggleDrawFeatureVisible(featureId as string, visible as boolean),
}

/**
 * 获取当前地图视图投影代码
 */
function getViewProjCode(): string {
  return map?.getViewProjCode?.() ?? 'EPSG:4490'
}

/**
 * 初始底图类型，传给 BasemapSwitcher 用于设置初始选中状态和降级判断
 * mapType='blank' 时默认无底图，mapType='tianditu' 时默认矢量底图
 */
const initialBasemapId = computed<'none' | 'vec'>(() => {
  // mapType='tianditu' 且配置里矢量服务启用时才默认矢量，否则无底图
  return props.mapType === 'tianditu' && isBasemapServiceEnabled('vec') ? 'vec' : 'none'
})

/**
 * 获取本地底图图层组（用于切回本地）
 * 根据当前视图投影动态生成中国轮廓 ImageGisMapLayer
 * 与初始 mapType 无关，确保"本地"始终显示中国轮廓底图
 */
function getLocalBaseLayers(): GisMapLayer[] {
  const viewProjCode = map?.getViewProjCode?.() ?? 'EPSG:4490'
  const { url, extent: geoExtent } = getChinaBoundaryImage(viewProjCode)
  return [
    new ImageGisMapLayer({
      url,
      imageExtent: geoExtent,
      imageProjection: 'EPSG:4326',
      name: '本地底图',
      zIndex: -1,
    })
  ]
}

/**
 * 切换底图
 */
function handleSwitchBasemap(layers: GisMapLayer[]): void {
  map?.setBaseLayers(layers)
}

/**
 * 坐标系 extent 标注图层（虚线半透明框，显示当前投影的标准范围，不记入选择）
 * 使用 VECTOR_MARKER 数据源
 */
let crsExtentLayer: VectorLayer | null = null;

function setupCrsExtentLayer(olMap: any): void {
  // 使用标识数据源(VECTOR_MARKER)来显示坐标系范围框
  const markerLayer = map?.getLayerByName('vector-marker') as SysGisMapLayer;
  if (markerLayer?.layer) {
    crsExtentLayer = markerLayer.layer as VectorLayer;
  }
  // 初始绘制
  updateCrsExtentBox(olMap);

  // 监听投影变化（视图属性变化）
  const view = olMap.getView();
  view.on('change:projection', () => {
    updateCrsExtentBox(olMap);
  });
}

/**
 * 更新坐标系 extent 框
 * 从 GisProjectedBounds 的 envelope 取标准范围，转换到当前视图投影绘制虚线框
 * 如果当前投影不在 CrsBounds 中，则不绘制
 */
function updateCrsExtentBox(olMap: any): void {
  if (!crsExtentLayer) return;
  const source = crsExtentLayer.getSource() as VectorSource;
  source.clear();

  const view = olMap.getView();
  const viewProj = view.getProjection();
  const viewProjCode = viewProj.getCode();

  // 从 CrsBounds 获取当前投影的标准范围（envelope 为经纬度范围）
  const crsInfo = (CrsBounds as Record<string, any>)[viewProjCode];
  if (!crsInfo || !crsInfo.envelope) {
    // 没取到就不管了
    return;
  }

  const { minLon, maxLon, envelope } = crsInfo;
  if (minLon == null || maxLon == null || !envelope) {
    return;
  }
  // 经纬度 bbox：经度用 minLon/maxLon，纬度用 ±180（用更大的范围确保高斯-克吕格分带投影下边线足够长）
  const lonLatExtent: [number, number, number, number] = [minLon, -180, maxLon, 180];

  // 将经纬度范围转换到当前视图投影坐标
  let viewCoords: number[] | null = null;
  try {
    const fromLonLat = getTransform('EPSG:4326', viewProjCode);
    viewCoords = applyTransform(lonLatExtent, fromLonLat, undefined, 8);
  } catch {
    // 转换失败就不管了
    return;
  }
  if (!viewCoords) return;

  const [minX, minY, maxX, maxY] = viewCoords;
  // 左右两条边线（不绘制整个矩形，避免大范围覆盖几何导致卡顿）
  const leftLine = new LineString([[minX, minY], [minX, maxY]]);
  const rightLine = new LineString([[maxX, minY], [maxX, maxY]]);
  const leftFeature = new Feature({ geometry: leftLine });
  const rightFeature = new Feature({ geometry: rightLine });
  leftFeature.set('_crsExtentBox', true); // 标记为坐标系范围框，不参与交互
  rightFeature.set('_crsExtentBox', true);
  // CRS extent 使用红色虚线样式，覆盖 marker layer 默认灰度样式
  const crsStyle = new Style({
    stroke: new Stroke({
      color: 'rgba(255, 70, 70, 0.9)',
      width: 1.5,
      lineDash: [6, 4],
    }),
  });
  leftFeature.setStyle(crsStyle);
  rightFeature.setStyle(crsStyle);
  source.addFeature(leftFeature);
  source.addFeature(rightFeature);
  logger.info(`CRS extent edges updated for ${viewProjCode} from envelope:`, lonLatExtent);
}
onMounted(async () => {
  await nextTick();

  if (!mapContainerRef.value) {
    logger.error('Map container ref is not available');
    return;
  }

  // 先加载运行时底图配置（config.json，部署后可直接修改），再探测可用 key，
  // 避免地图初始化时使用限额的 key
  await loadBasemapRuntimeConfig();
  await selectAvailableTianDiTuKey();

  let mapClass = BlankMap
  const mapTypeKey = (props.mapType || 'blank').toLowerCase() as keyof typeof mapTypes;
  if (props.mapType && mapTypeKey in mapTypes) {
    mapClass = mapTypes[mapTypeKey];
  }
  map = new mapClass(props.mapName || '', mapContainerRef.value, props.options as GisMapOption);
  map.on('FeatureOver', (feature?: unknown) => {
    if (feature && typeof feature === 'object' && 'getProperties' in feature) {
      const feat = feature as { getProperties: () => Record<string, unknown> };
      let fp = feat.getProperties();
      const keys = Object.keys(fp).filter(x => x !== 'geometry')
      featureProps.value = keys.reduce((p: Record<string, unknown>, c) => {
        p[c] = fp[c]
        return p
      }, {});
    } else {
      featureProps.value = undefined
    }
  })

  // mapType='blank' 时默认无底图；mapType='tianditu' 时已由 BaseTianDiTuMap 默认加载矢量
  if (props.mapType === 'blank') {
    map.setBaseLayers([])
  }

  // 鼠标位置坐标显示
  const olMap = map.getMap();
  if (olMap) {
    // 监听 window resize，更新地图尺寸
    const handleResize = () => {
      olMap.updateSize()
    }
    window.addEventListener('resize', handleResize)
    // 保存引用以便清理
    ;(map as any)._resizeHandler = handleResize
    let coordRafId = 0;
    olMap.on('pointermove', (evt: any) => {
      // RAF 节流 + 像素去重，避免拖动时每像素触发响应式更新
      if (coordRafId) cancelAnimationFrame(coordRafId);
      coordRafId = requestAnimationFrame(() => {
        const viewProj = olMap.getView().getProjection().getCode();
        const coord = evt.coordinate as number[];
        if (viewProj === 'EPSG:4326' || viewProj === 'EPSG:4490') {
          mouseCoord.value = `${coord[0].toFixed(6)}, ${coord[1].toFixed(6)}`;
        } else {
          // 投影坐标：同时显示经纬度
          const lonLat = toLonLat(coord, viewProj);
          mouseCoord.value = `${lonLat[0].toFixed(6)}, ${lonLat[1].toFixed(6)} | ${coord[0].toFixed(2)}, ${coord[1].toFixed(2)}`;
        }
      });
    });
    (olMap as unknown as { on: (type: string, cb: () => void) => void }).on('pointermoveout', () => {
      mouseCoord.value = '';
    });
  }
  setMainMap(map);
  // 通知进度：地图视图已构建
  updateLoaderProgress(80, '正在加载底图服务');
  // 通知主入口的 loading 屏：地图初始化已完成
  hideEntryLoader();
  mapReady.value = true;
  logger.info('GisMapBase initialized:', props.mapName);

  // 添加坐标系 extent 标注图层（虚线半透明框，不记入选择）
  setupCrsExtentLayer(olMap);

  const mapName = props.mapName || '';
  eventBus.on(mapName, MapTypes.DRAWTOOL, handles[MapTypes.DRAWTOOL])
  eventBus.on(mapName, MapTypes.CLEANDRAW, handles[MapTypes.CLEANDRAW])
  eventBus.on(mapName, MapTypes.ADD_FEATURES, handles[MapTypes.ADD_FEATURES])
  eventBus.on(mapName, MapTypes.FLY_TO, handles[MapTypes.FLY_TO])
  eventBus.on(mapName, MapTypes.ZOOM_TO, handles[MapTypes.ZOOM_TO])
  eventBus.on(mapName, MapTypes.FLASH, handles[MapTypes.FLASH])
  eventBus.on(mapName, MapTypes.START_MODIFY, handles[MapTypes.START_MODIFY])
  eventBus.on(mapName, MapTypes.STOP_MODIFY, handles[MapTypes.STOP_MODIFY])
  eventBus.on(mapName, MapTypes.UPDATE_EDIT_FEATURE, handles[MapTypes.UPDATE_EDIT_FEATURE])
  eventBus.on(mapName, MapTypes.SHOW_EDIT_SHADOW, handles[MapTypes.SHOW_EDIT_SHADOW])
  eventBus.on(mapName, MapTypes.CLEAR_EDIT_SHADOW, handles[MapTypes.CLEAR_EDIT_SHADOW])
  eventBus.on(mapName, MapTypes.SET_LAYER_VISIBILITY, handles[MapTypes.SET_LAYER_VISIBILITY])
  eventBus.on(mapName, MapTypes.CLEAN_LAYER, handles[MapTypes.CLEAN_LAYER])
  eventBus.on(mapName, MapTypes.REMOVE_DRAW_FEATURE, handles[MapTypes.REMOVE_DRAW_FEATURE])
  eventBus.on(mapName, MapTypes.TOGGLE_DRAW_FEATURE_VISIBLE, handles[MapTypes.TOGGLE_DRAW_FEATURE_VISIBLE])

  // 通知父组件地图已准备好，可以发送事件
  const mapReadyEvent = new GisEvent('map-ready', null);
  eventBus.emit(mapName, mapReadyEvent);
  logger.info('GisMapBase emitted map-ready event for:', mapName);
});
onBeforeUnmount(() => {
  const mapName = props.mapName || '';
  // 清理 resize 监听
  if (map && (map as any)._resizeHandler) {
    window.removeEventListener('resize', (map as any)._resizeHandler)
    delete (map as any)._resizeHandler
  }
  eventBus.off(mapName, MapTypes.DRAWTOOL, handles[MapTypes.DRAWTOOL])
  eventBus.off(mapName, MapTypes.CLEANDRAW, handles[MapTypes.CLEANDRAW])
  eventBus.off(mapName, MapTypes.ADD_FEATURES, handles[MapTypes.ADD_FEATURES])
  eventBus.off(mapName, MapTypes.FLY_TO, handles[MapTypes.FLY_TO])
  eventBus.off(mapName, MapTypes.ZOOM_TO, handles[MapTypes.ZOOM_TO])
  eventBus.off(mapName, MapTypes.FLASH, handles[MapTypes.FLASH])
  eventBus.off(mapName, MapTypes.START_MODIFY, handles[MapTypes.START_MODIFY])
  eventBus.off(mapName, MapTypes.STOP_MODIFY, handles[MapTypes.STOP_MODIFY])
  eventBus.off(mapName, MapTypes.UPDATE_EDIT_FEATURE, handles[MapTypes.UPDATE_EDIT_FEATURE])
  eventBus.off(mapName, MapTypes.SHOW_EDIT_SHADOW, handles[MapTypes.SHOW_EDIT_SHADOW])
  eventBus.off(mapName, MapTypes.CLEAR_EDIT_SHADOW, handles[MapTypes.CLEAR_EDIT_SHADOW])
  eventBus.off(mapName, MapTypes.SET_LAYER_VISIBILITY, handles[MapTypes.SET_LAYER_VISIBILITY])
  eventBus.off(mapName, MapTypes.CLEAN_LAYER, handles[MapTypes.CLEAN_LAYER])
  map?.dispose();
  setMainMap(null as any);
})
</script>

<style scoped>
.main-map-container {
  width: 100%;
  height: 100%;
  position: relative;
}
.fea-props,.main-map{
  position: absolute;
}
.fea-props {
  width: 150px;
  font-size: 12px;
  bottom: 0;
  right: 0;
  z-index: 2;
  background: var(--gis-map-props-bg);
  color: var(--gis-map-props-text);
}
.fea-props .row {
  display: flex;
  flex-direction: row;
  flex-wrap: nowrap;
  align-items: center;

}
.fea-props .row .key {
  display: inline-block;
  width: 50px;
  text-align: right;
  padding-right: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  color: var(--el-color-primary-dark-2);
  border-top: 1px solid var(--gis-map-props-border);
  border-left: 1px solid var(--gis-map-props-border);
}
.fea-props .row .value {
  display: inline-block;
  width: 100px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: middle;
  border-top: 1px solid var(--gis-map-props-border);
  border-left: 1px solid var(--gis-map-props-border);
}

.mouse-coord {
  position: absolute;
  bottom: 4px;
  left: 4px;
  z-index: 3;
  font-size: 11px;
  font-family: monospace;
  padding: 2px 6px;
  background: var(--gis-map-props-bg);
  color: var(--gis-map-props-text);
  border-radius: 3px;
  pointer-events: none;
}

.main-map {
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  filter: var(--gis-map-filter);
  transition: filter 0.3s ease;
}

.basemap-switcher-wrap {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 4;
  /* 不应用地图滤镜，避免切换器被反相 */
  filter: none;
}
</style>
