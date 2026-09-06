<script setup lang="ts">
/**
 * @file 图斑符号化设置对话框
 * @description 提供「单一符号化」与「分类符号化」两种模式的样式配置界面。
 *              - 单一：所有要素统一使用一套样式（预览 + 单值编辑器）。
 *              - 分类：按图斑类型字段分组，列表仅显示「分类字段 + 预览效果」，
 *                      点击某一行的「设置」按钮，弹出独立对话框编辑该唯一值的样式
 *                      （复用同一个单值编辑器）；未匹配值默认样式同样弹框编辑。
 *              编辑器内部维护草稿并即时回写，本对话框负责把配置写回数据集。
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-09-06
 */
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'

import GisDataInfo from '~/components/data/GisDataInfo'
import GisSymbolPreview from '~/components/data/GisSymbolPreview.vue'
import GisSingleSymbolEditor from '~/components/data/GisSingleSymbolEditor.vue'
import {
  DEFAULT_CATEGORY_STYLE,
  DEFAULT_SINGLE_SYMBOLIZATION,
  generateCategoryColors,
  normalizeSymbolStyle,
  toRgba,
  type CategorizedSymbolization,
  type SingleSymbolization,
  type SymbolStyle,
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

/** 每次打开对话框递增，用于强制重建编辑器草稿（保证回显最新配置） */
const openSeq = ref(0)

/** 唯一值弹框：正在编辑的目标（null 表示未匹配值默认样式） */
const catEditVisible = ref(false)
const editingValue = ref<string | null>(null)
/** 打开弹框时的样式快照，用于「取消」还原 */
const editSnapshot = ref<SymbolStyle | null>(null)
/** 弹框内编辑器重建 key */
const editSeq = ref(0)

const editingTarget = computed<SymbolStyle | null>(() => {
  if (editingValue.value === null) return cat.defaultStyle
  return cat.categories.find((c) => c.value === editingValue.value) || null
})
const editingTitle = computed(() => (editingValue.value === null ? '未匹配值默认样式' : editingValue.value))

// 打开时按现有配置初始化草稿
watch(() => props.modelValue, (open) => {
  if (!open) return
  if (props.mode === 'single') {
    Object.assign(single, props.config?.mode === 'single' ? props.config : DEFAULT_SINGLE_SYMBOLIZATION)
    // 兼容旧配置：补齐透明度/点形状/线型/标注等扩展项
    normalizeSymbolStyle(single)
  } else {
    if (props.config?.mode === 'categorized') {
      cat.field = props.config.field
      cat.categories = props.config.categories.map((c) => ({ ...c, title: c.title ?? c.value }))
      cat.categories.forEach((c) => normalizeSymbolStyle(c))
      cat.defaultStyle = { ...props.config.defaultStyle }
      normalizeSymbolStyle(cat.defaultStyle)
    } else {
      cat.field = ''
      cat.categories = []
      cat.defaultStyle = { ...DEFAULT_CATEGORY_STYLE }
    }
    catEditVisible.value = false
    editingValue.value = null
  }
  // 递增以重建编辑器草稿，确保回显的是刚初始化的配置
  openSeq.value++
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
  const kept = new Map(cat.categories.map((c) => [c.value, c]))
  cat.categories = distinctValues.value.map((v, i) => {
    const exist = kept.get(v)
    if (exist) return { ...exist }
    return { value: v, title: v, ...palette[i] }
  })
}

/** 单值编辑器回写（单一符号化） */
function onSingleUpdate(v: SymbolStyle) {
  Object.assign(single, v)
}
/** 单值编辑器回写（分类符号化弹框内） */
function onCatEditorUpdate(v: SymbolStyle) {
  const t = editingTarget.value
  if (t) Object.assign(t, v)
}

/** 打开某个唯一值 / 默认样式的设置弹框 */
function openCatEditor(value: string | null) {
  const t = value === null ? cat.defaultStyle : cat.categories.find((c) => c.value === value)
  if (!t) return
  editingValue.value = value
  editSnapshot.value = JSON.parse(JSON.stringify(t))
  editSeq.value++
  catEditVisible.value = true
}

/** 取消：还原到打开弹框前的样式 */
function cancelCatEditor() {
  const t = editingTarget.value
  if (t && editSnapshot.value) {
    Object.assign(t, JSON.parse(JSON.stringify(editSnapshot.value)))
  }
  catEditVisible.value = false
}

function confirmCatEditor() {
  catEditVisible.value = false
}

function close() {
  emit('update:modelValue', false)
}

function handleApply() {
  if (props.mode === 'single') {
    // 拷贝一份，避免与编辑器草稿共享引用
    emit('apply', { ...single, label: single.label ? { ...single.label } : undefined })
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
      categories: cat.categories.map((c) => ({ ...c })),
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
    width="620px"
    align-center
    top="6vh"
    :close-on-click-modal="false"
    class="symbolization-dialog"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <!-- 单一符号化：预览 + 单值编辑器 -->
    <div v-if="mode === 'single'" class="sym-body">
      <gis-single-symbol-editor
        :key="`single-${openSeq}`"
        :model-value="single"
        :fields="fields"
        @update:model-value="onSingleUpdate"
      />
    </div>

    <!-- 分类符号化：字段 + 唯一值列表（预览 + 设置按钮） -->
    <div v-else class="sym-body categorized">
      <div class="sym-row field-row">
        <span class="sym-label">分类字段</span>
        <el-select
          v-model="cat.field"
          size="small"
          placeholder="选择图斑类型字段"
          class="field-select"
          @change="onFieldChange"
        >
          <el-option v-for="f in fields" :key="f" :label="f" :value="f" />
        </el-select>
        <span class="sym-hint">{{ distinctValues.length }} 个分类值</span>
      </div>

      <div v-if="cat.field" class="cat-list">
        <div v-for="c in cat.categories" :key="c.value" class="cat-item">
          <div class="cat-head">
            <gis-symbol-preview :style="c" size="sm" />
            <span class="cat-name" :title="c.value">{{ c.value }}</span>
            <span class="cat-color">{{ toRgba(c.fillColor) }}</span>
            <el-button size="small" text type="primary" @click="openCatEditor(c.value)">设置</el-button>
          </div>
        </div>
      </div>
      <div v-else class="cat-empty">请先选择分类字段</div>

      <el-divider>未匹配值默认样式</el-divider>
      <div class="cat-item">
        <div class="cat-head">
          <gis-symbol-preview :style="cat.defaultStyle" size="sm" />
          <span class="cat-name">未匹配值默认样式</span>
          <span class="cat-color">{{ toRgba(cat.defaultStyle.fillColor) }}</span>
          <el-button size="small" text type="primary" @click="openCatEditor(null)">设置</el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button size="small" @click="close">取消</el-button>
      <el-button type="primary" size="small" @click="handleApply">应用</el-button>
    </template>

    <!-- 唯一值样式设置弹框（复用单值编辑器） -->
    <el-dialog
      v-model="catEditVisible"
      :title="`符号设置 - ${editingTitle}`"
      width="560px"
      append-to-body
      top="8vh"
      :close-on-click-modal="false"
      class="cat-edit-dialog"
    >
      <gis-single-symbol-editor
        v-if="editingTarget"
        :key="`cat-${editSeq}`"
        :model-value="editingTarget"
        :fields="fields"
        :default-field="cat.field"
        @update:model-value="onCatEditorUpdate"
      />
      <template #footer>
        <el-button size="small" @click="cancelCatEditor">取消</el-button>
        <el-button type="primary" size="small" @click="confirmCatEditor">确定</el-button>
      </template>
    </el-dialog>
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
.sym-unit,
.sym-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.field-select {
  flex: 1;
  min-width: 0;
}
.cat-list {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 4px;
}
.cat-item {
  border-bottom: 1px solid var(--el-border-color-extra-light);
}
.cat-item:last-child {
  border-bottom: none;
}
.cat-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 4px;
  border-radius: 4px;
}
.cat-head:hover {
  background: var(--el-fill-color-light);
}
.cat-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cat-color {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: monospace;
  white-space: nowrap;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cat-empty {
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  padding: 24px 0;
}
</style>

<style>
/* 对话框内容过高时允许滚动 */
.symbolization-dialog .el-dialog__body {
  max-height: 62vh;
  overflow-y: auto;
}
</style>
