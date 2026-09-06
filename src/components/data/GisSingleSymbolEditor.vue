<script setup lang="ts">
/**
 * @file 单值符号化编辑器
 * @description 单个符号样式的编辑表单，是被复用的「单一符号化界面」：
 *              - 单一符号化：编辑整体样式
 *              - 分类符号化：在某个唯一值的弹框中编辑该唯一值的样式
 *              包含基础三项（填充颜色/边框颜色/边框尺寸）与扩展项
 *              （整体透明度/点形状/点尺寸/线型/标注文字）。
 *              实现要点：内部维护本地草稿副本（不直接改 props），
 *              任何改动即时 emit update:modelValue 由父级写回，
 *              避免直接修改 props 对象导致的控件不生效问题；
 *              所有颜色统一以 rgba 展示与落库。
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-09-06
 */
import { computed, reactive, watch } from 'vue'
import type { LabelStyle, LineDash, PointShape, SymbolStyle } from '~/components/data/symbolization'
import {
  DEFAULT_SYMBOL_EXTRAS,
  normalizeSymbolStyle,
  toRgba,
} from '~/components/data/symbolization'
import GisSymbolPreview from '~/components/data/GisSymbolPreview.vue'

const props = defineProps<{
  /** 初始样式（仅用于初始化本地草稿） */
  modelValue: SymbolStyle
  /** 可选的属性字段列表（用于标注字段下拉） */
  fields?: string[]
  /** 开启标注时优先使用的字段（分类符号化下为分类字段） */
  defaultField?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [SymbolStyle]
}>()

// 本地草稿：深拷贝 + 补齐扩展项，后续所有控件都绑定到草稿
const draft = reactive<SymbolStyle>(
  normalizeSymbolStyle({
    ...props.modelValue,
    label: { ...(props.modelValue.label ?? DEFAULT_SYMBOL_EXTRAS.label) },
  } as SymbolStyle),
)

// 草稿任何变化都同步给父级（父级负责写回真实对象）
watch(
  draft,
  () => {
    emit('update:modelValue', {
      ...draft,
      label: { ...(draft.label as LabelStyle) },
    })
  },
  { deep: true },
)

/** 标注子对象（草稿已保证存在） */
const lb = computed(() => draft.label as LabelStyle)

// 可选字段用可写 computed 兜底，避免 undefined 进入控件
const opacity = computed({
  get: () => draft.opacity ?? 1,
  set: (v: number) => { draft.opacity = v },
})
const pointShape = computed({
  get: () => draft.pointShape || 'circle',
  set: (v: PointShape) => { draft.pointShape = v },
})
const pointSize = computed({
  get: () => draft.pointSize ?? 8,
  set: (v: number) => { draft.pointSize = v },
})
const lineDash = computed({
  get: () => draft.lineDash || 'solid',
  set: (v: LineDash) => { draft.lineDash = v },
})

const opacityText = computed(() => `${Math.round(opacity.value * 100)}%`)
// 界面统一以 rgba 展示颜色
const fillText = computed(() => toRgba(draft.fillColor))
const strokeText = computed(() => toRgba(draft.strokeColor))

const shapeOptions: { label: string; value: PointShape }[] = [
  { label: '圆形', value: 'circle' },
  { label: '方形', value: 'square' },
  { label: '三角形', value: 'triangle' },
  { label: '星形', value: 'star' },
  { label: '十字', value: 'cross' },
]

const dashOptions: { label: string; value: LineDash }[] = [
  { label: '实线', value: 'solid' },
  { label: '虚线', value: 'dash' },
  { label: '点线', value: 'dot' },
]

/** 颜色统一转 rgba 后写入草稿 */
function onColorPick(value: string | null, key: 'fillColor' | 'strokeColor') {
  if (value) draft[key] = toRgba(value)
}
function onLabelColorPick(value: string | null) {
  if (value) lb.value.color = toRgba(value)
}

/** 开启标注时，若未选字段则默认取分类字段（无则取第一个可用字段） */
function onLabelToggle(enabled: boolean) {
  if (enabled && !lb.value.field) {
    const fallback = props.defaultField || props.fields?.[0] || ''
    if (fallback) lb.value.field = fallback
  }
}
</script>

<template>
  <div class="sym-editor">
    <!-- 预览：跟随草稿实时变化 -->
    <div class="ed-top">
      <gis-symbol-preview :style="draft" size="lg" />
      <span class="ed-tip">设置即时反映在预览中</span>
    </div>

    <!-- 基础三项 -->
    <div class="sym-row">
      <span class="sym-label">填充颜色</span>
      <el-color-picker
        :model-value="draft.fillColor"
        show-alpha
        size="small"
        @update:model-value="(v: string) => { draft.fillColor = v }"
        @change="(v: string | null) => onColorPick(v, 'fillColor')"
      />
      <span class="sym-value">{{ fillText }}</span>
    </div>
    <div class="sym-row">
      <span class="sym-label">边框颜色</span>
      <el-color-picker
        :model-value="draft.strokeColor"
        show-alpha
        size="small"
        @update:model-value="(v: string) => { draft.strokeColor = v }"
        @change="(v: string | null) => onColorPick(v, 'strokeColor')"
      />
      <span class="sym-value">{{ strokeText }}</span>
    </div>
    <div class="sym-row">
      <span class="sym-label">边框尺寸</span>
      <el-input-number v-model="draft.strokeWidth" :min="0" :max="20" :step="0.5" :precision="1" size="small" />
      <span class="sym-unit">px</span>
    </div>

    <el-divider content-position="left" class="ed-div">扩展样式</el-divider>

    <!-- 扩展项 -->
    <div class="sym-row">
      <span class="sym-label">整体透明度</span>
      <el-slider v-model="opacity" :min="0" :max="1" :step="0.05" class="op-slider" />
      <span class="sym-unit">{{ opacityText }}</span>
    </div>
    <div class="sym-row">
      <span class="sym-label">点形状</span>
      <el-select v-model="pointShape" size="small" class="ed-sel">
        <el-option v-for="o in shapeOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
      <span class="sym-label alt">点尺寸</span>
      <el-input-number v-model="pointSize" :min="0" :max="40" :step="1" size="small" class="ed-num" />
      <span class="sym-unit">px</span>
    </div>
    <div class="sym-row">
      <span class="sym-label">线型</span>
      <el-select v-model="lineDash" size="small" class="ed-sel">
        <el-option v-for="o in dashOptions" :key="o.value" :label="o.label" :value="o.value" />
      </el-select>
    </div>

    <el-divider content-position="left" class="ed-div">标注文字</el-divider>

    <!-- 标注 -->
    <div class="sym-row">
      <span class="sym-label">显示标注</span>
      <el-switch v-model="lb.enabled" size="small" @change="onLabelToggle" />
      <span class="sym-hint">把属性值显示在要素上</span>
    </div>
    <template v-if="lb.enabled">
      <div class="sym-row">
        <span class="sym-label">标注字段</span>
        <el-select v-model="lb.field" size="small" placeholder="选择字段" class="ed-sel">
          <el-option v-for="f in fields || []" :key="f" :label="f" :value="f" />
        </el-select>
      </div>
      <div class="sym-row">
        <span class="sym-label">文字颜色</span>
        <el-color-picker
          :model-value="lb.color"
          size="small"
          @update:model-value="(v: string) => { lb.color = v }"
          @change="onLabelColorPick"
        />
        <span class="sym-value">{{ lb.color }}</span>
        <span class="sym-label alt">字号</span>
        <el-input-number v-model="lb.size" :min="8" :max="48" :step="1" size="small" class="ed-num" />
        <span class="sym-unit">px</span>
        <span class="sym-label alt">描白边</span>
        <el-switch v-model="lb.halo" size="small" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.sym-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
.ed-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ed-tip {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}
.sym-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sym-label {
  font-size: 13px;
  color: var(--el-text-color-regular);
  min-width: 64px;
}
.sym-label.alt {
  min-width: auto;
  color: var(--el-text-color-secondary);
}
.sym-value {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-family: monospace;
  word-break: break-all;
}
.sym-unit,
.sym-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.op-slider {
  flex: 1;
  min-width: 120px;
}
.ed-sel {
  flex: 1;
  min-width: 0;
  max-width: 160px;
}
.ed-num {
  width: 96px;
}
.ed-div {
  margin: 4px 0;
}
.ed-div :deep(.el-divider__text) {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
