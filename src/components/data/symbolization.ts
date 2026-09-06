/**
 * @file 图斑符号化配置与样式构建
 * @description 定义要素符号化（单一/分类）的配置模型，并提供将配置转换为 OpenLayers
 *              样式函数（StyleLike）的能力。符号化依据图斑类型（属性字段）设置
 *              填充颜色、边框颜色、边框尺寸等样式。
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-09-06
 */
import { Circle, Fill, Stroke, Style } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'

/** 单一图斑的样式（填充 / 边框 / 边框尺寸） */
export interface SymbolStyle {
  /** 填充颜色，CSS 颜色字符串（可含 alpha），点/面生效 */
  fillColor: string
  /** 边框颜色，CSS 颜色字符串，线/面描边与点描边生效 */
  strokeColor: string
  /** 边框尺寸（像素） */
  strokeWidth: number
}

/** 单一符号化：所有要素使用同一套样式 */
export interface SingleSymbolization extends SymbolStyle {
  mode: 'single'
}

/** 分类条目：某个字段值对应的样式 */
export interface CategoryItem extends SymbolStyle {
  /** 字段值（序列化字符串） */
  value: string
  /** 显示名称（默认与 value 相同） */
  label: string
}

/** 分类符号化：按字段值分组着色，未匹配值使用默认样式 */
export interface CategorizedSymbolization {
  mode: 'categorized'
  /** 分类依据的字段名（图斑类型字段） */
  field: string
  /** 各字段值对应的样式 */
  categories: CategoryItem[]
  /** 未匹配到任何分类时的默认样式 */
  defaultStyle: SymbolStyle
}

/** 符号化配置（null 表示不符号化，使用默认样式） */
export type SymbolizationConfig = SingleSymbolization | CategorizedSymbolization

/** 白色描边（用于面/线外描边，提升对比度） */
const WHITE: [number, number, number, number] = [255, 255, 255, 1]

/**
 * 根据几何类型生成样式数组
 * - 面/圆：填充 + 白色外描边 + 彩色描边（与默认样式层次一致）
 * - 线：白色外描边 + 彩色描边
 * - 点：彩色圆点 + 白色描边
 */
function makeStyles(
  feature: FeatureLike,
  fillColor: string,
  strokeColor: string,
  strokeWidth: number,
): Style[] {
  const geomType = feature.getGeometry()?.getType()
  if (geomType === 'Polygon' || geomType === 'MultiPolygon' || geomType === 'Circle') {
    return [
      new Style({ fill: new Fill({ color: fillColor }) }),
      new Style({ stroke: new Stroke({ color: WHITE, width: strokeWidth + 1 }) }),
      new Style({ stroke: new Stroke({ color: strokeColor, width: strokeWidth }) }),
    ]
  }
  if (geomType === 'LineString' || geomType === 'MultiLineString') {
    return [
      new Style({ stroke: new Stroke({ color: WHITE, width: strokeWidth + 2 }) }),
      new Style({ stroke: new Stroke({ color: strokeColor, width: strokeWidth }) }),
    ]
  }
  if (geomType === 'Point' || geomType === 'MultiPoint') {
    return [
      new Style({
        image: new Circle({
          radius: strokeWidth * 2 + 4,
          fill: new Fill({ color: fillColor }),
          stroke: new Stroke({ color: WHITE, width: 1 }),
        }),
        zIndex: Infinity,
      }),
    ]
  }
  return [new Style({})]
}

/**
 * 由符号化配置构建 OL 样式函数（StyleLike）
 * @param config 符号化配置；undefined / null 时返回 undefined（调用方应使用默认样式）
 */
export function buildSymbolizationStyleFunction(
  config: SymbolizationConfig | null | undefined,
): ((feature: FeatureLike) => Style[]) | undefined {
  if (!config) return undefined

  if (config.mode === 'single') {
    const { fillColor, strokeColor, strokeWidth } = config
    return (feature: FeatureLike) => makeStyles(feature, fillColor, strokeColor, strokeWidth)
  }

  // 分类符号化：按字段值查表
  const field = config.field
  const table = new Map<string, SymbolStyle>()
  for (const c of config.categories) {
    table.set(String(c.value), c)
  }
  const defaultStyle = config.defaultStyle
  return (feature: FeatureLike) => {
    const raw = feature.get(field)
    const style = raw === undefined || raw === null ? defaultStyle : (table.get(String(raw)) ?? defaultStyle)
    return makeStyles(feature, style.fillColor, style.strokeColor, style.strokeWidth)
  }
}

/**
 * 由一组字段值生成分类配色（黄金角分割，色相均匀分布、对比明显）
 * 返回每个值的填充色（半透明）与边框色（实色）
 */
export function generateCategoryColors(values: string[]): SymbolStyle[] {
  const goldenAngle = 137.508
  return values.map((_, i) => {
    const hue = Math.round((i * goldenAngle) % 360)
    return {
      fillColor: `hsla(${hue}, 65%, 55%, 0.55)`,
      strokeColor: `hsl(${hue}, 70%, 45%)`,
      strokeWidth: 2,
    }
  })
}

/** 单色符号化默认配置 */
export const DEFAULT_SINGLE_SYMBOLIZATION: SingleSymbolization = {
  mode: 'single',
  fillColor: 'rgba(234, 88, 12, 0.15)',
  strokeColor: '#ea580c',
  strokeWidth: 2,
}

/** 分类符号化默认样式（未匹配值） */
export const DEFAULT_CATEGORY_STYLE: SymbolStyle = {
  fillColor: 'rgba(100, 116, 139, 0.15)',
  strokeColor: '#64748b',
  strokeWidth: 2,
}
