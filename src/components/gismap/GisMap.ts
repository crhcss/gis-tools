/**
 * @file GisMap core class
 * @description The main OpenLayers-based map class providing feature management, layer control,
 *              draw/modify interactions, coordinate transformation, styling, and event dispatch.
 *              Serves as the central map engine for the GIS Tools application.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2024-08-06
 */
import "ol/ol.css";
import {Map as olMap, View as olView} from "ol";
import Feature from "ol/Feature";
import {applyTransform} from 'ol/extent';
import GeoJSON from 'ol/format/GeoJSON';
import type Geometry from "ol/geom/Geometry";
import LineString from "ol/geom/LineString";
import MultiLineString from "ol/geom/MultiLineString";
import MultiPoint from "ol/geom/MultiPoint";
import MultiPolygon from "ol/geom/MultiPolygon";
import Point from "ol/geom/Point";
import Polygon from "ol/geom/Polygon";
import {Draw, Interaction, Modify, Snap} from "ol/interaction";
import type BaseLayer from "ol/layer/Base";
import {fromLonLat, get as getProjection, getTransform} from "ol/proj";
import {Circle, Fill, Stroke, Style, Text} from "ol/style";
import type {StyleLike} from "ol/style/Style";
import {isRef, Ref, toValue} from "vue";

import Common from "~/common/Common";
import GeomUtils from "~/common/GeomUtils";
import {logger} from "~/common/logger";
import createDefaultStyle from "~/components/gismap/styles/DefaultStyle";
import {eventBus} from "~/composables/eventBus";
import EventBase from "~/event/EventBase";


import MapHelper from "./MapHelper";
import {getBasemapService} from "./basemapConfig";
import {getChinaBoundaryImage} from "./data/chinaBoundaryCache";
import {GisMapDrawEndEvent, GisMapNotifyEvent, GisMapModifyChangeEvent} from "./events/GisMapEvents";
import {TianDiTuGisMapLayer, GisMapLayer, SysGisMapLayer, GisLayerOption, ImageGisMapLayer} from "./layer/GisLayer";
import GisStyle from "./styles/GisStyle";
import {buildTianDiTuLayerUrl, getTianDiTuProjSuffix} from "./tiandituConfig";


export const DefaultLayerNames = {
    SYS_DRAW_TOOL_ACTION: "sys-draw-tool-action",
    SYS_DRAW_TOOL_DISPLAY: "sys-draw-tool-display",
    USER_DRAW: "user-draw",
    USER_TEMP: "user-temp",
    SYS_TEMP_FLASH: "sys-temp-flash",
    /** 输入数据源：导入/绘制的原始数据 */
    VECTOR_INPUT: "vector-input",
    /** 编辑数据源：节点编辑的变更要素 */
    VECTOR_EDIT: "vector-edit",
    /** 操作数据源：分割线、裁剪面等临时操作 */
    VECTOR_OPERATION: "vector-operation",
    /** 影子数据源：对照参考、编辑影子 */
    VECTOR_SHADOW: "vector-shadow",
    /** 标识数据源：坐标系范围等标识 */
    VECTOR_MARKER: "vector-marker",
    SYS_EDIT_SNAP: "sys-edit-snap",
    /** 编辑参考数据源：节点编辑时对照显示原始要素 */
    SYS_EDIT_REF: "sys-edit-ref",
    SYS_TIANDITU: "sys-tianditu",
    SYS_TIANDITU_VEC: "sys-tianditu-vec",
    SYS_TIANDITU_IMG: "sys-tianditu-img",
    SYS_TIANDITU_TER: "sys-tianditu-ter",
}

/** 固定矢量数据源 zIndex 定义（从下到上，基数100方便扩展）
 *  MARKER(0) → INPUT(100) → SHADOW(200) → SYS_EDIT_REF(300) → EDIT(400) → OPERATION(1000)
 *  - 正常浏览：INPUT + SHADOW叠加（影子在原始数据之上）
 *  - 要素列表：SHADOW(对照) + EDIT(变更)，变更为主
 *  - 节点编辑：SHADOW + SYS_EDIT_REF(当前要素参考) + EDIT + OPERATION(顶点编号)
 */
export const VectorLayerZIndex = {
    VECTOR_MARKER: 0,
    VECTOR_INPUT: 100,
    VECTOR_SHADOW: 200,
    VECTOR_EDIT: 400,
    VECTOR_OPERATION: 1000,
}

export interface GisMapOption {
    center?: number[];
    zoom?: number;
    rotation?: number;
    projection: string | number;
}

export class GisMap extends EventBase {

    private readFeaturesFromGeoJSON(features: GeoJSON.Feature[]): Feature<Geometry>[] {
        const formatter = new GeoJSON();
        const viewProj = this.olView?.getProjection().getCode();
        // GeoJSON 标准规定坐标为 EPSG:4326，但本系统保留原始投影坐标
        // 当视图为地理坐标系时，数据来自标准 GeoJSON，使用 featureProjection 重投影
        // 当视图为投影坐标系时，数据坐标已在投影坐标系中，dataProjection=featureProjection 表示无需转换
        const isGeoView = viewProj === 'EPSG:4326' || viewProj === 'EPSG:4490';
        const readOptions = isGeoView
            ? { featureProjection: viewProj }
            : { dataProjection: viewProj, featureProjection: viewProj };
        return features.map(f => formatter.readFeature(f, readOptions)) as Feature<Geometry>[];
    }
    gisMapId: string;
    mapName: string;
    mapTargetElement: HTMLElement;
    olMap?: olMap;
    olView?: olView;
    baseLayers: GisMapLayer[] = []
    userLayers: GisMapLayer[] = [];
    sysLayers: GisMapLayer[] = [];
    interactionMap: Map<string, Interaction> = new Map();
    private cleanupFunctions: Array<() => void> = [];

    constructor(mapName: string, mapTarget: string | HTMLElement) {
        super();
        this.gisMapId = Common.uuid();
        this.mapName = mapName;
        if (typeof mapTarget === 'string') {
            const el = document.getElementById(mapTarget)
            if (el) {
                this.mapTargetElement = el;
            } else {
                throw new Error(`mapTargetElement is not found by id:${mapTarget}`);
            }
        } else if (mapTarget instanceof HTMLElement) {
            this.mapTargetElement = mapTarget;
        } else {
            throw new Error("mapTarget must be HTMLElement or string");
        }
    }

    init(options?: GisMapOption) {
        this.olMap = MapHelper.newOlMapInstance(this.mapTargetElement, options)
        this.olView = this.olMap?.getView();
        this.addLayer(this.olMap, this.baseLayers)
        this.initVectorSources()
        // 暴露到window方便调试
        if (typeof window !== 'undefined') {
            (window as any).__olMap = this.olMap;
            (window as any).__gisMap = this;
            if (!(window as any).__gisMaps) (window as any).__gisMaps = {};
            (window as any).__gisMaps[this.gisMapId] = this;
        }
    }

    /**
     * 初始化5个固定矢量数据源，地图创建时即存在
     * zIndex 从下到上：标识(0) → 输入(1) → 编辑(2) → 操作(3) → 影子(4)
     */
    private initVectorSources() {
        const vectorDefs: Array<{name: string; zIndex: number; style: Style}> = [
            {
                name: DefaultLayerNames.VECTOR_MARKER,
                zIndex: VectorLayerZIndex.VECTOR_MARKER,
                style: new Style({
                    fill: new Fill({ color: 'rgba(200, 200, 200, 0.1)' }),
                    stroke: new Stroke({ color: 'rgba(180, 180, 180, 0.5)', width: 1, lineDash: [6, 4] }),
                    image: new Circle({ radius: 2, fill: new Fill({ color: 'rgba(180, 180, 180, 0.5)' }) }),
                }),
            },
            {
                name: DefaultLayerNames.VECTOR_INPUT,
                zIndex: VectorLayerZIndex.VECTOR_INPUT,
                style: new Style({
                    fill: new Fill({ color: 'rgba(64, 158, 255, 0.15)' }),
                    stroke: new Stroke({ color: '#409EFF', width: 2 }),
                    image: new Circle({ radius: 4, fill: new Fill({ color: '#409EFF' }), stroke: new Stroke({ color: '#fff', width: 1 }) }),
                }),
            },
            {
                name: DefaultLayerNames.VECTOR_EDIT,
                zIndex: VectorLayerZIndex.VECTOR_EDIT,
                style: new Style({
                    fill: new Fill({ color: 'rgba(64, 158, 255, 0.3)' }),
                    stroke: new Stroke({ color: '#409EFF', width: 2.5 }),
                    image: new Circle({ radius: 5, fill: new Fill({ color: '#409EFF' }), stroke: new Stroke({ color: '#fff', width: 2 }) }),
                }),
            },
            {
                name: DefaultLayerNames.SYS_EDIT_REF,
                zIndex: VectorLayerZIndex.VECTOR_SHADOW + 100,
                style: new Style({
                    fill: new Fill({ color: 'rgba(150, 150, 150, 0.2)' }),
                    stroke: new Stroke({ color: 'rgba(150, 150, 150, 0.4)', width: 2, lineDash: [6, 4] }),
                    image: new Circle({ radius: 3, fill: new Fill({ color: 'rgba(150, 150, 150, 0.2)' }), stroke: new Stroke({ color: 'rgba(150, 150, 150, 0.4)', width: 1 }) }),
                }),
            },
            {
                name: DefaultLayerNames.VECTOR_OPERATION,
                zIndex: VectorLayerZIndex.VECTOR_OPERATION,
                style: new Style({
                    fill: new Fill({ color: 'rgba(230, 162, 60, 0.2)' }),
                    stroke: new Stroke({ color: '#E6A23C', width: 2, lineDash: [8, 4] }),
                    image: new Circle({ radius: 4, fill: new Fill({ color: '#E6A23C' }), stroke: new Stroke({ color: '#fff', width: 1 }) }),
                }),
            },
            {
                name: DefaultLayerNames.VECTOR_SHADOW,
                zIndex: VectorLayerZIndex.VECTOR_SHADOW,
                style: new Style({
                    fill: new Fill({ color: 'rgba(150, 150, 150, 0.25)' }),
                    stroke: new Stroke({ color: 'rgba(100, 100, 100, 0.5)', width: 2, lineDash: [6, 4] }),
                    image: new Circle({ radius: 3, fill: new Fill({ color: 'rgba(150, 150, 150, 0.3)' }), stroke: new Stroke({ color: 'rgba(100, 100, 100, 0.5)', width: 1 }) }),
                }),
            },
        ]
        vectorDefs.forEach(def => {
            const layer = new SysGisMapLayer({ name: def.name, zIndex: def.zIndex, style: def.style })
            layer.projection = this.olView?.getProjection().getCode()
            // 系统临时图层默认不可见，由具体功能按需显示
            if (def.name === DefaultLayerNames.SYS_EDIT_REF) {
                layer.layer?.setVisible(false)
            }
            this.sysLayers.push(layer)
            this.addLayer(this.olMap!, [layer])
        })
        logger.info('initVectorSources: 6 fixed vector sources initialized')
    }

    initMapPointermove(): void {
        const map = this.olMap;
        const defaultStyles = createDefaultStyle();
        const selectStyle = defaultStyles['select'];
        const textStyles: Style[] = defaultStyles['Text'];

        interface SelectableFeature extends Feature {
            setStyle(style?: Style | Style[]): void;
            get(key: string): unknown;
        }

        let selected: SelectableFeature | null = null;
        let curFeature: unknown = null;

        const pointerMoveHandler = (() => {
            let lastPixel: [number, number] | null = null;
            let rafId = 0;
            return (e: unknown) => {
                const event = e as { pixel: [number, number] };
                // 相同像素不重复处理
                if (lastPixel && lastPixel[0] === event.pixel[0] && lastPixel[1] === event.pixel[1]) return;
                lastPixel = event.pixel;
                // 用 RAF 节流，避免每帧多次查询
                cancelAnimationFrame(rafId);
                rafId = requestAnimationFrame(() => {
                    if (selected) {
                        selected.setStyle(undefined);
                        selected = null;
                    }
                    // 用 layerFilter 跳过坐标系范围框图层，避免遍历框内大量几何造成卡顿
                    map?.forEachFeatureAtPixel(event.pixel, (f) => {
                        const feature = f as SelectableFeature;
                        // 跳过坐标系范围框等非交互图层
                        if (feature.get('_crsExtentBox')) {
                            return false;
                        }
                        // 仅对显式标记 _selectable 的 feature 启用交互
                        // 默认 GeoJSON 等图层不参与 hover/高亮，需调用 enableFeatureSelect 显式启用
                        if (!feature.get('_selectable')) {
                            return false;
                        }
                        // 临时全局禁用所有要素交互，hover/选择/FeatureOver 都禁用
                        // 需要时注释掉该 return false 即可恢复
                        // return false;
                        if (selected !== feature) {
                            selected?.setStyle(undefined);
                            selected = feature;
                            const label = feature.get("label");
                            if (label !== undefined) {
                                const txtStyles = textStyles.map(x => x.clone());
                                txtStyles.forEach(s => s.getText()?.setText?.(`${label}`))
                                feature.setStyle([...selectStyle, ...txtStyles])
                            } else {
                                feature.setStyle(selectStyle)
                            }
                        }
                        return true;
                    }, {
                        // 跳过坐标系范围框图层
                        layerFilter: (layer) => {
                            return !layer.get('_crsExtentLayer');
                        }
                    });
                    if (curFeature !== selected) {
                        curFeature = selected;
                        this.dispatchEvent('FeatureOver', curFeature);
                    }
                });
            };
        })();

        map?.on('pointermove', pointerMoveHandler);

        this.cleanupFunctions.push(() => {
            map?.un('pointermove', pointerMoveHandler);
        });
    }

    /**
     * 启用要素长按检测（长按 500ms 触发 FeatureLongPress 事件）
     * 移动距离 >10px 自动取消（避免误触发）
     * 用于数据查看场景：长按要素显示属性气泡
     */
    initFeatureLongPress(): void {
        const map = this.olMap;
        if (!map) return;

        let longPressTimer: ReturnType<typeof setTimeout> | null = null;
        let startPixel: [number, number] | null = null;
        const LONG_PRESS_DURATION = 500;
        const MOVE_TOLERANCE = 10;

        const clearTimer = () => {
            if (longPressTimer !== null) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            startPixel = null;
        };

        const onPointerDown = (e: unknown) => {
            const event = e as { pixel: [number, number] };
            startPixel = event.pixel;
            longPressTimer = setTimeout(() => {
                longPressTimer = null;
                // 长按结束时查询当前像素下的要素
                map.forEachFeatureAtPixel(event.pixel, (f) => {
                    const feature = f as { get: (k: string) => unknown };
                    if (feature.get('_crsExtentBox')) return false;
                    if (!feature.get('_selectable')) return false;
                    // 派发 FeatureLongPress 事件，携带要素和像素位置
                    this.dispatchEvent('FeatureLongPress', { feature: f, pixel: event.pixel });
                    return true;
                }, {
                    layerFilter: (layer) => !layer.get('_crsExtentLayer'),
                });
            }, LONG_PRESS_DURATION);
        };

        const onPointerMove = (e: unknown) => {
            if (longPressTimer === null || startPixel === null) return;
            const event = e as { pixel: [number, number] };
            const dx = event.pixel[0] - startPixel[0];
            const dy = event.pixel[1] - startPixel[1];
            if (dx * dx + dy * dy > MOVE_TOLERANCE * MOVE_TOLERANCE) {
                clearTimer();
            }
        };

        // OL 事件类型不包含 pointerdown/up/drag，用 as 断言注册
        const mapWithEvents = map as unknown as {
            on: (type: string, listener: (e: unknown) => void) => void;
            un: (type: string, listener: (e: unknown) => void) => void;
        };
        mapWithEvents.on('pointerdown', onPointerDown);
        mapWithEvents.on('pointermove', onPointerMove);
        mapWithEvents.on('pointerup', clearTimer);
        mapWithEvents.on('pointerdrag', clearTimer);

        this.cleanupFunctions.push(() => {
            mapWithEvents.un('pointerdown', onPointerDown);
            mapWithEvents.un('pointermove', onPointerMove);
            mapWithEvents.un('pointerup', clearTimer);
            mapWithEvents.un('pointerdrag', clearTimer);
            clearTimer();
        });
    }

    /**
     * 启用 feature 的 pointermove 交互（hover 高亮、FeatureOver 事件）
     * 给图层的所有 feature 打上 _selectable 标记
     * @param layer OL 图层
     */
    enableFeatureSelect(layer: unknown): void {
        if (!layer) return;
        const l = layer as { getSource?: () => { getFeatures?: () => unknown[]; forEachFeature?: (cb: (f: unknown) => void) => void } | undefined };
        const source = l.getSource?.();
        if (!source) return;
        if (typeof source.forEachFeature === 'function') {
            source.forEachFeature((f: unknown) => {
                const feat = f as { set?: (k: string, v: unknown) => void; get?: (k: string) => unknown };
                if (typeof feat.set === 'function' && !feat.get?.('_selectable')) {
                    feat.set('_selectable', true);
                }
            });
        } else if (typeof source.getFeatures === 'function') {
            const feats = source.getFeatures() as unknown[];
            feats.forEach((f) => {
                const feat = f as { set?: (k: string, v: unknown) => void; get?: (k: string) => unknown };
                if (typeof feat.set === 'function' && !feat.get?.('_selectable')) {
                    feat.set('_selectable', true);
                }
            });
        }
    }

    getMap(): olMap | undefined {
        return this.olMap;
    }

    /**
     * 获取当前地图视图投影代码
     */
    getViewProjCode(): string {
        return this.olView?.getProjection().getCode() ?? 'EPSG:4490'
    }

    getMapOptions(gisMap: GisMap): GisMapOption | undefined {
        const map = gisMap.getMap();
        if (map) {
            return {
                center: map.getView().getCenter() ?? undefined,
                zoom: map.getView().getZoom() ?? undefined,
                rotation: map.getView().getRotation(),
                projection: map.getView().getProjection().getCode(),
            }
        }
    }

    addLayer(map: olMap, baseLayers: GisMapLayer[]) {
        baseLayers.forEach(lay => {
            const l = lay.init() as BaseLayer;
            map?.addLayer(l);
        });
    }

    saveMapStatusToLocal() {
        const conf = this.getMapOptions(this);
        if (conf) {
            Common.saveLocal(this.gisMapId, conf);
        }
    }

    /*
    loadMapStatusFromLocal() {
        if (this.olMap) {
            const mapStatus = Common.loadLocal("mapStatus") as { center: number[], zoom: number } | null;
            if (mapStatus) {
                const {center, zoom} = mapStatus;
                this.olMap.getView().setCenter(center);
                this.olMap.getView().setZoom(zoom);
            }
        }
    }
    */

    getLayerByName(name: string, options?: GisLayerOption): GisMapLayer {
        if (this.olMap) {
            let layer = this.sysLayers?.find(x => x.name === name) ||
                this.userLayers?.find(x => x.name === name) ||
                this.baseLayers.find(x => x.name === name)
            if (!layer) {
                const projection = this.olView?.getProjection().getCode();
                const newLayer = new SysGisMapLayer({...options, name: name})
                newLayer.projection = projection;
                this.sysLayers.push(newLayer);
                this.addLayer(this.olMap, [newLayer])
                return newLayer;
            }
            return layer;
        }
        throw new Error("olMap is not initialized");
    }

    drawTool(option: {
        type: ('Polygon' | 'Point' | 'LineString' | 'None'),
        cleanBefore?: Ref<boolean> | boolean,
        once?: Ref<boolean> | boolean,
        keep?: Ref<boolean> | boolean,
        allowHole?: Ref<boolean> | boolean,
    }) {
        if (!this.olMap) {
            return Promise.reject('olMap is not initialized');
        }

        const allowHole = toValue(option.allowHole === undefined ? true : option.allowHole);
        let once: boolean = toValue((option.once === undefined ? true : option.once));
        toValue(option.cleanBefore === undefined ? true : option.cleanBefore);
        const keep: boolean = toValue(option.keep === undefined ? true : option.keep);
        const drawType = option.type;
        if (drawType === 'Polygon' && allowHole) {
            once = false;
            if (isRef(option.once)) {
                option.once.value = false;
            }
        }

        let drawTool = this.interactionMap.get('draw-tool') as Draw;
        if (drawTool) {
            drawTool.abortDrawing();
            this.olMap?.removeInteraction(drawTool);
            this.interactionMap.delete('draw-tool');
        }

        const drawLayerAction: SysGisMapLayer = this.getLayerByName(DefaultLayerNames.SYS_DRAW_TOOL_ACTION) as SysGisMapLayer;
        const drawLayerDisplay: SysGisMapLayer = this.getLayerByName(DefaultLayerNames.SYS_DRAW_TOOL_DISPLAY) as SysGisMapLayer;

        if (drawType !== 'None') {
            drawTool = new Draw({
                source: drawLayerAction.source,
                type: drawType,
                style: GisStyle.getDrawHandleStyleFunction(),
            });

            drawTool.addEventListener('drawstart', (e) => {
                if (drawType === 'Polygon' && allowHole) {
                    if (isRef(option.once)) {
                        option.once.value = false;
                    }
                }
                const startPosition = (e as { feature?: { getGeometry?: () => { getFirstCoordinate?: () => number[] } } })
                    ?.feature?.getGeometry?.()?.getFirstCoordinate?.();
                if (startPosition) {
                    const point: GeoJSON.Point = {type: 'Point', coordinates: startPosition};
                    const source = drawLayerDisplay?.source;
                    if (source) {
                        for (let index = 0; index < drawLayerDisplay.features.length; index++) {
                            const fea = drawLayerDisplay.features[index] as unknown as Record<string, unknown>;
                            if (GeomUtils.intersects(fea.geometry as GeoJSON.Geometry, point)) {
                                drawTool.set('intersectId', fea.id);
                                break;
                            }
                        }
                    }
                }
            })

            drawTool.addEventListener('drawend', (e: unknown) => {
                let drawFeature: unknown = (e as { feature: unknown }).feature;
                const intersectId = drawTool.get("intersectId") as string | undefined;
                const displayLayer = this.getLayerByName(DefaultLayerNames.SYS_DRAW_TOOL_DISPLAY);
                this.cleanLayer(DefaultLayerNames.SYS_DRAW_TOOL_ACTION).then(() => {
                    if (drawType === 'Polygon') {
                        if (keep) {
                            if (displayLayer) {
                                if (intersectId && allowHole) {
                                    const overlayFeature = displayLayer.getJSONFeatureById?.(intersectId);
                                    const jsonFeature = GeomUtils.olFeatureToGeoJSON(drawFeature as GeoJSON.Feature);
                                    const newGeo = GeomUtils.difference(overlayFeature as unknown as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>, jsonFeature as unknown as GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>);
                                    displayLayer.removeFeatureById?.(intersectId);
                                    drawTool.set("intersectId", undefined)
                                    drawFeature = displayLayer.addFeature?.(newGeo as unknown as Feature);
                                } else {
                                    drawFeature = displayLayer.addFeature?.(drawFeature as unknown as Feature);
                                }
                            } else {
                                logger.error('displayLayer is not defined.');
                            }
                        }
                    } else {
                        // 非 Polygon 类型：keep=false 时不保留在 display 图层
                        if (keep) {
                            drawFeature = displayLayer.addFeature?.(drawFeature as unknown as Feature);
                        }
                    }
                    void eventBus.emit(this.mapName, new GisMapNotifyEvent({}, 'GisMap::drawTool::drawend', displayLayer, drawFeature));
                    // 不设 featureProjection，保持数据原始投影坐标（与 modifyend 行为一致）
                    // view 投影 = 数据集 CRS（R2 规则），输出坐标直接匹配数据集存储约定
                    const json = new GeoJSON().writeFeature(drawFeature as Feature, {
                        rightHanded: true,
                    });
                    void eventBus.emit(this.mapName, new GisMapDrawEndEvent(json))
                })
                if (once) {
                    this.olMap?.removeInteraction(drawTool);
                    this.interactionMap.delete('draw-tool');
                }
            })
            this.interactionMap.set('draw-tool', drawTool);
            this.olMap?.addInteraction(drawTool);
        }

        void eventBus.emit(this.mapName, new GisMapNotifyEvent({}, 'GisMap::drawTool', option));
    }

    cleanLayer(layerName: string): Promise<void> {
        return new Promise(resolve => {
            setTimeout(() => {
                const curLayer: GisMapLayer | undefined = this.getLayerByName(layerName) as GisMapLayer;
                if (curLayer) {
                    curLayer.clear();
                }
                void eventBus.emit(this.mapName, new GisMapNotifyEvent({}, 'GisMap::cleanSource', curLayer));
                resolve();
            }, 0);

        });
    }

    /**
     * 设置图层可见性
     */
    setLayerVisibility(layerName: string, visible: boolean) {
        const layer = this.getLayerByName(layerName) as SysGisMapLayer;
        if (layer?.layer) {
            (layer.layer as unknown as { setVisible: (v: boolean) => void }).setVisible(visible);
        }
    }

    getCenter(): number[] | undefined {
        return this?.olView?.getCenter() as number[];
    }

    addFeaturesToLayer(features: GeoJSON.Feature[], layerName: string, options?: {
        clear?: boolean,
        fit?: unknown,
        style?: unknown
    }) {
        const lay = this.getLayerByName(layerName, {style: options?.style as GisLayerOption['style']});
        if (options?.clear) {
            lay.clear();
        }
        // 显式应用样式函数：getLayerByName 仅在图层首次创建时生效，
        // 已存在图层需在此重置样式（符号化 / 清除符号化都走这条路径）
        if (options?.style && typeof options.style === 'function') {
            (lay as SysGisMapLayer).setStyle(options.style as StyleLike);
        }
        if (lay.source) {
            const feas = this.readFeaturesFromGeoJSON(features);
            lay.addFeatures?.(feas)
            void eventBus.emit(this.mapName, new GisMapNotifyEvent({}, 'GisMap::addFeaturesToLayer', undefined, feas, lay));
            const extent = lay.getExtent?.() as import("ol/extent").Extent | undefined;
            if (extent) {
                this.olView?.fit(extent, {
                    padding: Array(4).fill(10)
                });
            }
        }
    }

    addFeatures(features: GeoJSON.Feature[], options?: {
        layerName?: string,
        clear?: boolean,
        fit?: unknown,
        style?: unknown
    }) {
        const layerName = options?.layerName || DefaultLayerNames.VECTOR_INPUT;
        this.addFeaturesToLayer(features, layerName, {clear: options?.clear, fit: options?.fit, style: options?.style});
    }

    flashFeatures(features: GeoJSON.Feature[], options?: {
        layerName?: string,
        clear?: boolean,
        fit?: unknown,
        style?: unknown
    }) {
        const layerName = options?.layerName || DefaultLayerNames.SYS_TEMP_FLASH;
        const lay = this.getLayerByName(layerName, {style: options?.style as GisLayerOption['style']});
        lay.clear();

        const start = new Date().getTime();
        const duration = 2000;
        const raido = 5;
        const styles = [
            new Style({
                fill: new Fill({color: 'rgba(255,0,0,0.2)'}),
                stroke: new Stroke({color: 'red', width: 2}),
                image: new Circle({
                    radius: 2 * 2,
                    fill: new Fill({color: 'red'}),
                    stroke: new Stroke({color: 'white', width: 1}),
                }),
            }),
            new Style({
                fill: new Fill({color: 'rgba(0,0,255,0.2)'}),
                stroke: new Stroke({color: 'blue', width: 2}),
                image: new Circle({
                    radius: 2 * 2,
                    fill: new Fill({color: 'blue'}),
                    stroke: new Stroke({color: 'white', width: 1}),
                }),
            }),
        ];
        const handle = (event: { frameState: { time: number } }) => {
            const frameState = event.frameState;
            const elapsed = frameState.time - start;
            const flag = elapsed % (duration / raido) > (duration / raido / 2);
            lay.setStyle(styles[flag ? 0 : 1])
            if (elapsed > duration) {
                lay.off('postrender', handle);
                lay.clear();
                return;
            }
            this?.olMap?.render();
        }
        lay.on('postrender', handle);

        if (lay.source) {
            const feas = this.readFeaturesFromGeoJSON(features);
            lay.addFeatures?.(feas)
            void eventBus.emit(this.mapName, new GisMapNotifyEvent({}, 'GisMap::addFeaturesToLayer', undefined, feas, lay));
            const extent2 = lay.getExtent?.() as import("ol/extent").Extent | undefined;
            if (extent2) {
                this.olView?.fit(extent2, {padding: Array(4).fill(40)});
            }
        }
    }

    cleanDraw() {
        this.drawTool({type: 'None'});
        void this.cleanLayer(DefaultLayerNames.SYS_DRAW_TOOL_ACTION);
        void this.cleanLayer(DefaultLayerNames.SYS_DRAW_TOOL_DISPLAY);
    }

    removeDrawFeature(featureId: string) {
        const displayLayer = this.getLayerByName(DefaultLayerNames.SYS_DRAW_TOOL_DISPLAY) as SysGisMapLayer;
        if (displayLayer) {
            displayLayer.removeFeatureById?.(featureId);
        }
    }

    toggleDrawFeatureVisible(featureId: string, visible: boolean) {
        const displayLayer = this.getLayerByName(DefaultLayerNames.SYS_DRAW_TOOL_DISPLAY) as SysGisMapLayer;
        if (!displayLayer?.source) return;
        const olFeature = displayLayer.source.getFeatureById(featureId) as Feature | null;
        if (!olFeature) return;
        if (visible) {
            // 恢复原始样式
            const originalStyle = olFeature.get('_originalStyle');
            olFeature.setStyle(originalStyle ?? undefined);
            olFeature.set('_hidden', false);
        } else {
            // 保存当前样式并隐藏
            olFeature.set('_originalStyle', olFeature.getStyle());
            olFeature.setStyle(new Style({}));
            olFeature.set('_hidden', true);
        }
    }

    /**
     * 启动要素编辑：
     * 1. 隐藏输入数据源(VECTOR_INPUT)，完全隔离
     * 2. 在影子数据源(VECTOR_SHADOW)显示原始要素（对照）
     * 3. 在编辑数据源(VECTOR_EDIT)显示当前编辑要素
     * 4. 激活 Modify + Snap 交互
     */
    startModify(feature: GeoJSON.Feature, options?: { originalFeature?: GeoJSON.Feature; skipLayerSetup?: boolean }) {
        if (!this.olMap) {
            logger.warn('startModify: olMap not initialized');
            return;
        }

        // 先清理可能存在的旧编辑交互（不操作图层）
        this.removeModifyInteractions();

        const skipLayerSetup = options?.skipLayerSetup === true;

        if (!skipLayerSetup) {
            // 首次进入编辑模式：设置图层可见性和内容
            // 隐藏输入数据源，实现编辑隔离
            this.setLayerVisibility(DefaultLayerNames.VECTOR_INPUT, false);

            // 影子数据源：显示原始要素（对照）
            const refFeature = options?.originalFeature || feature;
            const shadowLayer = this.getLayerByName(DefaultLayerNames.VECTOR_SHADOW) as SysGisMapLayer;
            shadowLayer.clear();
            const refOlFeatures = this.readFeaturesFromGeoJSON([refFeature]);
            shadowLayer.addFeatures?.(refOlFeatures);

            // 编辑数据源：显示变更要素
            const editLayer = this.getLayerByName(DefaultLayerNames.VECTOR_EDIT) as SysGisMapLayer;
            editLayer.clear();
            const olFeatures = this.readFeaturesFromGeoJSON([feature]);
            editLayer.addFeatures?.(olFeatures);
        }

        // 参考图层：始终更新对照要素（淡显，独立于SHADOW层）
        const refLayer = this.getLayerByName(DefaultLayerNames.SYS_EDIT_REF) as SysGisMapLayer;
        if (refLayer) {
            const refFeature = options?.originalFeature || feature;
            refLayer.clear();
            const refOlFeatures = this.readFeaturesFromGeoJSON([refFeature]);
            refLayer.addFeatures?.(refOlFeatures);
            this.setLayerVisibility(DefaultLayerNames.SYS_EDIT_REF, true);
        }

        const editLayer = this.getLayerByName(DefaultLayerNames.VECTOR_EDIT) as SysGisMapLayer;

        // 创建 Modify 交互
        const source = editLayer.source;
        if (!source) {
            logger.error('startModify: edit layer source is null');
            return;
        }

        const modifyInteraction = new Modify({
            source,
            style: GisStyle.getModifyStyleFunction(),
        });

        modifyInteraction.addEventListener('modifyend', () => {
            // 修改结束后，将 OL Feature 转回 GeoJSON 并通过事件通知
            const modifiedOlFeature = source.getFeatures()[0];
            if (modifiedOlFeature) {
                // 不设 featureProjection，保持数据原始投影坐标（避免投影坐标被转为4326）
                const geoJsonStr = new GeoJSON().writeFeature(modifiedOlFeature, {
                    rightHanded: true,
                });
                const modifiedGeoJson = JSON.parse(geoJsonStr) as GeoJSON.Feature;
                void eventBus.emit(this.mapName, new GisMapModifyChangeEvent(modifiedGeoJson));
            }
            // 同步更新顶点编号标注
            this.renderVertexLabels();
        });

        // 创建 Snap 交互（吸附到编辑图层自身顶点）
        const snapInteraction = new Snap({
            source,
            pixelTolerance: 10,
        });

        this.olMap.addInteraction(modifyInteraction);
        this.olMap.addInteraction(snapInteraction);
        this.interactionMap.set('modify-edit', modifyInteraction);
        this.interactionMap.set('modify-snap', snapInteraction);

        // fit 到编辑要素
        const extent = editLayer.getExtent?.() as import("ol/extent").Extent | undefined;
        if (extent) {
            this.olView?.fit(extent, { padding: Array(4).fill(40) });
        }

        // 渲染顶点编号标注（skipLayerSetup=true 时由 updateEditFeature 已调用，此处跳过避免冗余）
        if (!skipLayerSetup) {
            this.renderVertexLabels();
        }

        logger.info('startModify: modify interaction activated', { skipLayerSetup });
    }

    /** 仅移除 Modify/Snap 交互，不操作图层 */
    private removeModifyInteractions() {
        if (!this.olMap) return;
        const modifyInteraction = this.interactionMap.get('modify-edit');
        const snapInteraction = this.interactionMap.get('modify-snap');
        if (modifyInteraction) {
            this.olMap.removeInteraction(modifyInteraction);
            this.interactionMap.delete('modify-edit');
        }
        if (snapInteraction) {
            this.olMap.removeInteraction(snapInteraction);
            this.interactionMap.delete('modify-snap');
        }
    }

    /**
     * 更新编辑数据源上的要素（从列表编辑后同步到地图）
     */
    updateEditFeature(feature: GeoJSON.Feature) {
        const editLayer = this.getLayerByName(DefaultLayerNames.VECTOR_EDIT) as SysGisMapLayer;
        if (!editLayer.source) return;
        editLayer.source.clear();
        const olFeatures = this.readFeaturesFromGeoJSON([feature]);
        editLayer.addFeatures?.(olFeatures);
        // 同步更新顶点编号标注
        this.renderVertexLabels();
    }

    /**
     * 渲染编辑要素的顶点编号标注到 OPERATION 图层
     * 从 EDIT 图层读取当前要素的顶点，生成带编号的 Point 要素
     */
    renderVertexLabels() {
        const opLayer = this.getLayerByName(DefaultLayerNames.VECTOR_OPERATION) as SysGisMapLayer;
        if (!opLayer?.source) return;

        // 只清除旧的顶点标注要素，保留其他操作要素（如分割线）
        const source = opLayer.source;
        const oldLabels = source.getFeatures().filter(f => f.get('__vertexLabel') === true);
        oldLabels.forEach(f => source.removeFeature(f));

        const editLayer = this.getLayerByName(DefaultLayerNames.VECTOR_EDIT) as SysGisMapLayer;
        if (!editLayer?.source) return;

        const editFeatures = editLayer.source.getFeatures();
        if (!editFeatures.length) return;

        // 共享的 Circle image（无状态，可安全复用）
        const vertexImage = new Circle({
            radius: 10,
            fill: new Fill({ color: '#409EFF' }),
            stroke: new Stroke({ color: '#fff', width: 2 }),
        });
        const textFill = new Fill({ color: '#fff' });
        const textStroke = new Stroke({ color: 'rgba(0,0,0,0.5)', width: 2 });

        let idx = 1;
        for (const feature of editFeatures) {
            const geom = feature.getGeometry();
            if (!geom) continue;

            const type = geom.getType();
            const allCoords: number[][] = [];

            if (type === 'Polygon') {
                const rings = (geom as Polygon).getCoordinates();
                // 外环（不含闭合点）
                if (rings[0] && rings[0].length > 1) {
                    rings[0].slice(0, -1).forEach((c: number[]) => allCoords.push(c));
                }
                // 内环（洞，不含闭合点）
                for (let i = 1; i < rings.length; i++) {
                    rings[i].slice(0, -1).forEach((c: number[]) => allCoords.push(c));
                }
            } else if (type === 'MultiPolygon') {
                (geom as MultiPolygon).getCoordinates().forEach((polygon: number[][][]) => {
                    polygon.forEach((ring: number[][]) => {
                        ring.slice(0, -1).forEach((c: number[]) => allCoords.push(c));
                    });
                });
            } else if (type === 'LineString') {
                (geom as LineString).getCoordinates().forEach((c: number[]) => allCoords.push(c));
            } else if (type === 'MultiLineString') {
                (geom as MultiLineString).getCoordinates().forEach((line: number[][]) => {
                    line.forEach((c: number[]) => allCoords.push(c));
                });
            } else if (type === 'Point') {
                allCoords.push((geom as Point).getCoordinates());
            } else if (type === 'MultiPoint') {
                (geom as MultiPoint).getCoordinates().forEach((c: number[]) => allCoords.push(c));
            }

            for (const coord of allCoords) {
                const pointFeature = new Feature({
                    geometry: new Point(coord),
                    __vertexLabel: true,
                });
                // 每个要素需要独立的 Style（Text 文本各不同），但复用 image/fill/stroke
                pointFeature.setStyle(new Style({
                    image: vertexImage,
                    text: new Text({
                        text: `${idx}`,
                        font: 'bold 11px sans-serif',
                        fill: textFill,
                        stroke: textStroke,
                        offsetY: 0,
                    }),
                }));
                source.addFeature(pointFeature);
                idx++;
            }
        }
    }

    /** 清空顶点编号标注 */
    clearVertexLabels() {
        const opLayer = this.getLayerByName(DefaultLayerNames.VECTOR_OPERATION) as SysGisMapLayer;
        if (!opLayer?.source) return;
        const source = opLayer.source;
        // 只清除顶点标注要素，不影响其他操作要素
        const toRemove = source.getFeatures().filter(f => f.get('__vertexLabel') === true);
        toRemove.forEach(f => source.removeFeature(f));
    }

    /**
     * 停止要素编辑：
     * 1. 移除 Modify/Snap 交互
     * 2. 清空编辑数据源和参考数据源（除非 skipLayerCleanup）
     * 3. 恢复输入数据源可见性（除非 skipLayerCleanup）
     */
    stopModify(options?: { skipLayerCleanup?: boolean }) {
        if (!this.olMap) return;

        const skipCleanup = options?.skipLayerCleanup === true;

        // 移除交互
        this.removeModifyInteractions();

        // 清理顶点编号标注
        this.clearVertexLabels();

        // 清理参考图层
        const refLayer = this.getLayerByName(DefaultLayerNames.SYS_EDIT_REF) as SysGisMapLayer;
        if (refLayer) {
            refLayer.clear();
            this.setLayerVisibility(DefaultLayerNames.SYS_EDIT_REF, false);
        }

        if (!skipCleanup) {
            // 完全退出编辑模式：清空图层 + 恢复可见性
            void this.cleanLayer(DefaultLayerNames.VECTOR_EDIT);
            // 不在这里清空影子层，由 showEditShadow/clearEditShadow 同步管理
            this.setLayerVisibility(DefaultLayerNames.VECTOR_INPUT, true);
        }

        logger.info('stopModify: modify interaction deactivated', { skipCleanup });
    }

    /**
     * 展示编辑影子：以影子数据源(VECTOR_SHADOW)显示已编辑的要素
     * 用于离开要素列表后，在主地图上也能看到修改过的数据"影子"
     */
    showEditShadow(features: GeoJSON.Feature[]) {
        if (!this.olMap || !features.length) {
            logger.info('showEditShadow skipped', { hasMap: !!this.olMap, featuresLen: features.length });
            return;
        }
        const shadowLayer = this.getLayerByName(DefaultLayerNames.VECTOR_SHADOW) as SysGisMapLayer;
        if (!shadowLayer) {
            logger.error('showEditShadow: shadow layer not found!');
            return;
        }
        // 同步清空再添加（不能用cleanLayer，它是异步的）
        shadowLayer.clear();
        const olFeatures = this.readFeaturesFromGeoJSON(features);
        logger.info('showEditShadow adding features', { olFeaturesLen: olFeatures.length });
        const result = shadowLayer.addFeatures?.(olFeatures);
        logger.info('showEditShadow: shadow layer displayed', { addedCount: result?.length, afterCount: shadowLayer.source?.getFeatures()?.length });
    }

    /**
     * 清除影子数据源
     */
    clearEditShadow() {
        const shadowLayer = this.getLayerByName(DefaultLayerNames.VECTOR_SHADOW) as SysGisMapLayer;
        if (shadowLayer) shadowLayer.clear();
        logger.info('clearEditShadow: shadow layer cleared');
    }

    flyTo(geoCenter: number[], zoom?: number): Promise<boolean> {
        return new Promise<boolean>((resolve, reject) => {
            try {
                const viewProj = this.olView?.getProjection().getCode();
                const center = viewProj && viewProj !== 'EPSG:4326' && viewProj !== 'EPSG:4490'
                    ? fromLonLat(geoCenter, viewProj)
                    : geoCenter;
                this.olMap?.getView().animate({
                    center,
                    zoom: zoom,
                    duration: 2000
                }, (isEnd => {
                    resolve(isEnd ?? false);
                }))
            } catch (e) {
                reject(e)
            }
        })
    }

    zoomTo(geoCenter: number[], zoom?: number) {
        const viewProj = this.olView?.getProjection().getCode();
        const center = viewProj && viewProj !== 'EPSG:4326' && viewProj !== 'EPSG:4490'
            ? fromLonLat(geoCenter, viewProj)
            : geoCenter;
        this.olMap?.getView().setCenter(center);
        if (zoom !== undefined) {
            this.olMap?.getView().setZoom(zoom);
        }
    }

    dispose(): void {
        // 执行所有注册的清理函数
        this.cleanupFunctions.forEach(cleanup => cleanup());
        this.cleanupFunctions = [];

        // 清理所有交互
        this.interactionMap.forEach((interaction) => {
            this.olMap?.removeInteraction(interaction);
        });
        this.interactionMap.clear();

        // 清理所有图层
        const allLayers = [...this.baseLayers, ...this.userLayers, ...this.sysLayers];
        allLayers.forEach(layer => {
            (layer as GisMapLayer & { dispose?: () => void }).dispose?.();
        });
        this.baseLayers = [];
        this.userLayers = [];
        this.sysLayers = [];

        // 清理事件监听器
        this.clear();

        // 清理地图实例
        if (this.olMap) {
            this.olMap.setTarget(undefined);
            this.olMap = undefined;
        }
        this.olView = undefined;
    }

    /**
     * 切换底图图层组
     * 移除当前所有底图（不 dispose，便于切回），添加新的底图图层组
     * @param newBaseLayers 新的底图图层组
     */
    setBaseLayers(newBaseLayers: GisMapLayer[]): void {
        if (!this.olMap) {
            logger.warn('setBaseLayers: olMap is not initialized')
            return
        }
        // 仅从地图移除旧底图（不 dispose，便于切回时复用）
        this.baseLayers.forEach(layer => {
            const l = layer.layer as BaseLayer | undefined
            if (l) {
                this.olMap?.removeLayer(l)
            }
        })
        this.baseLayers = newBaseLayers
        // 添加新底图：若图层未初始化则 init，否则直接添加
        newBaseLayers.forEach(lay => {
            let l = lay.layer as BaseLayer | undefined
            if (!l) {
                l = lay.init() as BaseLayer
            }
            if (l) {
                this.olMap?.addLayer(l)
            }
        })
    }

    /**
     * 获取当前底图图层组
     */
    getBaseLayers(): GisMapLayer[] {
        return this.baseLayers
    }
}

export class BaseTianDiTuMap extends GisMap {
    constructor(mapName: string, mapTarget: string | HTMLElement, options?: GisMapOption) {
        super(mapName, mapTarget);
        const projection = options?.projection === undefined ? 3857 : options?.projection;
        const _projection = (typeof projection === 'string') ? projection : `EPSG:${projection}`;

        // 先用地理中心初始化，投影坐标系稍后 fit 中国范围
        const geoCenter = [104.195, 35.8];
        const isGeo = _projection === 'EPSG:4326' || _projection === 'EPSG:4490';
        const center = isGeo ? geoCenter : fromLonLat(geoCenter, _projection);
        this.init({
            center,
            zoom: isGeo ? 4 : 1,
            projection: _projection
        });
        const projSuffix = getTianDiTuProjSuffix(_projection);
        // 默认底图取配置里的矢量服务：config.json 改 url 即换服务，enabled=false 则不加载
        const vecService = getBasemapService('vec');
        if (vecService && vecService.enabled) {
            this.baseLayers = [
                new TianDiTuGisMapLayer({url: vecService.url || buildTianDiTuLayerUrl(vecService.layerType || 'vec', projSuffix)}),
                new TianDiTuGisMapLayer({url: vecService.annotationUrl || buildTianDiTuLayerUrl(vecService.annotationLayerType || 'cva', projSuffix)})
            ];
            // 添加底图（init 只初始化 map，不会自动 addLayer）
            if (this.olMap) {
                this.addLayer(this.olMap, this.baseLayers);
            }
        } else {
            logger.warn('矢量底图服务未在 config.json 中启用，初始底图为空');
        }

        // 投影坐标系：fit 中国范围确保完整显示
        if (!isGeo) {
            try {
                const proj = getProjection(_projection);
                const view = this.olMap?.getView();
                if (view && proj) {
                    // fit 到中国范围附近
                    const extent = proj.getExtent();
                    if (extent) {
                        view.fit(extent, { padding: [20, 20, 20, 20], maxZoom: 4 });
                    } else {
                        // 用默认中国经纬度范围
                        const chinaExtent = applyTransform([73, 16, 136, 54], getTransform('EPSG:4326', _projection), undefined, 8);
                        view.fit(chinaExtent, { padding: [20, 20, 20, 20], maxZoom: 4 });
                    }
                }
            } catch (e) {
                logger.warn(`BaseTianDiTuMap fit failed for ${_projection}:`, e);
            }
        }

        this.initMapPointermove();
        this.initFeatureLongPress();
        logger.info('BaseTianDiTuMap initialized:', mapName, _projection);
    }
}

export class BlankMap extends GisMap {
    constructor(mapName: string, mapTarget: string | HTMLElement, options?: GisMapOption) {
        super(mapName, mapTarget);
        const projection = options?.projection === undefined ? 4490 : options?.projection;
        const _projection = (typeof projection === 'string') ? projection : `EPSG:${projection}`;

        // 先用地理中心初始化，投影坐标系稍后 fit 中国范围
        const geoCenter = [104.195, 35.8];
        const isGeo = _projection === 'EPSG:4326' || _projection === 'EPSG:4490';
        const center = isGeo ? geoCenter : fromLonLat(geoCenter, _projection);
        this.init({
            center,
            zoom: isGeo ? 4 : 1,
            projection: _projection
        });

        // 中国轮廓底图：渲染到 canvas 后缓存为 ImageStatic，零交互开销
        // Canvas 在 EPSG:4326 下绘制，OL 自动重投影到视图坐标系
        const { url, extent: geoExtent } = getChinaBoundaryImage(_projection);
        // 包装为 ImageGisMapLayer 加入 baseLayers，便于底图切换
        const chinaImageLayer = new ImageGisMapLayer({
            url,
            imageExtent: geoExtent,
            imageProjection: 'EPSG:4326',
            name: '本地底图',
            zIndex: -1,
        });
        this.baseLayers = [chinaImageLayer];
        this.addLayer(this.olMap!, this.baseLayers);

        // 投影坐标系：fit 中国范围确保完整显示
        if (!isGeo && this.olView) {
            const bl = fromLonLat([73.5, 18], _projection);
            const tr = fromLonLat([136, 54], _projection);
            const projExtent: [number, number, number, number] = [bl[0], bl[1], tr[0], tr[1]];
            this.olView.fit(projExtent, { padding: [20, 20, 20, 20] });
        }
        this.initMapPointermove();
        this.initFeatureLongPress();
        logger.info('BlankMap initialized:', mapName, _projection);
    }
}
