<script setup lang="ts">
/**
 * @file Main GIS data view component
 * @description The primary application view providing data import, dataset management,
 *              left panel with data tree, CRS tools, and map integration via GisMapSlot.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-04-13
 */
import { Fold, Expand, UploadFilled, Plus, Monitor, Sunny, Moon, FolderOpened, MapLocation, Delete, Message } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { computed, onMounted, ref, watch } from 'vue'

import { GisError, createUserMessage } from '~/common/GisError'
import { logger } from '~/common/logger'
import { SimpleDataFormat } from '~/components/data/DataFormat'
import GisDataImportDialog from '~/components/data/GisDataImportDialog.vue'
import GisDataInfo from '~/components/data/GisDataInfo'
import GisDataOverview from '~/components/data/GisDataOverview.vue'
import GisDataPanel from '~/components/data/GisDataPanel.vue'
import GisMobileTabBar from '~/components/data/GisMobileTabBar.vue'
import HistoryDataList from '~/components/data/HistoryDataList.vue'
import GisMapSlot from '~/components/gismap/GisMapSlot.vue'
import ModeIconRender from '~/components/renders/ModeIconRender.vue'
import VertexCountRender from '~/components/renders/VertexCountRender.vue'
import { themeMode } from '~/composables/dark'
import { useGisDataStore } from '~/composables/gisDataStore'
import { useBreakpoint } from '~/composables/useBreakpoint'
import { useShareReceiver } from '~/composables/useShareReceiver'
import { useDragGesture } from '~/composables/useTouchGesture'
import { useDeviceCapabilities } from '~/composables/useDeviceCapabilities'
import { localDb } from '~/composables/localDb'

const { datasets, dataSources, activeId, activeDataset, setActive, addDataSource, removeDataset } = useGisDataStore()
const { isMobile, isDesktop, panelWidth, panelCollapsedWidth, showLeftPanel } = useBreakpoint()
// 设备能力检测：左滑仅在触屏设备启用（桌面端保留删除按钮）
const { hasTouch } = useDeviceCapabilities()

// 左滑状态：记录当前展开左滑操作的数据集 id（同时仅一个展开）
const swipedDatasetId = ref<string | null>(null)
// 左滑手势处理（仅触屏设备，内联实现以携带 entryId 上下文）
// 水平/垂直位移判定：水平位移主导且超过 48px 才触发左滑，否则放行垂直滚动
const onCardTouchStart = (e: TouchEvent) => {
  if (e.touches.length !== 1) return
  const t = e.touches[0]
  const el = e.currentTarget as HTMLElement
  el.dataset.swipeStartX = String(t.clientX)
  el.dataset.swipeStartY = String(t.clientY)
  el.dataset.swipeHorizontal = '0'
}
const onCardTouchMove = (e: TouchEvent) => {
  if (e.touches.length !== 1) return
  const el = e.currentTarget as HTMLElement
  const startX = parseFloat(el.dataset.swipeStartX || '0')
  const startY = parseFloat(el.dataset.swipeStartY || '0')
  const t = e.touches[0]
  const deltaX = t.clientX - startX
  const deltaY = t.clientY - startY
  // 水平位移主导时 preventDefault，避免阻断（同时不阻断垂直滚动）
  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 8) {
    el.dataset.swipeHorizontal = '1'
    e.preventDefault()
  }
}
const onCardTouchEnd = (e: TouchEvent, entryId: string) => {
  const el = e.currentTarget as HTMLElement
  const horizontal = el.dataset.swipeHorizontal === '1'
  const startX = parseFloat(el.dataset.swipeStartX || '0')
  const t = e.changedTouches[0]
  const deltaX = t.clientX - startX
  // 清理标记
  delete el.dataset.swipeStartX
  delete el.dataset.swipeStartY
  delete el.dataset.swipeHorizontal
  // 左滑超过 48px 展开操作；否则收起
  if (horizontal && deltaX < -48) {
    swipedDatasetId.value = entryId
  } else if (horizontal && Math.abs(deltaX) < 48) {
    swipedDatasetId.value = null
  }
}

const importDialogVisible = ref(false)

// 初始化分享接收：检测 URL ?share=1 标记，从 Cache Storage 读取系统分享的文件并自动导入
const { init: initShareReceiver } = useShareReceiver()
onMounted(() => {
  initShareReceiver()
  loadHistory()
  localDb.on('changed', loadHistory)
})

// logo 动画重播：通过改变 key 强制重新挂载 SVG，使 SMIL 动画重新播放
const logoKey = ref(0)
const replayLogo = () => {
  logoKey.value++
}

// 数据源抽屉（右侧）
const sourceDrawerVisible = ref(false)

// 数据集删除（带确认）
const handleSourceDatasetRemove = async (id: string, e: Event) => {
  e.stopPropagation()
  const entry = datasets.value.find(d => d.id === id)
  const name = entry?.name || '该数据集'
  try {
    await ElMessageBox.confirm(
      `确定删除「${name}」吗？此操作不可撤销。`,
      '删除确认',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
    removeDataset(id)
  } catch {
    // 用户取消
  }
}

// 数据集 CRS 信息辅助
const getDatasetCrs = (data?: GisDataInfo) => {
  return data?.crs?.epsgCode ? `EPSG:${data.crs.epsgCode}` : '未设置'
}

// 左面板折叠状态
const panelCollapsed = ref(false)

// 用户拖拽调整的面板宽度（覆盖断点默认值）
const userPanelWidth = ref<number | null>(null)
const currentPanelWidth = computed(() => {
  if (!showLeftPanel.value) return 0
  if (panelCollapsed.value) return panelCollapsedWidth.value
  return userPanelWidth.value ?? panelWidth.value
})

// 面板拖拽调整
const MIN_PANEL_WIDTH = 220
const MAX_PANEL_WIDTH = 600

// 使用通用拖拽手势 hook：统一处理 MouseEvent + TouchEvent
// 桌面端鼠标拖拽行为保持不变，移动端/触屏设备新增触控拖拽
const { isDragging, startDrag } = useDragGesture(
  ({ deltaX }) => {
    userPanelWidth.value = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, startWidthForDrag + deltaX))
  },
  () => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  },
)
// 拖拽起点宽度（闭包外持有，供 onMove 回调读取）
let startWidthForDrag = 0
// 适配原有 startResize 签名：记录起点宽度后委托给 startDrag
const startResize = (e: MouseEvent | TouchEvent) => {
  startWidthForDrag = currentPanelWidth.value
  startDrag(e)
}

// 当前活跃数据（经过 CRS 转换后的）
const activeData = ref<GisDataInfo>(new GisDataInfo())
const activeTransformChain = ref<number[]>([])

// 地图实例引用（用于编辑模式等操作）
const activeMapSlotRef = ref<InstanceType<typeof GisMapSlot> | null>(null)

// 监听活跃数据集变化
watch(activeDataset, (dataset) => {
  if (dataset) {
    activeData.value = dataset.data
    activeTransformChain.value = dataset.data?.crs?.epsgCode ? [dataset.data.crs.epsgCode] : []
  } else {
    activeData.value = new GisDataInfo()
    activeTransformChain.value = []
  }
}, { immediate: true })

// 处理 GisDataPanel 的活跃数据变化
// 规则 R1/R3：数据集完全独立隔离，转换预览不污染原数据集地图
// （activeData 仅用于面板元信息展示，不影响 GisMapSlot 的 data 绑定）
const handleActiveDataChange = (data: GisDataInfo, transformChain: number[]) => {
  activeData.value = data
  activeTransformChain.value = transformChain
}

// 处理数据读取
const handleRead = (data: unknown) => {
  const dataInfo = data as GisDataInfo
  addDataSource(dataInfo)
}

const handleError = (err: Error) => {
  logger.error('数据读取失败:', err)
}

// 拖拽导入
const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

const handleDrop = async (e: DragEvent) => {
  e.preventDefault()
  e.stopPropagation()

  const files = e.dataTransfer?.files
  if (!files || files.length === 0) return

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    try {
      const buffer = await readFileAsArrayBuffer(file)
      const simpleDataFormat = new SimpleDataFormat()
      const data = await simpleDataFormat.read(buffer)
      data.name = file.name
      addDataSource(data)
    } catch (err: unknown) {
      let msg = createUserMessage(err)
      if (err instanceof GisError) {
        msg = `[${err.code}]\n\n${msg}`
      }
      ElMessageBox.alert(msg, '解析失败', { type: 'error' })
    }
  }
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

// 当前活跃地图实例 ID（供 GisDataPanel 和 GisMobileTabBar 使用）
const activeMapInstanceId = computed(() => activeId.value ? `map_${activeId.value}` : '')

// 移动端抽屉高度（px）：抽屉浮在地图上方时，地图区域需留出底部空间
const mobileSheetHeight = ref(0)

// 进入/退出编辑模式
const handleEnterEditMode = () => {
  // 编辑模式由 GisFeatureTree 管理
}

const handleExitEditMode = () => {
  activeMapSlotRef.value?.stopEditMode()
}

/**
 * 移动端抽屉高度变化：调整地图区域 padding-bottom，
 * 确保地图内容不被抽屉遮挡（三期布局修复：无遮罩浮层）
 * @param heightPx - 抽屉高度（px），0 表示抽屉关闭
 */
const handleSheetHeightChange = (heightPx: number) => {
  mobileSheetHeight.value = heightPx
}

// ===== 历史记录相关 =====
import type { GisFileData } from '~/components/data/LocalDb'

const historyDatas = ref<GisFileData[]>([])
const historyLoaded = ref(false)

const loadHistory = () => {
  if (!localDb.isSupport) {
    historyLoaded.value = true
    return
  }
  localDb.listAll().then((datas: GisFileData[]) => {
    historyDatas.value = datas
    historyLoaded.value = true
    // 无历史记录时自动打开导入弹窗
    if (datas.length === 0 && datasets.value.length === 0) {
      importDialogVisible.value = true
    }
  }).catch(() => {
    historyLoaded.value = true
  })
}

const handleHistoryRowClick = (row: GisFileData) => {
  const content = row.content
  const dataName = row.name
  try {
    const simpleDataFormat = new SimpleDataFormat()
    simpleDataFormat.read(content as ArrayBuffer | string).then((data: GisDataInfo) => {
      data.name = dataName
      handleRead(data)
    }).catch((e: Error) => {
      logger.error('历史记录解析失败:', e)
      handleError(e)
    })
  } catch (e) {
    logger.error('历史记录解析失败:', e)
    handleError(e as Error)
  }
}

/** 移除一条历史数据（二次确认后从 IndexedDB 删除，列表自动刷新） */
const handleHistoryRemove = (row: GisFileData) => {
  ElMessageBox.confirm(
    `确认移除历史数据「${row.name}」？移除后不可恢复。`,
    '移除历史数据',
    { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
  ).then(() => {
    localDb.remove(row.id).catch((e: unknown) => {
      logger.error('历史数据移除失败:', e)
      handleError(e as Error)
    })
  }).catch(() => {})
}
</script>

<template>
  <div class="gis-data-page" :class="{ 'is-mobile': isMobile }">
    <!-- 顶栏 -->
    <div class="top-bar">
      <div class="top-bar-left" @mouseenter="replayLogo">
        <svg :key="logoKey" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 512 512">
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <!-- 半透明填充（闭合后淡入） -->
          <polygon points="256,50 460,198 382,432 130,432 52,198" fill="rgba(234,88,12,0.15)" stroke="none" opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin="1.6s" dur="0.3s" fill="freeze" />
          </polygon>

          <!-- 描边逐步绘制 -->
          <polygon points="256,50 460,198 382,432 130,432 52,198" fill="none" stroke="#ea580c" stroke-width="24"
            stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="1250" stroke-dashoffset="1250"
>
            <animate attributeName="stroke-dashoffset" from="1250" to="0" dur="1.6s" fill="freeze" calcMode="linear" />
          </polygon>

          <!-- 5个节点依次出现 -->
          <circle cx="256" cy="50" r="30" fill="#ea580c" opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin="0s" dur="0.12s" fill="freeze" />
          </circle>
          <circle cx="460" cy="198" r="30" fill="#ea580c" opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin="0.32s" dur="0.12s" fill="freeze" />
          </circle>
          <circle cx="382" cy="432" r="30" fill="#ea580c" opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin="0.64s" dur="0.12s" fill="freeze" />
          </circle>
          <circle cx="130" cy="432" r="30" fill="#ea580c" opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin="0.96s" dur="0.12s" fill="freeze" />
          </circle>
          <circle cx="52" cy="198" r="30" fill="#ea580c" opacity="0">
            <animate attributeName="opacity" from="0" to="1" begin="1.28s" dur="0.12s" fill="freeze" />
          </circle>

          <!-- 画笔光点：与描边同步 -->
          <circle r="16" fill="#ea580c" opacity="0.85" filter="url(#glow)">
            <animateMotion path="M256,50 L460,198 L382,432 L130,432 L52,198 L256,50" dur="1.6s" fill="freeze"
              calcMode="linear"
/>
            <animate attributeName="opacity" values="0;0.85;0.85;0" keyTimes="0;0.02;0.9;1" dur="1.6s" fill="freeze" />
            <animate attributeName="r" values="16;16;0" keyTimes="0;0.9;1" dur="1.6s" fill="freeze" />
          </circle>
        </svg>

        <span class="top-bar-title">Gis Tools</span>
        <a href="mailto:yuanyu@supermap.com" class="top-bar-contact" title="联系作者：yuanyu@supermap.com">
          <el-icon :size="14"><Message /></el-icon>
        </a>

      </div>

      <div class="top-bar-right">
        <el-button size="small" type="primary" @click="importDialogVisible = true">
          <el-icon>
            <UploadFilled />
          </el-icon>
          <span>导入数据</span>
        </el-button>
        <el-button size="small" class="dataset-badge-btn"
          @click="sourceDrawerVisible = true"
>
          <ModeIconRender mode="datasource" :size="14" />
          <span>{{ datasets.length }}</span>
        </el-button>
        <el-radio-group v-model="themeMode" size="small" class="theme-switch">
          <el-radio-button value="auto">
            <el-icon :size="14">
              <Monitor />
            </el-icon>
          </el-radio-button>
          <el-radio-button value="light">
            <el-icon :size="14">
              <Sunny />
            </el-icon>
          </el-radio-button>
          <el-radio-button value="dark">
            <el-icon :size="14">
              <Moon />
            </el-icon>
          </el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <!-- 导入弹窗 -->
    <gis-data-import-dialog v-model="importDialogVisible" />

    <!-- 数据源抽屉（右侧）：数据源分组 + 数据集卡片 -->
    <el-drawer v-model="sourceDrawerVisible" title="数据源" direction="rtl" size="380px" class="source-drawer">
      <div class="source-drawer-body">
        <!-- 数据源分组 -->
        <div v-for="source in dataSources" :key="source.id" class="source-group">
          <!-- 数据源标题 -->
          <div class="source-group-header">
            <ModeIconRender mode="datasource" :size="16" />
            <span class="source-group-title">{{ source.name }}</span>
            <span class="source-group-count">{{ source.datasets.length }}</span>
          </div>
          <!-- 数据集卡片 -->
          <div class="dataset-cards">
            <div v-for="entry in source.datasets" :key="entry.id" class="dataset-card-wrapper"
              :class="{ 'swipe-open': swipedDatasetId === entry.id, 'touch-enabled': hasTouch }"
              @click="swipedDatasetId === entry.id ? (swipedDatasetId = null) : null"
>
              <!-- 左滑露出的操作层（仅触屏设备显示） -->
              <div v-if="hasTouch" class="dataset-card-actions">
                <button class="swipe-action-btn swipe-delete" title="删除"
                  @click.stop="handleSourceDatasetRemove(entry.id, $event)"
>
                  <el-icon><Delete /></el-icon>
                  <span>删除</span>
                </button>
              </div>
              <div class="dataset-card"
                :class="{ 'is-active': entry.id === activeId }"
                @click="setActive(entry.id)"
                @touchstart="hasTouch && onCardTouchStart($event)"
                @touchmove="hasTouch && onCardTouchMove($event)"
                @touchend="hasTouch && onCardTouchEnd($event, entry.id)"
>
                <div class="dataset-card-header">
                  <ModeIconRender mode="dataset" :size="16" class="dataset-card-icon" />
                  <span class="dataset-card-name">{{ entry.name }}</span>
                  <el-icon v-if="!hasTouch" class="dataset-card-delete" title="删除"
                    @click.stop="handleSourceDatasetRemove(entry.id, $event)"
>
                    <Delete />
                  </el-icon>
                </div>
                <div class="dataset-card-meta">
                  <el-tag size="small" type="info" effect="plain">{{ getDatasetCrs(entry.data) }}</el-tag>
                  <span class="dataset-card-stat">{{ entry.data?.features?.length ?? 0 }} 要素</span>
                  <el-tooltip v-if="entry.appendedFrom && entry.appendedFrom.length > 0"
                    :content="entry.appendedFrom.map(a => `从「${a.name}」追加了 ${a.count} 个要素`).join('；')" placement="top"
>
                    <el-tag size="small" type="warning" effect="dark">已追加</el-tag>
                  </el-tooltip>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-drawer>

    <!-- 主体内容 -->
    <div class="main-content" @dragover="handleDragOver" @drop="handleDrop">
      <!-- 空状态：显示历史记录列表 -->
      <div v-if="datasets.length === 0" class="empty-state">
        <!-- 有历史记录时显示历史记录卡片列表 -->
        <div v-if="historyLoaded && historyDatas.length > 0" class="history-content">
          <HistoryDataList :items="historyDatas" @select="handleHistoryRowClick" @remove="handleHistoryRemove" />
        </div>
        <!-- 无历史记录时显示空状态 -->
        <div v-else class="empty-content" role="button" tabindex="0"
          @click="importDialogVisible = true" @keydown.enter="importDialogVisible = true"
        >
          <el-icon :size="44" color="var(--el-color-info-light-3)">
            <upload-filled />
          </el-icon>
          <p class="empty-title">暂无数据</p>
          <p class="empty-desc">
            <span class="empty-action">拖拽</span>
            <span>文件到此，或者</span>
            <span class="empty-action">点击</span>
            <span>查看更多方式</span>
          </p>
        </div>
      </div>

      <!-- 有数据时的布局：统一弹性布局，CSS 控制响应式显隐（单一代码路径） -->
      <template v-else>
        <div class="unified-layout">
          <!-- 左面板（CSS 控制 ≥768px 显示，<768px 隐藏） -->
          <div class="left-panel" :class="{ collapsed: panelCollapsed }" :style="{ width: currentPanelWidth + 'px' }">
            <div class="panel-header">
              <span v-show="!panelCollapsed" class="panel-title">数据操作</span>
              <el-button text size="small" :title="panelCollapsed ? '展开' : '折叠'"
                @click="panelCollapsed = !panelCollapsed"
>
                <el-icon>
                  <Expand v-if="panelCollapsed" />
                  <Fold v-else />
                </el-icon>
              </el-button>
            </div>
            <div v-show="!panelCollapsed" class="panel-body">
              <gis-data-panel :data="activeDataset?.data" :instance-id="activeMapInstanceId" :map-ready="true"
                @active-data-change="handleActiveDataChange" @read="handleRead" @error="handleError"
                @enter-edit-mode="handleEnterEditMode" @exit-edit-mode="handleExitEditMode"
/>
            </div>
          </div>

          <!-- 拖拽手柄（CSS 控制 ≥768px 显示，<768px 隐藏） -->
          <div v-show="!panelCollapsed" class="panel-resize-handle" :class="{ dragging: isDragging }"
            @mousedown="startResize"
            @touchstart="startResize"
/>

          <!-- 主内容区 -->
          <div class="content-area"
            :style="{
              width: `calc(100% - ${currentPanelWidth}px - ${panelCollapsed ? 0 : 4}px)`,
              paddingBottom: isMobile && mobileSheetHeight > 0 ? `${mobileSheetHeight}px` : '0'
            }"
>
            <!-- 地图（多实例，每个数据集一个，v-show 切换；断点切换时不销毁） -->
            <div class="map-container">
              <!-- 规则 R1：每个数据集对应独立地图实例，v-show 切换；切换数据集必然伴随地图切换 -->
              <gis-map-slot v-for="entry in datasets" :key="entry.id"
                :ref="(el: any) => { if (entry.id === activeId) activeMapSlotRef = el as InstanceType<typeof GisMapSlot> }"
                :dataset-id="entry.id" :data="entry.data"
                :visible="entry.id === activeId"
/>
            </div>
            <!-- 底部状态栏（模板层布局编排：移动端 compact / 桌面端 full） -->
            <gis-data-overview :data="activeData" :transform-chain="activeTransformChain" :mode="isDesktop ? 'full' : 'compact'" />
          </div>

          <!-- 移动端底部导航（CSS 控制 <768px 显示，≥768px 隐藏） -->
          <gis-mobile-tab-bar class="mobile-nav-area" :data="activeDataset?.data" :instance-id="activeMapInstanceId" :map-ready="true"
            @open-import="importDialogVisible = true" @active-data-change="handleActiveDataChange" @read="handleRead"
            @error="handleError" @enter-edit-mode="handleEnterEditMode" @exit-edit-mode="handleExitEditMode"
            @sheet-height-change="handleSheetHeightChange"
/>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.gis-data-page {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  overflow: hidden;
}

/* 顶栏 */
.top-bar {
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-lighter);
  box-sizing: border-box;
  flex-shrink: 0;
}

.top-bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.top-bar-logo {
  flex-shrink: 0;
  border-radius: 5px;
}

.top-bar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  letter-spacing: 0.5px;
}

.top-bar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.top-bar-contact {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--el-text-color-regular);
  text-decoration: none;
  padding: 4px;
  border-radius: 4px;
  opacity: 0.2;
  transition: opacity 0.15s, color 0.15s, background 0.15s;
}

.top-bar-contact:hover {
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  opacity: 1;
}

.theme-switch :deep(.el-radio-button__inner) {
  padding: 4px 8px;
}

/* 主体内容 */
.main-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* 空状态 */
.empty-state {
  width: 100%;
  height: calc(100% - 16px);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--el-border-color-lighter);
  border-radius: 8px;
  box-sizing: border-box;
  background: var(--el-fill-color-lighter);
  cursor: pointer;
  user-select: none;
  outline: none;
  margin: 8px;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.empty-title {
  font-size: 15px;
  font-weight: 500;
  color: var(--el-text-color-regular);
  margin: 8px 0 0 0;
}

.empty-desc {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: center;
}

.empty-action {
  color: var(--el-color-primary);
  font-weight: 500;
}

/* 统一弹性布局（替代原 desktop-layout + mobile-layout 双套结构） */
.unified-layout {
  width: 100%;
  height: 100%;
  display: flex;
  overflow: hidden;
}

.left-panel {
  height: 100%;
  background: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-lighter);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}

.left-panel.collapsed {
  background: var(--el-fill-color-lighter);
}

.panel-resize-handle {
  width: 4px;
  height: 100%;
  cursor: col-resize;
  background: var(--el-border-color-lighter);
  flex-shrink: 0;
  transition: background 0.2s;
  z-index: 5;
}

.panel-resize-handle:hover,
.panel-resize-handle.dragging {
  background: var(--el-color-primary);
}

.panel-header {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex-shrink: 0;
}

.left-panel.collapsed .panel-header {
  justify-content: center;
  padding: 0;
}

.panel-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.panel-body {
  flex: 1;
  overflow: hidden;
}

.content-area {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  flex: 1;
}

.map-container {
  flex: 1;
  overflow: hidden;
  position: relative;
}

/* 移动端底部导航区域（默认隐藏，<768px 显示） */
.mobile-nav-area {
  display: none;
}

/* 响应式断点适配（5 级断点：xs<576 / sm 576-767 / md 768-1023 / lg 1024-1279 / xl≥1280） */

/* 平板端顶栏高度（md: 768-1023px） */
@media (min-width: 768px) and (max-width: 1023px) {
  .top-bar {
    height: 44px;
  }
}

/* 中小屏适配（<768px）：左面板隐藏（验收项5：≥768px 显示） */
@media (max-width: 767px) {
  .left-panel {
    display: none;
  }

  /* 主内容区全宽 */
  .content-area {
    width: 100% !important;
  }
}

/* 拖拽手柄仅在 ≥1024px 可用（验收项6：平板端固定宽度不可拖拽） */
@media (max-width: 1023px) {
  .panel-resize-handle {
    display: none;
  }
}

/* 移动端适配（xs + sm: <768px）：纵向布局 + 底部导航 */
@media (max-width: 767px) {
  /* 统一布局改为纵向排列（地图在上，底部导航在下） */
  .unified-layout {
    flex-direction: column;
  }

  /* 底部导航显示：固定高度（tabBar 56px + 安全区），避免在 column 布局中占满剩余空间 */
  .mobile-nav-area {
    display: flex;
    width: 100%;
    flex-shrink: 0;
    flex-grow: 0;
    height: calc(56px + env(safe-area-inset-bottom, 0px));
    overflow: hidden;
  }

  /* 顶栏高度 48px + 安全区适配（触控热区 ≥48dp） */
  .top-bar {
    height: calc(48px + env(safe-area-inset-top, 0px));
    padding-top: env(safe-area-inset-top, 0px);
    padding-left: 8px;
    padding-right: 8px;
  }

  /* 移动端隐藏主题切换（空间不足，移至设置中） */
  .theme-switch {
    display: none;
  }

  /* 移动端顶栏按钮只显示图标（隐藏文字 span，保留图标 span） */
  .top-bar-right .el-button > span:last-child {
    display: none;
  }

  /* 移动端数据集徽章只显示图标 */
  .dataset-badge-btn > span:last-child {
    display: none;
  }
}

/* 移动端顶栏文字调整 */
.gis-data-page.is-mobile .top-bar-title {
  font-size: 12px;
  letter-spacing: 0.2px;
}

.gis-data-page.is-mobile .top-bar-right .el-button span {
  display: none;
}

/* 数据源抽屉按钮 */
.dataset-badge-btn {
  font-size: 12px;
}

/* 数据源抽屉 */
.source-drawer-body {
  height: 100%;
  overflow-y: auto;
  padding: 8px;
}

/* 数据源分组 */
.source-group {
  margin-bottom: 12px;
}

.source-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.source-group-icon {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.source-group-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-group-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  background: var(--el-fill-color-light);
  padding: 1px 6px;
  border-radius: 8px;
}

/* 数据集卡片 */
.dataset-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 左滑操作容器（仅触屏设备） */
.dataset-card-wrapper {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
}
.dataset-card-wrapper .dataset-card {
  position: relative;
  z-index: 1;
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.dataset-card-wrapper.swipe-open .dataset-card {
  transform: translateX(-72px);
}
.dataset-card-actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: stretch;
  z-index: 0;
}
.swipe-action-btn {
  width: 72px;
  border: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 12px;
  color: #fff;
  cursor: pointer;
  background: var(--el-color-danger);
}
.swipe-action-btn .el-icon {
  font-size: 16px;
}

.dataset-card {
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  background: var(--el-bg-color);
}

.dataset-card:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-fill-color-light);
}

.dataset-card.is-active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}

.dataset-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.dataset-card-icon {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

.dataset-card-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.dataset-card.is-active .dataset-card-name {
  color: var(--el-color-primary);
}

.dataset-card-delete {
  flex-shrink: 0;
  color: var(--el-text-color-placeholder);
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s;
}

.dataset-card-delete:hover {
  color: var(--el-color-danger);
  opacity: 1;
}

.dataset-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dataset-card-stat {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* ===== 历史记录内容样式 ===== */
.history-content {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px;
  box-sizing: border-box;
}

/* 移动端历史记录样式调整 */
@media (max-width: 767px) {
  .history-content {
    padding: 12px;
  }
}
</style>
