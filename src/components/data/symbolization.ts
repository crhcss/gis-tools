/**
 * @file 图斑符号化配置与样式构建
 * @description 定义要素符号化（单一/分类）的配置模型，并提供将配置转换为 OpenLayers
 *              样式函数（StyleLike）的能力。符号化依据图斑类型（属性字段）设置
 *              填充颜色、边框颜色、边框尺寸，以及标注文字、点形状、线型、整体透明度等样式。
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-09-06
 */
import { Circle, Fill, RegularShape, Stroke, Style, Text } from 'ol/style'
import type { FeatureLike } from 'ol/Feature'

/** 点要素符号形状 */
export type PointShape = 'circle' | 'square' | 'triangle' | 'star' | 'cross'

/** 线要素线型 */
export type LineDash = 'solid' | 'dash' | 'dot'

/** 标注文字设置（在要素上显示某个属性字段的文字） */
export interface LabelStyle {
  /** 是否显示标注 */
  enabled: boolean
  /** 标注使用的属性字段名 */
  field: string
  /** 文字颜色 */
  color: string
  /** 字号（px） */
  size: number
  /** 是否描白边（提升底图对比度） */
  halo: boolean
}

/** 单一图斑的样式（填充 / 边框 / 边框尺寸 / 额外样式项） */
export interface SymbolStyle {
  /** 填充颜色，CSS 颜色字符串（可含 alpha），点/面生效 */
  fillColor: string
  /** 边框颜色，CSS 颜色字符串，线/面描边与点描边生效 */
  strokeColor: string
  /** 边框尺寸（像素） */
  strokeWidth: number
  /** 整体透明度 0~1（叠加在颜色自身 alpha 之上，同时作用于填充与边框） */
  opacity?: number
  /** 点符号形状，仅点要素生效 */
  pointShape?: PointShape
  /** 点符号半径（像素），仅点要素生效 */
  pointSize?: number
  /** 线型（实线/虚线/点线），线要素与面/点的描边生效 */
  lineDash?: LineDash
  /** 标注文字设置 */
  label?: LabelStyle
}

/** 单一符号化：所有要素使用同一套样式 */
export interface SingleSymbolization extends SymbolStyle {
  mode: 'single'
}

/** 分类条目：某个字段值对应的样式 */
export interface CategoryItem extends SymbolStyle {
  /** 字段值（序列化字符串） */
  value: string
  /** 显示名称（列表/图例展示用，默认与 value 相同） */
  title: string
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

/** 白色描边（用于面/线外描边、点描边与文字描边，提升对比度） */
const WHITE: [number, number, number, number] = [255, 255, 255, 1]

/** 默认点符号半径 */
const DEFAULT_POINT_SIZE = 8

/** 额外样式项的默认值（用于兼容旧配置 / 补齐缺失字段） */
export const DEFAULT_SYMBOL_EXTRAS: Required<Pick<SymbolStyle, 'opacity' | 'pointShape' | 'pointSize' | 'lineDash' | 'label'>> = {
  opacity: 1,
  pointShape: 'circle',
  pointSize: DEFAULT_POINT_SIZE,
  lineDash: 'solid',
  label: { enabled: false, field: '', color: '#1f2937', size: 12, halo: true },
}

/**
 * 用默认额外项补齐一个可能不完整的样式（旧配置兼容）
 */
export function normalizeSymbolStyle<S extends SymbolStyle>(style: S): S {
  const s = style as SymbolStyle
  if (s.opacity === undefined) s.opacity = DEFAULT_SYMBOL_EXTRAS.opacity
  if (s.pointShape === undefined) s.pointShape = DEFAULT_SYMBOL_EXTRAS.pointShape
  if (s.pointSize === undefined) s.pointSize = DEFAULT_SYMBOL_EXTRAS.pointSize
  if (s.lineDash === undefined) s.lineDash = DEFAULT_SYMBOL_EXTRAS.lineDash
  if (!s.label) s.label = { ...DEFAULT_SYMBOL_EXTRAS.label }
  return style
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function round3(n: number): number {
  return Number(n.toFixed(3))
}

/** HSL → RGB（h: 0~360，s/l: 0~1） */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [Math.round(hue(hh + 1 / 3) * 255), Math.round(hue(hh) * 255), Math.round(hue(hh - 1 / 3) * 255)]
}

/**
 * 把任意受支持的颜色值统一转换为 rgba() 字符串，用于界面统一展示与落库
 * 支持 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla()；
 * 具名颜色等无法解析的格式原样返回。
 */
export function toRgba(color: string): string {
  if (!color) return color
  const c = color.trim()

  // 十六进制
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) {
    let h = c.slice(1)
    if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('') + 'ff'
    else if (h.length === 4) h = h.slice(0, 3).split('').map((ch) => ch + ch).join('') + h[3] + h[3]
    else if (h.length === 6) h += 'ff'
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = parseInt(h.slice(6, 8), 16) / 255
    return `rgba(${r}, ${g}, ${b}, ${round3(a)})`
  }

  // rgb() / rgba()
  let m = c.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean)
    if (p.length >= 3) {
      const r = Math.round(parseFloat(p[0]) || 0)
      const g = Math.round(parseFloat(p[1]) || 0)
      const b = Math.round(parseFloat(p[2]) || 0)
      const a = p[3] !== undefined ? parseFloat(p[3]) : 1
      return `rgba(${r}, ${g}, ${b}, ${round3(a)})`
    }
  }

  // hsl() / hsla()
  m = c.match(/^hsla?\(([^)]+)\)$/i)
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean)
    if (p.length >= 3) {
      const h = parseFloat(p[0]) || 0
      const s = (parseFloat(p[1]) || 0) / 100
      const l = (parseFloat(p[2]) || 0) / 100
      const a = p[3] !== undefined ? parseFloat(p[3]) : 1
      const [r, g, b] = hslToRgb(h, s, l)
      return `rgba(${r}, ${g}, ${b}, ${round3(a)})`
    }
  }

  return color
}

/**
 * 把整体透明度叠加到颜色自身的 alpha 上
 * 支持 #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba() / hsl() / hsla()，
 * 其他格式（如具名颜色）无法解析时原样返回。
 */
export function applyOpacity(color: string, opacity: number): string {
  if (!color || opacity >= 1) return color
  const o = clamp01(opacity)
  const c = color.trim()

  // 十六进制
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c)) {
    let h = c.slice(1)
    if (h.length === 3 || h.length === 4) {
      const base = h.length === 3 ? h : h.slice(0, 3)
      h = base.split('').map((ch) => ch + ch).join('')
      if (c.length === 5) {
        // #rgba -> alpha 也展开
        const a = c.slice(4, 5)
        h += a + a
      }
    }
    if (h.length === 6) h += 'ff'
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    const a = parseInt(h.slice(6, 8), 16) / 255
    return `rgba(${r}, ${g}, ${b}, ${Number((a * o).toFixed(3))})`
  }

  // rgb() / rgba()
  let m = c.match(/^rgba?\(([^)]+)\)$/i)
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length >= 3) {
      const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${Number((a * o).toFixed(3))})`
    }
  }

  // hsl() / hsla()
  m = c.match(/^hsla?\(([^)]+)\)$/i)
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean)
    if (parts.length >= 3) {
      const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1
      return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${Number((a * o).toFixed(3))})`
    }
  }

  return color
}

/** 线型 → OL 的 lineDash 数组 */
function dashOf(style: SymbolStyle): number[] | undefined {
  const d = style.lineDash || 'solid'
  if (d === 'solid') return undefined
  const w = Math.max(0.5, style.strokeWidth)
  if (d === 'dash') return [w * 2.5, w * 2]
  if (d === 'dot') return [w * 0.5, w * 2]
  return undefined
}

/** 生成点符号 image（圆形用 Circle，其余用 RegularShape） */
function pointImage(style: SymbolStyle, radius: number, fill: Fill, stroke: Stroke) {
  const shape = style.pointShape || 'circle'
  switch (shape) {
    case 'square':
      return new RegularShape({ points: 4, radius, angle: Math.PI / 4, fill, stroke })
    case 'triangle':
      return new RegularShape({ points: 3, radius, angle: 0, fill, stroke })
    case 'star':
      return new RegularShape({ points: 5, radius, radius2: radius * 0.45, angle: 0, fill, stroke })
    case 'cross':
      return new RegularShape({ points: 4, radius, radius2: radius * 0.35, angle: 0, fill, stroke })
    case 'circle':
    default:
      return new Circle({ radius, fill, stroke })
  }
}

/** 生成标注文字样式（未启用或字段无值时返回 undefined） */
function labelStyleOf(style: SymbolStyle, feature: FeatureLike): Style | undefined {
  const L = style.label
  if (!L || !L.enabled || !L.field) return undefined
  const raw = feature.get(L.field)
  if (raw === undefined || raw === null || String(raw) === '') return undefined
  return new Style({
    text: new Text({
      text: String(raw),
      font: `${L.size}px sans-serif`,
      fill: new Fill({ color: L.color }),
      stroke: L.halo ? new Stroke({ color: WHITE, width: 2 }) : undefined,
      overflow: true,
    }),
  })
}

/**
 * 根据几何类型生成样式数组
 * - 面/圆：填充 + 白色外描边 + 彩色描边
 * - 线：白色外描边 + 彩色描边
 * - 点：点符号（形状/尺寸可配）+ 白色描边
 * - 任意几何：按需追加标注文字样式
 */
function makeStyles(feature: FeatureLike, style: SymbolStyle): Style[] {
  const o = style.opacity ?? 1
  const fillColor = applyOpacity(style.fillColor, o)
  const strokeColor = applyOpacity(style.strokeColor, o)
  const w = style.strokeWidth
  const dash = dashOf(style)

  const whiteStroke = (width: number) => new Stroke({ color: WHITE, width })
  const colorStroke = (width: number) => new Stroke({ color: strokeColor, width, lineDash: dash })

  const geomType = feature.getGeometry()?.getType()
  const styles: Style[] = []

  if (geomType === 'Polygon' || geomType === 'MultiPolygon' || geomType === 'Circle') {
    styles.push(new Style({ fill: new Fill({ color: fillColor }) }))
    // strokeWidth 为 0 时不渲染描边（白色外描边一并跳过）
    if (w > 0) {
      styles.push(new Style({ stroke: whiteStroke(w + 1) }))
      styles.push(new Style({ stroke: colorStroke(w) }))
    }
  } else if (geomType === 'LineString' || geomType === 'MultiLineString') {
    if (w > 0) {
      styles.push(new Style({ stroke: whiteStroke(w + 2) }))
      styles.push(new Style({ stroke: colorStroke(w) }))
    } else {
      // 线宽为 0 时线要素不可见，但仍返回一个样式避免 OL 回退默认
      styles.push(new Style({}))
    }
  } else if (geomType === 'Point' || geomType === 'MultiPoint') {
    const radius = style.pointSize ?? (w * 2 + 4)
    // 点尺寸为 0 时不渲染点符号
    if (radius > 0) {
      styles.push(
        new Style({
          image: pointImage(style, radius, new Fill({ color: fillColor }), new Stroke({ color: strokeColor, width: 1 })),
          zIndex: Infinity,
        }),
      )
    }
  } else {
    styles.push(new Style({}))
  }

  const lbl = labelStyleOf(style, feature)
  if (lbl) styles.push(lbl)

  return styles
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
    const style = normalizeSymbolStyle(config)
    return (feature: FeatureLike) => makeStyles(feature, style)
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
    return makeStyles(feature, normalizeSymbolStyle(style))
  }
}

/**
 * 由一组字段值生成分类配色（黄金角分割，色相均匀分布、对比明显）
 * 返回每个值的填充色（半透明）与边框色（实色），并附带额外样式项的默认值
 */
export function generateCategoryColors(values: string[]): SymbolStyle[] {
  const goldenAngle = 137.508
  return values.map((_, i) => {
    const hue = Math.round((i * goldenAngle) % 360)
    return {
      // 统一输出 rgba，保证界面显示与落库格式一致
      fillColor: toRgba(`hsla(${hue}, 65%, 55%, 0.55)`),
      strokeColor: toRgba(`hsl(${hue}, 70%, 45%)`),
      strokeWidth: 2,
      opacity: DEFAULT_SYMBOL_EXTRAS.opacity,
      pointShape: DEFAULT_SYMBOL_EXTRAS.pointShape,
      pointSize: DEFAULT_SYMBOL_EXTRAS.pointSize,
      lineDash: DEFAULT_SYMBOL_EXTRAS.lineDash,
      label: { ...DEFAULT_SYMBOL_EXTRAS.label },
    }
  })
}

/** 单色符号化默认配置 */
export const DEFAULT_SINGLE_SYMBOLIZATION: SingleSymbolization = {
  mode: 'single',
  fillColor: 'rgba(234, 88, 12, 0.15)',
  strokeColor: '#ea580c',
  strokeWidth: 2,
  opacity: DEFAULT_SYMBOL_EXTRAS.opacity,
  pointShape: DEFAULT_SYMBOL_EXTRAS.pointShape,
  pointSize: DEFAULT_SYMBOL_EXTRAS.pointSize,
  lineDash: DEFAULT_SYMBOL_EXTRAS.lineDash,
  label: { ...DEFAULT_SYMBOL_EXTRAS.label },
}

/** 分类符号化默认样式（未匹配值） */
export const DEFAULT_CATEGORY_STYLE: SymbolStyle = {
  fillColor: 'rgba(100, 116, 139, 0.15)',
  strokeColor: '#64748b',
  strokeWidth: 2,
  opacity: DEFAULT_SYMBOL_EXTRAS.opacity,
  pointShape: DEFAULT_SYMBOL_EXTRAS.pointShape,
  pointSize: DEFAULT_SYMBOL_EXTRAS.pointSize,
  lineDash: DEFAULT_SYMBOL_EXTRAS.lineDash,
  label: { ...DEFAULT_SYMBOL_EXTRAS.label },
}
