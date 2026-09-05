<script setup lang="ts">
/**
 * @file History data list component
 * @description 共享历史记录卡片列表，用于开屏空状态和导入弹窗的"历史数据"tab。
 *              响应式适配移动端/桌面端布局：移动端紧凑双行，桌面端详细信息列。
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-06-27
 */
import { Delete } from '@element-plus/icons-vue'

import Common from '~/common/Common'
import type { GisFileData } from '~/components/data/LocalDb'
import GeoTypeIconRender from '~/components/renders/GeoTypeIconRender.vue'
import { useBreakpoint } from '~/composables/useBreakpoint'

// 注意：Vue 对未传的 Boolean prop 会取 false 而非 undefined，
// 必须 withDefaults 显式给 true，否则「默认显示移除按钮」不生效
withDefaults(defineProps<{
  items: GisFileData[]
  /** 是否显示移除按钮，默认显示 */
  removable?: boolean
}>(), {
  removable: true,
})

const emit = defineEmits<{
  select: [row: GisFileData]
  remove: [row: GisFileData]
}>()

const { isMobile } = useBreakpoint()

const formatCount = (n: number): string => {
  if (n >= 1000) {
    const k = n / 1000
    return k >= 10 ? Math.round(k) + 'k' : k.toFixed(1) + 'k'
  }
  return String(n)
}

const formatTimeDate = (id: number): string => {
  const full = Common.dataTimeToLocal(id)
  const match = full.match(/\d{4}\/(\d{1,2})\/(\d{1,2})/)
  if (match) {
    return `${match[1].padStart(2, '0')}.${match[2].padStart(2, '0')}`
  }
  return full
}

const formatTimeHM = (id: number): string => {
  const full = Common.dataTimeToLocal(id)
  const match = full.match(/(\d{1,2}):(\d{2})/)
  if (match) {
    return `${match[1].padStart(2, '0')}:${match[2]}`
  }
  return ''
}

/** 格式化文件大小：从 content 计算字节数并转换为 B/KB/MB */
const formatFileSize = (content: ArrayBuffer | string): string => {
  const bytes = typeof content === 'string'
    ? new Blob([content]).size
    : (content?.byteLength ?? 0)
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

/** 推断文件格式类型：从文件名扩展名或前缀提取 */
const formatFileType = (name: string): string => {
  if (name.startsWith('文本-')) return 'TEXT'
  if (name.startsWith('绘制-')) return 'DRAW'
  const ext = name.split('.').pop()?.toUpperCase()
  return ext && ext !== name.toUpperCase() ? ext : 'FILE'
}
</script>

<template>
  <div class="history-list">
    <div
      v-for="(row, idx) in items"
      :key="row.id"
      class="history-item"
      :class="{ 'is-mobile': isMobile }"
      @click="emit('select', row)"
    >
      <!-- 编号 -->
      <div class="history-item-index">{{ String(idx + 1).padStart(3, '0') }}</div>

      <!-- ===== 移动端紧凑布局：双行，信息量与桌面端一致 ===== -->
      <template v-if="isMobile">
        <!-- 移动端主体：名称行 + meta行 -->
        <div class="history-item-info">
          <!-- 第一行：名称 + 格式标签 -->
          <div class="history-item-name-row">
            <span class="history-item-name">{{ row.name }}</span>
            <span class="meta-tag meta-tag-format">{{ formatFileType(row.name) }}</span>
          </div>
          <!-- 第二行：类型图标 + 计数 + 文件大小 + CRS + 时间 -->
          <div class="history-item-meta">
            <div class="history-item-types">
              <GeoTypeIconRender
                v-for="t in (row.types || '').split(', ').filter(Boolean)"
                :key="t"
                :type="t"
                :size="14"
              />
            </div>
            <div class="history-item-counts">
              <span class="count-capsule">
                <span class="count-capsule-left">{{ formatCount(row.featureCount ?? 0) }}</span>
                <span class="count-capsule-right">{{ formatCount(row.vertexCount ?? 0) }}</span>
              </span>
            </div>
            <span class="meta-size">{{ formatFileSize(row.content) }}</span>
            <span class="meta-crs">{{ row.crs || '未设置' }}</span>
            <span class="meta-time">{{ formatTimeDate(row.id) }} {{ formatTimeHM(row.id) }}</span>
          </div>
        </div>
      </template>

      <!-- ===== 桌面端详细布局：多列信息 ===== -->
      <template v-else>
        <!-- 名称和类型信息 -->
        <div class="history-item-info">
          <div class="history-item-name">{{ row.name }}</div>
          <div class="history-item-meta">
            <div class="history-item-types">
              <GeoTypeIconRender
                v-for="t in (row.types || '').split(', ').filter(Boolean)"
                :key="t"
                :type="t"
                :size="13"
              />
            </div>
            <div class="history-item-counts">
              <span class="count-capsule">
                <span class="count-capsule-left">{{ formatCount(row.featureCount ?? 0) }}</span>
                <span class="count-capsule-right">{{ formatCount(row.vertexCount ?? 0) }}</span>
              </span>
            </div>
          </div>
        </div>
        <!-- 桌面端详细 meta：格式类型 + 文件大小 + 时间 + CRS -->
        <div class="history-item-desktop-meta">
          <div class="meta-row">
            <span class="meta-tag meta-tag-format">{{ formatFileType(row.name) }}</span>
            <span class="meta-size">{{ formatFileSize(row.content) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-time">{{ Common.dataTimeToLocal(row.id) }}</span>
          </div>
          <div class="meta-row">
            <span class="meta-crs">{{ row.crs || '未设置' }}</span>
          </div>
        </div>
      </template>
      <!-- 移除按钮：两端共用，阻止冒泡避免触发选中 -->
      <el-button
        v-if="removable !== false"
        class="history-item-remove"
        :class="{ 'is-mobile': isMobile }"
        :icon="Delete"
        circle
        size="small"
        type="danger"
        plain
        title="移除该历史数据"
        @click.stop="emit('remove', row)"
      />
    </div>
  </div>
</template>

<style scoped>
.history-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--el-bg-color);
  border-radius: 8px;
  border: 1px solid var(--el-border-color-lighter);
  cursor: pointer;
  transition: all 0.2s;
}

.history-item:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-fill-color-light);
}

/* ===== 移除按钮：桌面端 hover 显现，移动端常显 ===== */
.history-item-remove {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.2s;
}

.history-item:hover .history-item-remove,
.history-item-remove.is-mobile {
  opacity: 1;
}

/* 移动端卡片更紧凑 */
.history-item.is-mobile {
  padding: 10px;
  gap: 10px;
  align-items: flex-start;
}

.history-item-index {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-family: 'SF Mono', 'Consolas', 'Menlo', 'Roboto Mono', monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}

/* 移动端编号缩小 */
.is-mobile .history-item-index {
  width: 28px;
  height: 28px;
  font-size: 11px;
}

/* ===== 名称和类型信息（两端共用） ===== */
.history-item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 移动端第一行：名称 + 格式标签 */
.history-item-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.3;
}

.history-item-name-row .history-item-name {
  flex: 1;
  min-width: 0;
  border-bottom: none;
  padding-bottom: 0;
}

.history-item-name {
  font-size: 14px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  color: var(--gis-text-primary);
}

.history-item.is-mobile .history-item-name {
  font-size: 12px;
  font-weight: 500;
}

/* ===== meta 行（类型 + 计数 + 其他信息） ===== */
.history-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  line-height: 1.2;
}

/* 移动端 meta 行：紧凑排列所有信息项 */
.is-mobile .history-item-meta {
  gap: 6px;
  flex-wrap: wrap;
}

.history-item-types {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.history-item-counts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
}

/* ===== 桌面端详细 meta：多行布局 ===== */
.history-item-desktop-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
  min-width: 160px;
  padding-left: 12px;
  border-left: 1px solid var(--el-border-color-lighter);
}

.history-item-desktop-meta .meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
  line-height: 1.2;
}

/* ===== 格式类型标签（两端共用） ===== */
.meta-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 3px;
  font-family: 'SF Mono', 'Consolas', 'Menlo', 'Roboto Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1;
  flex-shrink: 0;
}

/* 移动端格式标签更小 */
.is-mobile .meta-tag {
  height: 16px;
  font-size: 9px;
  padding: 0 4px;
}

.meta-tag-format {
  background: rgba(100, 116, 139, 0.15);
  color: #64748b;
}

/* ===== 文件大小、时间、坐标系（两端共用） ===== */
.meta-size,
.meta-time,
.meta-crs {
  font-family: 'SF Mono', 'Consolas', 'Menlo', 'Roboto Mono', monospace;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}

.meta-size {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.meta-time {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.meta-crs {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* 移动端 meta 信息项更小 */
.is-mobile .meta-size,
.is-mobile .meta-time,
.is-mobile .meta-crs {
  font-size: 10px;
}

/* ===== 计数胶囊（两端共用） ===== */
.count-capsule {
  display: inline-flex;
  align-items: center;
  height: 16px;
  border-radius: 8px;
  overflow: hidden;
  font-family: 'SF Mono', 'Consolas', 'Menlo', 'Roboto Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.count-capsule-left {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 22px;
  padding: 0 5px;
  background: rgba(37, 99, 235, 0.15);
  color: #2563eb;
  text-align: right;
}

.count-capsule-right {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 22px;
  padding: 0 5px;
  background: rgba(22, 163, 74, 0.15);
  color: #16a34a;
  text-align: right;
}
</style>
