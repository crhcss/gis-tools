<script setup lang="ts">
/**
 * @file 图斑符号化设置对话框
 * @description 提供「单一符号化」与「分类符号化」两种模式的样式配置界面。
 *              - 单一：所有要素统一填充色 / 边框色 / 边框尺寸。
 *              - 分类：按图斑类型字段分组，逐类设置样式，未匹配值用默认样式。
 *              应用后回写 SymbolizationConfig 到数据集并触发地图重渲染。
 * @author yuanyu <yuanyu@supersupermap.com>
 * @date 2026-09-06
 */
import { computed, reactive, watch } from 'vue'
import { ElMessage } from 'element-plus'

import GisDataInfo from '~/components/data/GisDataInfo'
import {
  DEFAULT_CATEGORY_STYLE,
  DEFAULT_SINGLE_SYMBOLIZATION,
  generateCategoryColors,
  type CategorizedSymbolization,
  type SingleSymbolization,
  type SymbolizationConfig,
} from '~/components/data/symbolization'

const props = defineProps<{
  modelValue: boolean
  /** 打开时进入的符号化模式 */
  mode: 'single' | 'categorized'
  /** 当前数据集（用于提取字段与去重值） */
  data: GisDataInfo
  /** 已有配置（编辑时回显） */
  config: SymbolizationConfig | null
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  'apply': [config: SymbolizationConfig]
}>()

// 可选字段（所有要素属性键的并集）
const fields = computed<string[]>(() => {
  const set = new Set<string>()
  for (const f of props.data?.features || []) {
    if (f?.properties) {
      for (const k of Object.keys(f.properties)) set.add(k)
    }
  }
  return Array.from(set)
})

// 当前分类字段的去重值
const distinctValues = computed<string[]>(() => {
  const field = cat.field
  if (!field) return []
  const set = new Set<string>()
  for (const f of props.data?.features || []) {
    const v = f?.properties?.[field]
    if (v !== undefined && v !== null && v !== '') set.add(String(v))
  }
  return Array.from(set)
})

const single = reactive<SingleSymbolization>({ ...DEFAULT_SINGLE_SYMBOLIZATION })
const cat = reactive<CategorizedSymbolization>({
  mode: 'categorized',
  field: '',
  categories: [],
  defaultStyle: { ...DEFAULT_CATEGORY_STYLE },
})

// 打开时按现有配置初始化草稿
watch(() => props.modelValue, (open) => {
  if (!open) return
  if (props.mode === 'single') {
    Object.assign(single, props.config?.mode === 'single' ? props.config : DEFAULT_SINGLE_SYMBOLIZATION)
  } else {
    if (props.config?.mode === 'categorized') {
      cat.field = props.config.field
      cat.categories = props.config.categories.map(c => ({ ...c }))
      cat.defaultStyle = { ...props.config.defaultStyle }
    } else {
      cat.field = ''
      cat.categories = []
      cat.defaultStyle = { ...DEFAULT_CATEGORY_STYLE }
    }
  }
})

// 分类字段变化：按去重值重新生成分类（保留已有同值条目的样式）
function onFieldChange() {
  if (cat.field) {
    regenerateCategories()
  } else {
    cat.categories = []
  }
}

function regenerateCategories() {
  const palette = generateCategoryColors(distinctValues.value)
  const kept = new Map(cat.categories.map(c => [c.value, c]))
  cat.categories = distinctValues.value.map((v, i) => {
    const exist = kept.get(v)
    if (exist) return { ...exist }
    return {
      value: v,
      label: v,
      fillColor: palette[i].fillColor,
      strokeColor: palette[i].strokeColor,
      strokeWidth: 2,
    }
  })
}

function close() {
  emit('update:modelValue', false)
}

function handleApply() {
  if (props.mode === 'single') {
    emit('apply', { ...single })
  } else {
    if (!cat.field) {
      ElMessage.warning('请选择分类字段（图斑类型）')
      return
    }
    if (cat.categories.length === 0) {
      ElMessage.warning('当前字段无可用的分类值')
      return
    }
    emit('apply', {
      mode: 'categorized',
      field: cat.field,
      categories: cat.categories.map(c => ({ ...c })),
      defaultStyle: { ...cat.defaultStyle },
    })
  }
  close()
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="mode === 'single' ? '单一符号化' : '分类符号化'"
    width="580px"
    align-center
    top="6vh"
    :close-on-click-modal="false"
    class="symbolization-dialog"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <!-- 单一符号化 -->
    <div v-if="mode === 'single'" class="sym-body">
      <div class="sym-preview">
        <svg viewBox="0 0 120 80" width="120" height="80">
          <polygon
            points="20,60 40,20 80,15 100,55 55,70"
            :fill="single.fillColor"
            :stroke="single.strokeColor"
            :stroke-width="single.strokeWidth"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <div class="sym-form">
        <div class="sym-row">
          <span class="sym-label">填充颜色</span>
          <el-color-picker v-model="single.fillColor" show-alpha />
          <span class="sym-value">{{ single.fillColor }}</span>
        </div>
        <div class="sym-row">
          <span class="sym-label">边框颜色</span>
          <el-color-picker v-model="single.strokeColor" show-alpha />
          <span class="sym-value">{{ single.strokeColor }}</span>
        </div>
        <div class="sym-row">
          <span class="sym-label">边框尺寸</span>
          <el-input-number v-model="single.strokeWidth" :min="0.5" :max="20" :step="0.5" :precision="1" size="small" />
          <span class="sym-unit">px</span>
        </div>
      </div>
    </div>

    <!-- 分类符号化 -->
    <div v-else class="sym-body categorized">
      <div class="sym-row field-row">
        <span class="sym-label">分类字段</span>
        <el-select v-model="cat.field" size="small" placeholder="选择图斑类型字段" class="field-select" @change="onFieldChange">
          <el-option v-for="f in fields" :key="f" :label="f" :value="f" />
        </el-select>
        <span class="sym-hint">{{ distinctValues.length }} 个分类值</span>
      </div>

      <div v-if="cat.field" class="cat-list">
        <div v-for="(c, i) in cat.categories" :key="c.value" class="cat-row">
          <span class="cat-name" :title="c.value">{{ c.value }}</span>
          <el-color-picker v-model="c.fillColor" show-alpha size="small" />
          <el-color-picker v-model="c.strokeColor" show-alpha size="small" />
          <el-input-number v-model="c.strokeWidth" :min="0.5" :max="20" :step="0.5" :precision="1" size="small" class="cat-width" />
          <span class="cat-unit">px</span>
          <span class="cat-idx">{{ i + 1 }}</span>
        </div>
      </div>
      <div v-else class="cat-empty">请先选择分类字段</div>

      <el-divider>未匹配值默认样式</el-divider>
      <div class="sym-row">
        <span class="sym-label">填充颜色</span>
        <el-color-picker v-model="cat.defaultStyle.fillColor" show-alpha size="small" />
        <span class="sym-label">边框颜色</span>
        <el-color-picker v-model="cat.defaultStyle.strokeColor" show-alpha size="small" />
        <span class="sym-label">尺寸</span>
        <el-input-number v-model="cat.defaultStyle.strokeWidth" :min="0.5" :max="20" :step="0.5" :precision="1" size="small" class="cat-width" />
        <span class="cat-unit">px</span>
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="close">取消</el-button>
      <el-button type="primary" size="small" @click="handleApply">应用</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.sym-body {
  display: flex;
  gap: 16px;
  min-height: 180px;
}
.sym-body.categorized {
  flex-direction: column;
  gap: 8px;
}
.sym-preview {
  flex-shrink: 0;
  width: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  border: 1px solid var(--el-border-color-extra-light);
}
.sym-form {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 14px;
  justify-content: center;
}
.sym-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sym-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
  min-width: 64px;
}
.sym-value {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: monospace;
  word-break: break-all;
}
.sym-unit,
.cat-unit {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.field-select {
  flex: 1;
  min-width: 0;
}
.sym-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.cat-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 4px;
}
.cat-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.cat-row:last-child {
  border-bottom: none;
}
.cat-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat-width {
  width: 92px;
}
.cat-idx {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  width: 18px;
  text-align: right;
}
.cat-empty {
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  padding: 24px 0;
}
</style>
