<script setup lang="ts">
/**
 * @file GIS data reader component
 * @description Handles file upload, drag-and-drop, clipboard paste, and share target
 *              data import. Supports all spatial data formats via SimpleDataFormat parsing.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-04-13
 */
import { ElMessageBox } from 'element-plus';
import * as GeoJSON from 'geojson';
import {getCurrentInstance, onMounted, ref,ComponentInternalInstance, computed} from "vue";

import Common from "~/common/Common";
import {GisError, GisErrorCode, createUserMessage} from "~/common/GisError";
import {logger as appLogger} from "~/common/logger";
import {SimpleDataFormat} from "~/components/data/DataFormat";
import {useBreakpoint} from "~/composables/useBreakpoint";
import GisDataInfo from "~/components/data/GisDataInfo";
import type { GisFileData } from "~/components/data/LocalDb";
import HistoryDataList from "~/components/data/HistoryDataList.vue";
import MapDrawer from "~/components/data/MapDrawer.vue";
import {TipLog, TipLogger} from "~/components/data/TipLogger";
import {localDb} from "~/composables/localDb";

const emitHandler = defineEmits(['read','error'])

const activeReaderTab = ref('upload')
defineProps({
  dataType: {
    type: String,
    default: '上传文件'
  }
})
const txt = ref('')
const tipText = ref('')
const loading = ref(false)

// 历史记录数据（从 IndexedDB 加载）
const historyDatas = ref<GisFileData[]>([])

const loadHistory = () => {
  if (!localDb.isSupport) return
  localDb.listAll().then((datas: GisFileData[]) => {
    historyDatas.value = datas
  }).catch(() => {})
}

// 错误详情弹窗
const errorDialogVisible = ref(false)
const errorTitle = ref('')
const errorDetail = ref('')

const showError = (e: unknown, context: string) => {
  errorTitle.value = `${context}失败`
  let msg = createUserMessage(e)
  // 对 GisError 追加错误码信息
  if (e instanceof GisError) {
    const codeLabel: Record<string, string> = {
      [GisErrorCode.CRS_RECOGNITION_FAILED]: '坐标系识别失败',
      [GisErrorCode.COORDINATE_TRANSFORM_FAILED]: '坐标转换失败',
      [GisErrorCode.DATA_PARSE_FAILED]: '数据解析失败',
      [GisErrorCode.DATA_FORMAT_UNSUPPORTED]: '不支持的数据格式',
    }
    const label = codeLabel[e.code] || e.code
    msg = `[${label}]\n\n${msg}`
  }
  errorDetail.value = msg
  errorDialogVisible.value = true
}

let curInstance: ComponentInternalInstance | null = null;
let tipLogger: TipLogger | null = null;
onMounted(() => {
  curInstance = getCurrentInstance();
  if (curInstance) {
    tipLogger = new TipLogger(curInstance);
    tipLogger.on('change', (...args: unknown[]) => {
      const log = args[0] as TipLog;
      setTipText(log.name);
    })
  }
  // 加载历史记录并监听变化
  loadHistory();
  localDb.on('changed', loadHistory);
})
const handleFileChanged = (file: { name: string; raw: Blob }) => {
  try {
    const reader = new FileReader()
    const dataNamme = file.name;
    reader.onerror = () => {
      loading.value = false;
      appLogger.error('文件读取失败');
      emitHandler('error', new Error('文件读取失败'));
    }
    reader.onload = (e) => {
      const val = e.target?.result as string
      readContext(val, dataNamme).then((data: unknown) => {
        localDb.add(dataNamme, val, extractMeta(data as GisDataInfo))
        emitHandler('read', data)
      }).catch((e: Error) => {
        appLogger.error('文件解析失败:', e);
        emitHandler('error',e)
        showError(e, '文件解析')
      })
    }
    reader.readAsArrayBuffer(file.raw)
  } catch (e) {
    appLogger.error('文件读取失败:', e);
  }
}

const handleHistoryRowClick = (row: GisFileData) => {
  readContext(row.content, row.name).then((data: unknown) => {
    emitHandler('read', data)
  }).catch((e: Error) => {
    appLogger.error('历史记录解析失败:', e);
    emitHandler('error',e)
    showError(e, '历史记录解析')
  })
}

/** 移除一条历史数据（二次确认后从 IndexedDB 删除，列表自动刷新） */
const handleHistoryRemove = (row: GisFileData) => {
  ElMessageBox.confirm(
    `确认移除历史数据「${row.name}」？移除后不可恢复。`,
    '移除历史数据',
    { type: 'warning', confirmButtonText: '移除', cancelButtonText: '取消' },
  ).then(() => {
    localDb.remove(row.id).catch((e: unknown) => {
      appLogger.error('历史数据移除失败:', e);
      showError(e, '历史数据移除')
    })
  }).catch(() => {})
}

const handleTextConfirm = () => {
  if (!txt.value.trim()) return;
  try {
    const dataName = `文本-${new Date().getTime()}`;
    readContext(txt.value, dataName).then((data: unknown) => {
      localDb.add(dataName, txt.value, extractMeta(data as GisDataInfo))
      emitHandler('read', data)
    }).catch((e: Error) => {
      appLogger.error('文本解析失败:', e);
      emitHandler('error',e)
      showError(e, '文本解析')
    })
  } catch (e) {
    appLogger.error('文本处理失败:', e);
  }
}
const readContext = (context: unknown, dataName: string): Promise<unknown> => {
  if (loading.value) {
    return Promise.reject(new Error("Running"));
  }
  return new Promise<unknown>((resolve, reject) => {
    loading.value = true
    try {
      if (context !== undefined) {
        const simpleDataFormat = new SimpleDataFormat();
        return simpleDataFormat.read(context as ArrayBuffer | string).then((data: GisDataInfo) => {
          data.name = dataName;
          resolve(data)
        }).catch(reject)
      }else {
        reject(new Error("Context Empty"));
      }
    } catch (e) {
      reject(e);
    } finally {
      setTimeout(() => {
        loading.value = false
      }, 500)
    }
  })
}

/** 从解析结果中提取元数据，用于历史记录展示 */
const extractMeta = (data: GisDataInfo) => ({
  crs: data.crs?.epsgCode ? `EPSG:${data.crs.epsgCode}` : '',
  types: data.getTypes()?.join(', ') || '',
  featureCount: data.features?.length ?? 0,
  vertexCount: data.getTotalVertexCount(),
})

const setTipText = (msg: string) => {
  tipText.value = msg
}
const handleMapDrawSubmit = (features: GeoJSON.Feature[], crsEpsg: number) => {
  const dataNamme = `绘制-${new Date().getTime()}`;
  const jsonStr = JSON.stringify({
    type: "FeatureCollection",
    features: features,
    crs: { type: "name", properties: { name: `EPSG:${crsEpsg}` } }
  });
  readContext(jsonStr, dataNamme).then((data: unknown) => {
    localDb.add(dataNamme, jsonStr, extractMeta(data as GisDataInfo));
    emitHandler('read', data)
  }).catch((e: Error) => {
    appLogger.error('绘制数据解析失败:', e);
    emitHandler('error',e)
    showError(e, '绘制数据解析')
  })
}

defineExpose({
  handleTextConfirm,
  txt,
  activeReaderTab,
  loading,
})
</script>
<template>
  <div v-loading="loading" class="gis-data-reader-container">
    <!-- 错误详情弹窗（append-to-body 逃逸 el-tab-pane 的 overflow:hidden） -->
    <el-dialog v-model="errorDialogVisible" :title="errorTitle" width="600" destroy-on-close append-to-body>
      <el-input
        type="textarea"
        :model-value="errorDetail"
        :rows="10"
        readonly
        resize="vertical"
        class="error-detail-textarea"
      />
      <template #footer>
        <el-button type="primary" @click="errorDialogVisible = false">确定</el-button>
      </template>
    </el-dialog>
    <el-tabs v-model="activeReaderTab" type="border-card" class="gis-data-reader-tabs">
      <el-tab-pane label="上传文件" name="upload">
        <el-upload
            class="w-full h-95%"
            drag
            :limit="0"
            :on-change="handleFileChanged"
            :auto-upload="false"
            accept=".geojson,.json,.topojson,.wkt,.txt,.csv,.shp,.zip,.dxf,.exf,.wkb,application/json,application/zip,application/octet-stream,text/plain,text/csv,application/dxf"
        >
          <div class="upload-info">
            <el-icon class="el-icon--upload">
              <upload-filled />
            </el-icon>
            <div class="el-upload__text">
              拖拽文件到此处 或 <em>点击上传</em>
              <p>
                ShapeFile、ShapeZip、GeoJson、TopoJSON、WKT、DXF、EXF、电子报盘
              </p>
            </div>
          </div>
          <template #file>
            <div />
          </template>
        </el-upload>
      </el-tab-pane>
      <el-tab-pane label="输入文本" name="text">
        <div class="text-tab-content">
          <el-input
            v-model="txt"
            type="textarea"
            :rows="10"
            placeholder="请输入 GeoJSON / TopoJSON / WKT / 电子报盘文本"
            resize="vertical"
            class="text-textarea"
          />
        </div>
      </el-tab-pane>
      <el-tab-pane label="绘制图形">
        <map-drawer @submit="handleMapDrawSubmit" />
      </el-tab-pane>
      <el-tab-pane label="历史数据" name="history">
        <div class="history-tab-content">
          <HistoryDataList
            v-if="historyDatas.length > 0"
            :items="historyDatas"
            @select="handleHistoryRowClick"
            @remove="handleHistoryRemove"
          />
          <div v-else class="history-empty">
            <p>暂无历史数据</p>
          </div>
        </div>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<style scoped>
.gis-data-reader-container {
  width: 100%;
  height: 100%;
  background: var(--el-bg-color);
  box-sizing: border-box;
}

.gis-data-reader-tabs {
  height: calc(100%);
}

.gis-data-reader-container :deep(.el-upload--text.is-drag),
.gis-data-reader-container :deep( .el-upload-dragger ){
  height: 100%;
}

.upload-info {
  height: 100%;
  display: flex;
  align-items: center;
  flex-direction: column;
  justify-content: center;
}

.gis-data-reader-container :deep( .el-tabs--border-card ){
  border: none;
}

.gis-data-reader-container :deep( .el-tabs .el-tabs__content .el-tab-pane ){
  height: 100%;
  width: 100%;
  overflow: hidden;
  padding: 0;
}

/* 输入文本 tab：flex 纵向布局，textarea 填满剩余空间 */
.text-tab-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  overflow: hidden;
}

/* 历史数据 tab：列表填满高度 */
.history-tab-content {
  height: 100%;
  width: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  padding: 12px;
  box-sizing: border-box;
}

.history-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.text-textarea {
  flex: 1;
  min-height: 0;
}

.text-textarea :deep(.el-textarea__inner) {
  height: 100% !important;
  resize: vertical;
}

.error-detail-textarea :deep(.el-textarea__inner) {
  font-family: monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-color-danger);
}

/* 移动端（xs/sm <768px）：tabs 等宽分布，避免溢出和横向滚动 */
@media (max-width: 767px) {
  /* 隐藏 tabs 滚动箭头（改用等宽分布，无需滚动） */
  .gis-data-reader-container :deep(.el-tabs__nav-prev),
  .gis-data-reader-container :deep(.el-tabs__nav-next) {
    display: none !important;
  }

  /* nav-wrap 取消 overflow:hidden，允许 nav 铺满 */
  .gis-data-reader-container :deep(.el-tabs__nav-wrap) {
    overflow: visible;
  }

  /* nav-scroll 铺满，取消居中限制 */
  .gis-data-reader-container :deep(.el-tabs__nav-scroll) {
    width: 100%;
    overflow: visible;
  }

  /* nav 使用 flex 等宽分布 */
  .gis-data-reader-container :deep(.el-tabs__nav) {
    width: 100%;
    transform: none !important;
    display: flex;
  }

  /* 每个 tab 等宽（1/4），文字超长省略 */
  .gis-data-reader-container :deep(.el-tabs__item) {
    flex: 1;
    width: 25%;
    padding: 0 4px !important;
    font-size: 12px;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* border-card 类型 tabs 的 header padding 清零 */
  .gis-data-reader-container :deep(.el-tabs--border-card > .el-tabs__header) {
    padding: 0;
  }

  /*
   * 移动端：消除 el-tabs--border-card 的 -1px 偏移
   * 原因：Element Plus 默认给第一个 el-tabs__item 设置 margin-left:-1px、
   *       所有 el-tabs__item 设置 margin-top:-1px，用于覆盖 header 边框
   * 问题：移动端 dialog 全屏（x=0, y=0），-1px 会导致 tab 项左上角溢出视窗 1px
   * 修复：将 margin 归零，让 tab 项完全在视窗范围内
   * 影响场景：场景2/3/4/5 的 xs(500x667)、sm(600x960) 视口
   */
  .gis-data-reader-container :deep(.el-tabs--border-card > .el-tabs__header .el-tabs__item) {
    margin-left: 0;
    margin-top: 0;
  }

  /* 移动端表格单元格 padding 缩小 */
  .gis-data-reader-container :deep(.history-table .el-table__body td) {
    padding: 4px 2px;
  }

  .gis-data-reader-container :deep(.history-table .el-table__header th) {
    padding: 4px 2px;
  }
}
</style>
