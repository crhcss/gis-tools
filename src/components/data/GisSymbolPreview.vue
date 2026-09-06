<script setup lang="ts">
/**
 * @file 符号样式 SVG 预览
 * @description 依据 SymbolStyle 渲染一个等效的预览图，用于单一符号化与
 *              分类符号化的每个唯一值，直观反映填充色、边框色与尺寸、
 *              线型（虚线/点线）、点符号形状以及标注文字。
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-09-06
 */
import { computed } from 'vue'
import type { SymbolStyle } from '~/components/data/symbolization'

const props = withDefaults(
  defineProps<{
    /** 待预览的样式 */
    style: SymbolStyle
    /** 尺寸：lg 用于对话框主预览，sm 用于列表行内缩略预览 */
    size?: 'lg' | 'sm'
  }>(),
  { size: 'lg' },
)

/** 面要素示意多边形 */
const polyPoints = '10,60 28,22 62,18 78,52 44,68'

/** 点符号中心与半径 */
const mx = 100
const my = 60
const mr = 9

const shape = computed(() => props.style.pointShape || 'circle')

/** 整体透明度叠加到预览色（与渲染器保持一致） */
const fill = computed(() => props.style.fillColor)
const stroke = computed(() => props.style.strokeColor)
const width = computed(() => props.style.strokeWidth)
const dash = computed(() => {
  const d = props.style.lineDash || 'solid'
  if (d === 'dash') return '6 4'
  if (d === 'dot') return '2 3'
  return undefined
})

/** 三角形点符号顶点 */
const trianglePoints = computed(() => {
  const pts: string[] = []
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 3
    pts.push(`${(mx + mr * Math.cos(a)).toFixed(2)},${(my + mr * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
})

/** 星形点符号顶点 */
const starPoints = computed(() => {
  const pts: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? mr : mr * 0.45
    const a = -Math.PI / 2 + (i * Math.PI) / 5
    pts.push(`${(mx + r * Math.cos(a)).toFixed(2)},${(my + r * Math.sin(a)).toFixed(2)}`)
  }
  return pts.join(' ')
})

/** 十字点符号路径 */
const crossPath = computed(() => {
  const t = mr * 0.32
  return [
    `M ${mx - t} ${my - mr}`,
    `L ${mx + t} ${my - mr}`,
    `L ${mx + t} ${my - t}`,
    `L ${mx + mr} ${my - t}`,
    `L ${mx + mr} ${my + t}`,
    `L ${mx + t} ${my + t}`,
    `L ${mx + t} ${my + mr}`,
    `L ${mx - t} ${my + mr}`,
    `L ${mx - t} ${my + t}`,
    `L ${mx - mr} ${my + t}`,
    `L ${mx - mr} ${my - t}`,
    `L ${mx - t} ${my - t}`,
    'Z',
  ].join(' ')
})

const label = computed(() => props.style.label)
const labelEnabled = computed(() => !!label.value?.enabled && !!label.value?.field)
const labelText = computed(() => {
  const f = label.value?.field || ''
  return f.length > 4 ? `${f.slice(0, 4)}…` : f || '标注'
})
const labelFontSize = computed(() => Math.min(Math.max(label.value?.size || 12, 8), 18))
</script>

<template>
  <div class="sym-preview" :class="size">
    <svg viewBox="0 0 120 80" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width="120" height="80" class="pv-bg" />

      <!-- 面/线示意：填充 + 边框（虚线体现线型） -->
      <polygon
        :points="polyPoints"
        :fill="fill"
        :stroke="stroke"
        :stroke-width="width"
        :stroke-dasharray="dash"
        stroke-linejoin="round"
      />

      <!-- 点符号形状 -->
      <g>
        <circle v-if="shape === 'circle'" :cx="mx" :cy="my" :r="mr" :fill="fill" :stroke="stroke" stroke-width="1" />
        <rect
          v-else-if="shape === 'square'"
          :x="mx - mr"
          :y="my - mr"
          :width="mr * 2"
          :height="mr * 2"
          :fill="fill"
          :stroke="stroke"
          stroke-width="1"
        />
        <polygon
          v-else-if="shape === 'triangle'"
          :points="trianglePoints"
          :fill="fill"
          :stroke="stroke"
          stroke-width="1"
        />
        <polygon v-else-if="shape === 'star'" :points="starPoints" :fill="fill" :stroke="stroke" stroke-width="1" />
        <path v-else-if="shape === 'cross'" :d="crossPath" :fill="fill" :stroke="stroke" stroke-width="1" />
      </g>

      <!-- 标注文字（白色描边提升对比度） -->
      <text
        v-if="labelEnabled"
        x="60"
        y="44"
        text-anchor="middle"
        dominant-baseline="middle"
        :fill="label?.color"
        :font-size="labelFontSize"
        :stroke="label?.halo ? '#ffffff' : undefined"
        :stroke-width="label?.halo ? 2 : undefined"
        paint-order="stroke"
        font-family="sans-serif"
      >
        {{ labelText }}
      </text>
    </svg>
  </div>
</template>

<style scoped>
.sym-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-extra-light);
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}
.sym-preview.lg {
  width: 140px;
  height: 94px;
}
.sym-preview.sm {
  width: 46px;
  height: 32px;
}
.sym-preview svg {
  width: 100%;
  height: 100%;
  display: block;
}
.pv-bg {
  fill: var(--el-bg-color-overlay);
}
</style>
