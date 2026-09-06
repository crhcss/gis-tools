<script setup lang="ts">
/**
 * @file Feature tree component
 * @description Displays a tree-structured view of features by geometry type with
 *              selection, locate, and delete operations.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-06-24
 */
import { Edit, EditPen, Delete, Plus } from '@element-plus/icons-vue'
import {ElMessage, ElMessageBox} from "element-plus";
import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
  Ref,
  watch
} from "vue";

import GeomUtils from "~/common/GeomUtils";
import {logger} from "~/common/logger";
import GisDataInfo from "~/components/data/GisDataInfo";
import GisFeatureEditor from "~/components/data/GisFeatureEditor.vue";
import {
  GisMapflashFeaturesEvent,
  GisMapStopModifyEvent,
  GisMapDrawEvent,
  GisMapCleanDrawEvent
} from "~/components/gismap/events/GisMapEvents";
import GeoTypeIconRender from "~/components/renders/GeoTypeIconRender.vue";
import {eventBus} from "~/composables/eventBus";
import {useGisDataStore} from "~/composables/gisDataStore";
import GisSymbolizationDialog from "~/components/data/GisSymbolizationDialog.vue";
import type {SymbolizationConfig} from "~/components/data/symbolization";

const props = defineProps({
  data: {
    type: Object as () => GisDataInfo,
    default: () => new GisDataInfo()
  },
  instanceId: {
    type: [Number, String],
    default: 0
  },
  mapReady: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits<{
  'enter-edit-mode': []
  'exit-edit-mode': []
}>()

const { updateDataset, activeId } = useGisDataStore()

const treeHeight = ref(0)
const conpomentVisiblity = ref(false)
const featureEditorRef = ref<InstanceType<typeof GisFeatureEditor> | null>(null)
const activeView = ref<'tree' | 'editor' | 'add'>('tree')

// === 节点显示字段选择 ===
const displayField = ref<string>('')  // 空字符串表示使用默认名称
const availableFields = computed<string[]>(() => {
  const fieldSet = new Set<string>()
  const features = props.data?.features || []
  for (const f of features) {
    if (f?.properties) {
      for (const key of Object.keys(f.properties)) {
        fieldSet.add(key)
      }
    }
  }
  return Array.from(fieldSet)
})

// 减去 view-switcher(40) + tree-options 区域(~48)
const TREE_OFFSET = 88
const sizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const newHeight = entry.contentRect.height - TREE_OFFSET
    treeHeight.value = Math.max(0, newHeight)
    conpomentVisiblity.value = newHeight > 0
  }
})

onMounted(() => {
  const currentInstance = getCurrentInstance()
  if (currentInstance?.vnode.el) {
    treeHeight.value = currentInstance.vnode.el.clientHeight - TREE_OFFSET
    sizeObserver.observe(currentInstance.vnode.el as Element)
  }
})

onBeforeUnmount(() => {
  sizeObserver.disconnect()
  cleanupAddDrawHandler()
})

// === 类型工具 ===
const isPrimitive = (data: unknown): boolean => {
  const _type = Object.prototype.toString.call(data)
  const _primitives = ["[object String]", "[object Number]", "[object Boolean]", "[object Null]", "[object Undefined]"]
  return _primitives.includes(_type)
}
const getTypeName = (data: unknown): string => {
  const _typeStr = Object.prototype.toString.call(data)
  return _typeStr.slice(8, -1).toLowerCase()
}

const label2TagType = (node: GeoInfoNode): 'primary' | 'success' | 'warning' | 'info' | 'danger' => {
  const t = String(node.label2 ?? '')
  if (t.includes('岛屿') || t.includes('含岛')) return 'success'
  if (t.includes('外部环')) return 'primary'
  if (t.includes('内部环') || t.includes('内环')) return 'warning'
  if (t.includes('外环')) return 'primary'
  if (t.includes('项') || t.includes('面数') || t.includes('个数')) return 'info'
  if (t.includes('无几何')) return 'info'
  return 'info'
}

const INDEX_RE = /\s*#(\d+)\s*$/
const splitLabel = (label: string): { name: string; index?: string } => {
  const m = label.match(INDEX_RE)
  if (!m) return { name: label }
  return { name: label.slice(0, m.index).trimEnd(), index: `#${m[1]}` }
}

// === 节点类 ===
class GeoInfoNode {
  label: string
  label2?: string
  geoType?: string
  geoData?: unknown
  typeName?: string
  children: GeoInfoNode[]
  value?: unknown
  id?: string
  disabled: boolean = false
  geometry?: Record<string, unknown>
  sourceFeature?: GeoJSON.Feature

  constructor(_label: string, _children?: GeoInfoNode[], _geoType?: string, _geoData?: unknown) {
    this.label = _label
    this.children = []
    this.id = Math.random().toString(36).slice(2)
    this.geoType = _geoType
    this.geoData = _geoData
    if (_children) {
      this.children.push(..._children)
    }
  }
}

const inspector: Record<string, (coordinates: unknown[], idx?: number) => GeoInfoNode> = {
  "Point": (coordinates: unknown[], idx?: number): GeoInfoNode => {
    const coords = coordinates as number[]
    const xNode = new GeoInfoNode(`经度`)
    xNode.value = coords[0]
    xNode.typeName = getTypeName(coords[0])
    const yNode = new GeoInfoNode(`纬度`)
    yNode.value = coords[1]
    yNode.typeName = getTypeName(coords[1])
    const pNode = new GeoInfoNode(
      idx !== undefined ? `顶点 #${idx}` : "顶点",
      [],
      'Point',
      coordinates,
    )
    pNode.label2 = idx !== undefined ? `#${idx}` : undefined
    pNode.geometry = { type: "Point", coordinates: coordinates }
    return pNode
  },
  "LineString": (coordinates: unknown[], idx?: number): GeoInfoNode => {
    const geoInfoNode = new GeoInfoNode(
      idx !== undefined ? `折线 #${idx}` : "折线",
      (coordinates as unknown[]).map((c: unknown, i: number) => inspector.Point(c as unknown[], i)),
      'LineString',
      coordinates,
    )
    geoInfoNode.label2 = `${(coordinates as unknown[]).length} 节点`
    geoInfoNode.geometry = { type: "LineString", coordinates: coordinates }
    return geoInfoNode
  },
  "Polygon": (coordinates: unknown[], idx?: number): GeoInfoNode => {
    const geoInfoNodes = []
    const rings = coordinates as unknown[][]
    for (let i = 0; i < rings.length; i++) {
      const isOuter = i === 0
      const node = new GeoInfoNode(
        `${isOuter ? "外环" : "内环"} #${i}`,
        rings[i].map((c: unknown, j: number) => inspector.Point(c as unknown[], j)),
      )
      node.label2 = `${rings[i].length} 顶点`
      node.geometry = { type: "LineString", coordinates: rings[i] as unknown[] }
      geoInfoNodes.push(node)
    }
    const pNode = new GeoInfoNode(
      idx !== undefined
        ? (rings.length > 1 ? `多边形 · 含岛屿 #${idx}` : `多边形 #${idx}`)
        : (rings.length > 1 ? "多边形 · 含岛屿" : "多边形"),
      geoInfoNodes,
      'Polygon',
      coordinates,
    )
    pNode.label2 = `${rings.length} 环 · ${rings.reduce((acc, r) => acc + (r as unknown[]).length, 0)} 顶点`
    pNode.geometry = { type: "Polygon", coordinates: coordinates }
    return pNode
  },
  "MultiPoint": (coordinates: unknown[], idx?: number): GeoInfoNode => {
    const geoInfoNode = new GeoInfoNode(
      idx !== undefined ? `多点集 #${idx}` : "多点集",
      (coordinates as unknown[]).map((c: unknown, i: number) => inspector.Point(c as unknown[], i)),
      'MultiPoint',
      coordinates,
    )
    geoInfoNode.label2 = `${(coordinates as unknown[]).length} 个点`
    geoInfoNode.geometry = { type: "MultiPoint", coordinates: coordinates }
    return geoInfoNode
  },
  "MultiLineString": (coordinates: unknown[], idx?: number): GeoInfoNode => {
    const geoInfoNode = new GeoInfoNode(
      idx !== undefined ? `多线集 #${idx}` : "多线集",
      (coordinates as unknown[]).map((c: unknown, i: number) => inspector.LineString(c as unknown[], i)),
      'MultiLineString',
      coordinates,
    )
    geoInfoNode.label2 = `${(coordinates as unknown[]).length} 条折线`
    geoInfoNode.geometry = { type: "MultiLineString", coordinates: coordinates }
    return geoInfoNode
  },
  "MultiPolygon": (coordinates: unknown[], idx?: number): GeoInfoNode => {
    const geoInfoNode = new GeoInfoNode(
      idx !== undefined ? `多面集 #${idx}` : "多面集",
      (coordinates as unknown[]).map((c: unknown, i: number) => inspector.Polygon(c as unknown[], i)),
      'MultiPolygon',
      coordinates,
    )
    geoInfoNode.label2 = `${coordinates.length} 个多边形`
    geoInfoNode.geometry = { type: "MultiPolygon", coordinates: coordinates }
    return geoInfoNode
  }
}

const inspectFeature = (feature: GeoJSON.Feature, _idx: number = 0, field: string = ''): GeoInfoNode => {
  // 根据显示字段生成节点名称：字段值优先，无字段或值为空时使用"要素"
  let baseName = `要素`
  if (field && feature.properties) {
    const val = (feature.properties as Record<string, unknown>)[field]
    if (val !== undefined && val !== null && val !== '') {
      baseName = String(val)
    }
  }
  const featureLabel = `${baseName} #${_idx}`

  if (!feature.geometry) {
    const nullNode = new GeoInfoNode("空几何")
    const node = new GeoInfoNode(featureLabel, [nullNode])
    node.label2 = "无几何"
    return node
  }

  const geoType: string = feature.geometry.type
  let handleFun = inspector[geoType]
  if (!handleFun) {
    handleFun = () => new GeoInfoNode("未知几何类型:" + geoType)
  }
  const geoInfoNode = handleFun((feature.geometry as GeoJSON.Geometry & { coordinates: unknown[] }).coordinates as unknown[], _idx)

  const properties = feature.properties
  const propertyInfoNode = new GeoInfoNode("属性")
  propertyInfoNode.disabled = true
  if (properties) {
    for (const key in properties) {
      const val = properties[key]
      const node = new GeoInfoNode(key)
      node.value = val
      node.typeName = getTypeName(val)
      if (node.typeName === "string") {
        node.value = `"${node.value}"`
      } else if (!isPrimitive(val)) {
        node.value = `[${node.typeName}]`
      }
      propertyInfoNode.children.push(node)
      propertyInfoNode.disabled = false
    }
  }

  const geoTypeName = GeomUtils.getTypeName(geoType)
  const node = new GeoInfoNode(featureLabel, [geoInfoNode, propertyInfoNode])
  node.label2 = geoTypeName
  node.geometry = feature.geometry as unknown as Record<string, unknown>
  node.sourceFeature = feature
  return node
}

const geoJsonTreeData2: Ref<GeoInfoNode[] | undefined> = ref(undefined)

const buildGeoJsonTree = () => {
  if (props.data?.features?.length) {
    const field = displayField.value
    const children = props.data.features
      .map((f, _idx) => inspectFeature(f, _idx, field))
      .filter((node): node is GeoInfoNode => node !== undefined)
    const geoInfoNode = new GeoInfoNode("几何要素", children)
    geoInfoNode.id = 'root'
    geoInfoNode.label2 = `${props.data.features.length} 项`
    geoInfoNode.geometry = {
      type: "GeometryCollection",
      geometries: props.data.features.filter(f => f.geometry).map(x => x.geometry)
    }
    geoJsonTreeData2.value = [geoInfoNode]
  } else {
    geoJsonTreeData2.value = undefined
  }
}

watch(() => props.data, () => {
  buildGeoJsonTree()
}, { deep: true, immediate: true })

// 显示字段变化时重新构建树
watch(displayField, () => {
  buildGeoJsonTree()
})

// === 节点交互 ===
const selectedNodeId = ref<string | null>(null)
const selectedNodeData = ref<GeoInfoNode | null>(null)

const getOriginalJson = (node: GeoInfoNode | null): string => {
  if (!node) return ''
  if (node.sourceFeature) return JSON.stringify(node.sourceFeature, null, 2)
  if (node.geometry) return JSON.stringify(node.geometry, null, 2)
  if (node.value !== undefined) return JSON.stringify(node.value, null, 2)
  return ''
}

const editedJson = ref('')
const isDirty = ref(false)
const editingNode = ref<GeoInfoNode | null>(null)
const editorDialogVisible = ref(false)

const handleEditDialogOpen = (node: GeoInfoNode) => {
  editingNode.value = node
  editedJson.value = getOriginalJson(node)
  isDirty.value = false
  editorDialogVisible.value = true
}

const handleEditDialogClose = () => {
  if (isDirty.value) {
    ElMessageBox.confirm('当前修改尚未保存，确定关闭吗？', '放弃修改', {
      type: 'warning',
      confirmButtonText: '放弃并关闭',
      cancelButtonText: '继续编辑',
    })
      .then(() => {
        editorDialogVisible.value = false
        if (editingNode.value) {
          editedJson.value = getOriginalJson(editingNode.value)
        }
        isDirty.value = false
        editingNode.value = null
      })
      .catch(() => {})
    return
  }
  editorDialogVisible.value = false
  editingNode.value = null
}

const handleEditorInput = (val: string) => {
  editedJson.value = val
  isDirty.value = val !== getOriginalJson(editingNode.value)
}

const handleJsonUpdate = () => {
  const node = editingNode.value
  if (!node) return
  try {
    const parsed = JSON.parse(editedJson.value)
    if (node.sourceFeature && parsed.type === 'Feature') {
      if (parsed.geometry) {
        node.sourceFeature.geometry = parsed.geometry
        node.geometry = parsed.geometry as Record<string, unknown>
      }
      if (parsed.properties) {
        node.sourceFeature.properties = parsed.properties
      }
      const idx = props.data.features.indexOf(node.sourceFeature)
      if (idx >= 0) {
        const newFeature = { ...node.sourceFeature } as GeoJSON.Feature
        // eslint-disable-next-line vue/no-mutating-props
        props.data.features[idx] = newFeature
        node.sourceFeature = newFeature
      }
    } else if (node.geometry) {
      node.geometry = parsed as Record<string, unknown>
      if (node.sourceFeature) {
        node.sourceFeature.geometry = parsed as GeoJSON.Geometry
      }
    }
    isDirty.value = false
    ElMessage.success('更新成功')
  } catch (e: unknown) {
    ElMessage.error('JSON 格式错误，无法更新')
  }
}

const handleJsonCancel = () => {
  if (editingNode.value) {
    editedJson.value = getOriginalJson(editingNode.value)
  }
  isDirty.value = false
}

const flashGeometries = (geometries: Record<string, unknown>[]) => {
  if (!props.instanceId) return
  const addFeaturesEvent = new GisMapflashFeaturesEvent(geometries.map(x => {
    return {
      type: "Feature" as const,
      geometry: x as unknown as GeoJSON.Geometry,
      properties: {} as GeoJSON.GeoJsonProperties,
    } satisfies GeoJSON.Feature
  }))
  eventBus.emit(`${props.instanceId}`, addFeaturesEvent)
}

const handleTreeNodeClick = (data: GeoInfoNode) => {
  selectedNodeId.value = data.id ?? null
  selectedNodeData.value = data
  editedJson.value = getOriginalJson(data)
  isDirty.value = false
  if (data.geometry) {
    flashGeometries([data.geometry])
  }
}

// === 要素编辑器 ===
const isInEditMode = ref(false)

const handleViewChange = (view: 'tree' | 'editor' | 'add') => {
  // 离开旧视图的清理
  if (activeView.value === 'editor' && view !== 'editor') {
    isInEditMode.value = false
    emit('exit-edit-mode')
    if (props.instanceId) {
      eventBus.emit(`${props.instanceId}`, new GisMapStopModifyEvent())
      eventBus.emit(`${props.instanceId}`, { event_type: 'map-event:clear-edit-shadow', options: {}, params: [] })
    }
  }
  if (activeView.value === 'add' && view !== 'add') {
    // 离开新增要素视图：取消绘制 + 清理
    cleanupAddDrawHandler()
    if (props.instanceId) {
      eventBus.emit(`${props.instanceId}`, new GisMapCleanDrawEvent())
    }
    resetAddFeatureState()
  }

  activeView.value = view
  if (view === 'editor') {
    isInEditMode.value = true
    emit('enter-edit-mode')
    featureEditorRef.value?.activate()
  } else if (view === 'add') {
    // 进入新增要素视图：初始化属性结构
    initAddFeatureProperties()
  }
}

// === 新增要素 ===
type DrawType = 'Point' | 'LineString' | 'Polygon' | 'None'
const addDrawType = ref<DrawType>('None')
const addFeatureProperties = ref<Record<string, unknown>>({})
const addFeatureGeometry = ref<GeoJSON.Geometry | null>(null)
let addDrawHandler: ((_opt: unknown, _data: unknown) => void) | null = null

/** 基于原数据集属性结构初始化空属性（取所有 features 属性 key 的并集，值为空字符串） */
function initAddFeatureProperties() {
  const propsMap: Record<string, unknown> = {}
  const features = props.data?.features || []
  for (const f of features) {
    if (f?.properties) {
      for (const [key, val] of Object.entries(f.properties)) {
        if (!(key in propsMap)) {
          // 根据原值类型推断默认空值
          const t = typeof val
          if (t === 'number') propsMap[key] = 0
          else if (t === 'boolean') propsMap[key] = false
          else propsMap[key] = ''
        }
      }
    }
  }
  addFeatureProperties.value = propsMap
  addFeatureGeometry.value = null
  addDrawType.value = 'None'
}

function resetAddFeatureState() {
  addDrawType.value = 'None'
  addFeatureGeometry.value = null
  addFeatureProperties.value = {}
  cleanupAddDrawHandler()
}

/** 清理绘制完成事件 handler */
function cleanupAddDrawHandler() {
  if (addDrawHandler && props.instanceId) {
    eventBus.off(`${props.instanceId}`, 'map-event:draw-end', addDrawHandler)
    addDrawHandler = null
  }
}

/** 触发绘制：点/线/面 */
function handleDrawForAdd(type: DrawType) {
  if (!props.instanceId) return
  cleanupAddDrawHandler()
  // 清除上一次绘制残留，避免 display 图层累积
  eventBus.emit(`${props.instanceId}`, new GisMapCleanDrawEvent())
  addDrawType.value = type
  addFeatureGeometry.value = null
  // keep=true 让绘制图形保留在 display 图层，用户可见
  eventBus.emit(`${props.instanceId}`, new GisMapDrawEvent({
    type,
    cleanBefore: true,
    once: true,
    keep: true
  }))
  const handler = (_opt: unknown, data: unknown) => {
    try {
      const feature = JSON.parse(data as string) as GeoJSON.Feature
      if (feature.geometry) {
        addFeatureGeometry.value = feature.geometry
      }
    } catch (e) {
      logger.error('[FeatureTree] parse draw-end feature failed:', e)
    }
    cleanupAddDrawHandler()
  }
  addDrawHandler = handler
  eventBus.on(`${props.instanceId}`, 'map-event:draw-end', handler)
}

/** 清除已绘制图形 */
function handleCleanDraw() {
  if (!props.instanceId) return
  cleanupAddDrawHandler()
  addFeatureGeometry.value = null
  addDrawType.value = 'None'
  eventBus.emit(`${props.instanceId}`, new GisMapCleanDrawEvent())
}

/** 提交新要素到数据集 */
function handleAddFeature() {
  if (!addFeatureGeometry.value) {
    ElMessage.warning('请先绘制几何图形')
    return
  }
  const newFeature: GeoJSON.Feature = {
    type: 'Feature',
    geometry: addFeatureGeometry.value,
    properties: { ...addFeatureProperties.value }
  }
  // eslint-disable-next-line vue/no-mutating-props
  props.data.features.push(newFeature)
  if (activeId.value) {
    updateDataset(activeId.value, props.data)
  }
  buildGeoJsonTree()
  ElMessage.success('已新增要素')
  // 重置状态，保留属性结构供连续新增
  addFeatureGeometry.value = null
  addDrawType.value = 'None'
  cleanupAddDrawHandler()
  if (props.instanceId) {
    eventBus.emit(`${props.instanceId}`, new GisMapCleanDrawEvent())
  }
}

/** 取消新增要素，返回结构树 */
function handleCancelAdd() {
  handleViewChange('tree')
}

const addPropEntries = computed(() => Object.entries(addFeatureProperties.value))

const handleEditorExit = () => {
  isInEditMode.value = false
  activeView.value = 'tree'
  emit('exit-edit-mode')
}

const handleEditorModifyChange = (_feature: GeoJSON.Feature) => {
  logger.info('[FeatureTree] Feature modified in editor')
}

const handleEditorDataChanged = () => {
  buildGeoJsonTree()
}

const handleShowShadow = () => {
  const hasEditsVal = featureEditorRef.value?.hasEdits ?? false
  const workingFeatures = featureEditorRef.value?.workingFeatures ?? []
  if (hasEditsVal && props.instanceId) {
    eventBus.emit(`${props.instanceId}`, {
      event_type: 'map-event:show-edit-shadow',
      options: {},
      params: [JSON.parse(JSON.stringify(workingFeatures))],
    })
  }
}

const handleClearShadow = () => {
  if (props.instanceId) {
    eventBus.emit(`${props.instanceId}`, { event_type: 'map-event:clear-edit-shadow', options: {}, params: [] })
  }
}

// === 根节点右键菜单：符号化设置 ===
const contextMenu = ref<{ visible: boolean; x: number; y: number }>({ visible: false, x: 0, y: 0 })
const symDialogVisible = ref(false)
const symDialogMode = ref<'single' | 'categorized'>('single')

/** 仅根节点（结构树根）响应右键菜单 */
const onNodeContextMenu = (evt: Event, data: GeoInfoNode) => {
  const e = evt as MouseEvent
  if (data?.id !== 'root') return
  e.preventDefault()
  contextMenu.value = { visible: true, x: e.clientX, y: e.clientY }
}

const openSymbolization = (mode: 'single' | 'categorized') => {
  symDialogMode.value = mode
  symDialogVisible.value = true
  contextMenu.value.visible = false
}

const clearSymbolization = () => {
  contextMenu.value.visible = false
  // eslint-disable-next-line vue/no-mutating-props
  props.data.symbolization = null
  if (activeId.value) {
    updateDataset(activeId.value, props.data)
  }
  ElMessage.success('已清除符号化')
}

const saveSymbolization = (config: SymbolizationConfig) => {
  // eslint-disable-next-line vue/no-mutating-props
  props.data.symbolization = config
  if (activeId.value) {
    updateDataset(activeId.value, props.data)
  }
  ElMessage.success('符号化已应用')
}
</script>

<template>
  <div class="gis-feature-tree-container">
    <!-- 视图切换 -->
    <div class="view-switcher">
      <el-segmented v-model="activeView" :options="[
        { value: 'tree', label: '结构树' },
        { value: 'editor', label: '要素编辑' },
        { value: 'add', label: '新增要素' }
      ]" size="small" @change="(val: string | number) => handleViewChange(val as 'tree' | 'editor' | 'add')"
/>
    </div>

    <!-- 结构树视图 -->
    <div v-show="activeView === 'tree'" class="tree-view">
      <!-- 节点显示字段选择区域 -->
      <div class="tree-options">
        <span class="option-label">显示字段</span>
        <el-select
          v-model="displayField"
          size="small"
          placeholder="默认（要素 #下标）"
          clearable
          class="field-select"
        >
          <el-option label="默认（要素 #下标）" value="" />
          <el-option
            v-for="field in availableFields"
            :key="field"
            :label="field"
            :value="field"
          />
        </el-select>
      </div>
      <el-tree-v2
        ref="theTree"
        :height="treeHeight"
        :default-expanded-keys="['root']"
        :data="geoJsonTreeData2"
        :props="{ label: 'label', children: 'children' }"
        :highlight-current="true"
        :check-on-click-node="true"
        :expand-on-click-node="false"
        node-key="id"
        @node-click="handleTreeNodeClick"
        @node-contextmenu="onNodeContextMenu"
      >
        <template #default="{ data: nodeData }">
          <span v-if="nodeData" :class="`custom-tree-node ${nodeData.disabled?'disabled':''}`">
            <GeoTypeIconRender v-if="nodeData.geoType" :type="nodeData.geoType" :size="13" />
            <span class="key">{{ splitLabel(nodeData.label).name }}</span>
            <span v-if="splitLabel(nodeData.label).index" class="node-index">{{ splitLabel(nodeData.label).index }}</span>
            <el-tag v-if="nodeData.label2" size="small" :type="label2TagType(nodeData)" effect="plain" round class="label2">
              {{ nodeData.label2 }}
            </el-tag>
            <el-tag v-if="nodeData.id === 'root' && data.symbolization" size="small" type="warning" effect="plain" round class="label2">
              符号化
            </el-tag>
            <span v-if="nodeData.value !== undefined" :class="`val-${ nodeData.typeName}`">{{ nodeData.value }}</span>
            <el-icon v-if="nodeData.geometry || nodeData.sourceFeature" class="node-btn node-btn-edit" title="编辑JSON" @click.stop="handleEditDialogOpen(nodeData)"><Edit /></el-icon>
          </span>
        </template>
      </el-tree-v2>
    </div>

    <!-- 新增要素视图 -->
    <div v-show="activeView === 'add'" class="add-view">
      <div class="add-header">
        <span class="header-title">新增要素</span>
        <el-tag v-if="addFeatureGeometry" size="small" type="success" effect="plain">已绘制</el-tag>
        <el-tag v-else size="small" type="info" effect="plain">未绘制</el-tag>
      </div>
      <div class="add-toolbar">
        <span class="toolbar-label">绘制：</span>
        <el-button text size="small" :type="addDrawType === 'Point' ? 'primary' : ''" title="绘制点" @click="handleDrawForAdd('Point')">
          <el-icon><EditPen /></el-icon> 点
        </el-button>
        <el-button text size="small" :type="addDrawType === 'LineString' ? 'primary' : ''" title="绘制线" @click="handleDrawForAdd('LineString')">
          <el-icon><EditPen /></el-icon> 线
        </el-button>
        <el-button text size="small" :type="addDrawType === 'Polygon' ? 'primary' : ''" title="绘制面" @click="handleDrawForAdd('Polygon')">
          <el-icon><EditPen /></el-icon> 面
        </el-button>
        <el-button text size="small" type="danger" title="清除" @click="handleCleanDraw">
          <el-icon><Delete /></el-icon> 清除
        </el-button>
      </div>
      <div class="add-section-label">属性填写</div>
      <div class="add-props">
        <div v-for="([key], pi) in addPropEntries" :key="pi" class="prop-row">
          <span class="prop-key">{{ key }}</span>
          <el-input v-model="addFeatureProperties[key as string]" size="small" />
        </div>
        <div v-if="addPropEntries.length === 0" class="empty-props">无属性（数据集为空）</div>
      </div>
      <div class="add-footer">
        <el-button size="small" @click="handleCancelAdd">取消</el-button>
        <el-button type="primary" size="small" :disabled="!addFeatureGeometry" @click="handleAddFeature">
          <el-icon><Plus /></el-icon> 新增
        </el-button>
      </div>
    </div>

    <!-- 要素编辑器视图 -->
    <div v-show="activeView === 'editor'" class="editor-view">
      <gis-feature-editor
        ref="featureEditorRef"
        :data="data"
        :instance-id="instanceId"
        :display-field="displayField"
        @exit="handleEditorExit"
        @modify-change="handleEditorModifyChange"
        @data-changed="handleEditorDataChanged"
        @show-shadow="handleShowShadow"
        @clear-shadow="handleClearShadow"
      />
    </div>

    <!-- 节点 JSON 编辑弹窗 -->
    <el-dialog
      v-model="editorDialogVisible"
      title="编辑节点 JSON"
      width="60%"
      :close-on-click-modal="false"
      class="node-edit-dialog"
      align-center
      top="8vh"
      @close="handleEditDialogClose"
    >
      <div class="json-editor-container dialog-editor">
        <geo-str-editor
          :value="editedJson"
          :read-only="false"
          :minimap="false"
          language="geojson"
          class="json-editor-main"
          @input="handleEditorInput"
        />
      </div>
      <template #footer>
        <div class="json-editor-footer">
          <span class="dirty-tip" :class="{ visible: isDirty }">未保存的修改</span>
          <el-button size="small" :disabled="!isDirty" @click="handleJsonCancel">还原</el-button>
          <el-button type="primary" size="small" :disabled="!isDirty" @click="handleJsonUpdate">更新</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 根节点右键菜单：符号化设置 -->
    <teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="ctx-overlay"
        @click="contextMenu.visible = false"
        @contextmenu.prevent="contextMenu.visible = false"
      />
      <div
        v-if="contextMenu.visible"
        class="ctx-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      >
        <div class="ctx-item has-sub" @click.stop>
          <span>符号化设置</span>
          <span class="ctx-arrow">›</span>
          <div class="ctx-submenu">
            <div class="ctx-item" @click="openSymbolization('single')">单一符号化</div>
            <div class="ctx-item" @click="openSymbolization('categorized')">分类符号化</div>
          </div>
        </div>
        <div v-if="props.data.symbolization" class="ctx-item ctx-danger" @click="clearSymbolization">清除符号化</div>
      </div>
    </teleport>

    <!-- 符号化设置对话框 -->
    <gis-symbolization-dialog
      v-model="symDialogVisible"
      :mode="symDialogMode"
      :data="data"
      :config="data.symbolization || null"
      @apply="saveSymbolization"
    />
  </div>
</template>

<style scoped>
.gis-feature-tree-container {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  box-sizing: border-box;
}

.view-switcher {
  padding: 6px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.tree-view {
  flex: 1;
  overflow: hidden;
  padding: 4px 12px 4px 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}

.editor-view {
  flex: 1;
  overflow: hidden;
  padding: 4px;
  box-sizing: border-box;
}

/* 节点显示字段选择区域 */
.tree-options {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 8px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--el-border-color-extra-light);
  margin-bottom: 4px;
}

.tree-options .option-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
  white-space: nowrap;
}

.tree-options .field-select {
  flex: 1;
  min-width: 0;
}

/* 节点 #下标 样式 */
.node-index {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  font-family: monospace;
}

.custom-tree-node {
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding-right: 4px;
}

.custom-tree-node .key {
  color: var(--el-text-color-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.custom-tree-node .label2 {
  flex-shrink: 0;
}

.custom-tree-node.disabled .key {
  color: var(--el-text-color-secondary);
}

.node-btn {
  cursor: pointer;
  color: var(--el-color-primary);
  opacity: 0.6;
  transition: opacity 0.2s;
  flex-shrink: 0;
  margin-left: auto;
  margin-right: 4px;
}

.node-btn:hover {
  opacity: 1;
}

/* === 新增要素面板 === */
.add-view {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 4px;
  box-sizing: border-box;
}

.add-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.add-header .header-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--el-text-color-primary);
}

.add-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.add-toolbar .toolbar-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-right: 4px;
}

.add-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  padding: 6px 10px 4px;
  background: var(--el-fill-color-lighter);
  flex-shrink: 0;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.add-props {
  flex: 1;
  overflow-y: auto;
  padding: 2px 0;
}

.add-props .prop-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}

.add-props .prop-key {
  width: 80px;
  flex-shrink: 0;
  font-size: 11px;
  font-family: monospace;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.add-props .prop-row .el-input {
  flex: 1;
}

.add-props .empty-props {
  text-align: center;
  padding: 16px 0;
  color: var(--el-text-color-placeholder);
  font-size: 12px;
}

.add-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 10px;
  border-top: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.json-editor-container {
  height: 60vh;
}

.json-editor-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.dirty-tip {
  font-size: 12px;
  color: var(--el-color-warning);
  opacity: 0;
  transition: opacity 0.2s;
  margin-right: auto;
}

.dirty-tip.visible {
  opacity: 1;
}

/* === 根节点右键菜单 === */
.ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
}

.ctx-menu {
  position: fixed;
  z-index: 3001;
  min-width: 148px;
  padding: 4px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-light);
}

.ctx-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  font-size: 13px;
  color: var(--el-text-color-primary);
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}

.ctx-item:hover {
  background: var(--el-fill-color-light);
}

.ctx-item.ctx-danger {
  color: var(--el-color-danger);
}

.ctx-item.ctx-danger:hover {
  background: var(--el-color-danger-light-9);
}

.ctx-arrow {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1;
}

/* 子菜单：悬停「符号化设置」时向右展开 */
.ctx-submenu {
  display: none;
  position: absolute;
  left: 100%;
  top: -4px;
  margin-left: 2px;
  min-width: 132px;
  padding: 4px;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  box-shadow: var(--el-box-shadow-light);
}

.ctx-item.has-sub:hover > .ctx-submenu {
  display: block;
}
</style>
