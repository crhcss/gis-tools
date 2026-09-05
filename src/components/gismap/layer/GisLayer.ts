/**
 * @file GisLayer class
 * @description Provides a wrapper class for managing OpenLayers layers including tile, vector,
 *              image, and static image layers. Handles layer creation, styling, visibility,
 *              opacity, and z-index management.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2024-08-06
 */
import "ol/ol.css";
import Feature from "ol/Feature";
import GeoJSON from 'ol/format/GeoJSON';
import BaseLayer from "ol/layer/Base";
import ImageLayer from "ol/layer/Image";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import ImageStatic from "ol/source/ImageStatic";
import VectorSource from "ol/source/Vector";
import XYZ from "ol/source/XYZ";
import { Style } from "ol/style";
import type { StyleLike } from "ol/style/Style";

import Common from "~/common/Common";
import {logger} from "~/common/logger";

import { getLayerStyles } from "../styles/GisStyle";
import { getCurrentTianDiTuKey } from "../tiandituConfig";


export interface GisLayerOption {
    id?: string;
    name?: string;
    visible?: boolean;
    opacity?: number;
    zIndex?: number;
    url?: string;
    style?: StyleLike | string | Record<string, unknown>;
}

export class SysGisMapLayer implements GisMapLayer {
    id?: string;
    name?: string;
    visible?: boolean;
    opacity?: number;
    zIndex?: number;
    layer?: VectorLayer;
    url?: string;
    source?:VectorSource;
    style: StyleLike | undefined;
    features: GeoJSON.Feature[] = [];
    projection?: string;
    sercurityTokens: Map<string, string> = new Map();
    constructor(options:GisLayerOption) {
        this.id = options.id || Common.uuid();
        this.name = options.name || '系统图层';
        this.visible = options.visible ?? true;
        this.opacity = options.opacity ?? 1;
        // 拓扑错误图层默认 zIndex=500，显示在 vector-edit(400) 之上
        this.zIndex = options.zIndex ?? (options.name?.startsWith('layer_topo_err_') ? 500 : 0);
        if(options.style){
            if (typeof options.style === 'string') {
                this.style =  getLayerStyles(options.style);
            }else if (options.style instanceof Style){
                this.style = options.style;
            }else if (typeof options.style === 'object') {
                this.style = new Style(options.style as unknown as ConstructorParameters<typeof Style>[0]);
            }else if (typeof options.style === 'function') {
                this.style = options.style;
            }else {
                throw new Error("style must be string or Style or object or function");
            }
        }else {
            this.style = getLayerStyles(this.name);
        }
    }
    on(...args: unknown[]): unknown {
        if (this.layer) {
            return (this.layer.on as (...a: unknown[]) => unknown).apply(this.layer, args);
        }
        return undefined;
    }
    off(...args: unknown[]): unknown {
        if (this.layer) {
            return (this.layer.un as (...a: unknown[]) => unknown).apply(this.layer, args);
        }
        return undefined;
    }

    init() {
        const source = new VectorSource({wrapX: false});
        this.source = source;
        this.layer = new VectorLayer({
          source: source,
            background: '#FFFFFF00',
          style: this.style,
          zIndex: this.zIndex ?? 0,
        });
        return this.layer;
    }
    addFeatures(features: Feature[]): Feature[] {
        const result: Feature[] = []
        features.forEach((feature, idx) => {
            const label = feature.get('label');
            if(!label){
                feature.set('label',idx);
            }
            const added = this.addFeature(feature);
            if (added) result.push(added);
        })
        return result;
    }
    addFeature(feature: Feature | Record<string, unknown>): Feature | undefined {
        if(feature instanceof Feature){
            feature.setId(Common.uuid());
            this.source?.addFeature(feature);
            // 保持视图投影坐标，不转为4326；crs 由上层声明
            const jsonStr = new GeoJSON().writeFeature(feature);
            const fea = JSON.parse(jsonStr);
            fea.id =  feature.getId() as string
            this.features.push(fea as GeoJSON.Feature);
            return feature;
        }
        if(feature?.type === 'Feature'){
            (feature as Record<string, unknown>).id = Common.uuid();
            const olFeature = new GeoJSON().readFeature(feature) as Feature;
            this.source?.addFeature(olFeature);
            this.features.push(feature as unknown as GeoJSON.Feature);
            const result = this.source?.getFeatureById(feature.id as string);
            return result ?? undefined;
        }
        return undefined;
    }
    getJSONFeatureById(id: string): Record<string, unknown> | undefined {
       return this.features.find(f=>f.id===id) as Record<string, unknown> | undefined;
    }
    getFeatureById(id: string): Feature | undefined {
       return this.source?.getFeatureById(id) ?? undefined;
    }
    removeFeatureById(id: string): boolean {
       const fea =  this.source?.getFeatureById(id)
       if(fea){
        this.source?.removeFeature(fea);
       }
       this.features = this.features.filter(f=>f.id!==id);
       return !!fea;
    }
    getExtent(): unknown {
        return this.source?.getExtent();
    }
    clear(): void {
        this.source?.clear();
        this.features.splice(0);
    }
    setStyle(style: StyleLike): void {
        this.style = style;
        this.layer?.setStyle(style);
    }
}


/**
 * 构建瓦片 URL
 * - URL 里已含 {z}/{x}/{y} 占位符：视为 config.json 配置的自定义服务模板，只替换 {key}
 * - 否则按天地图 DataServer 规则补查询参数
 * @param url 服务 URL（模板或天地图 DataServer 地址）
 * @param key 天地图 API Key
 */
function buildTileUrl(url: string, key: string): string {
    if (url.includes('{z}') || url.includes('{x}') || url.includes('{y}')) {
        return url.replace(/\{key\}/g, key)
    }
    return `${url}&x={x}&y={y}&l={z}&tk=${key}`
}

export class TianDiTuGisMapLayer implements GisMapLayer {
    id?: string;
    name?: string;
    visible?: boolean;
    opacity?: number;
    zIndex?: number;
    style?: StyleLike;
    layer?: BaseLayer;
    url: string;
    source?: VectorSource;
    features?: unknown[];
    sercurityTokens: Map<string, string> = new Map();
    constructor(options:GisLayerOption) {

        // 使用新轮换逻辑中的同步接口，避免 Common 旧逻辑
        const tiandituApiKey = getCurrentTianDiTuKey();
        this.sercurityTokens.set('tdt', tiandituApiKey);
        let url = options.url || ''; // 提供一个默认URL
        this.name = options.name;

        if(url===''){
            throw new Error('url is required');
        }
        // 兼容相对路径的自定义服务（config.json 里可能配相对地址），解析失败时原样保留
        try {
            const _url = new URL(url);
            if(_url.search==''){
                url += '?gismap=1'
            }
        } catch {
            logger.warn('底图服务 URL 不是绝对地址，原样使用:', url);
        }
        this.url = url;
    }
    on(...args: unknown[]): unknown {
        if (this.layer) {
            return (this.layer.on as (...a: unknown[]) => unknown).apply(this.layer, args);
        }
        return undefined;
    }
    off(...args: unknown[]): unknown {
        if (this.layer) {
            return (this.layer.un as (...a: unknown[]) => unknown).apply(this.layer, args);
        }
        return undefined;
    }
    init() {
        const tiandituApiKey = this.sercurityTokens.get('tdt');
        // 天地图 _c 瓦片是经纬度投影（EPSG:4326/4490，CGCS2000 与 WGS84 共用同一地理瓦片网格）
        // _w 瓦片是 EPSG:3857 球面墨卡托投影。按 URL 中 T= 参数的后缀判断，
        // 明确设置 source projection，OL 会自动重投影到视图投影
        const isGeoTile = /T=[A-Za-z]+_c(?:&|$)/.test(this.url);
        this.layer = new TileLayer({
            source: new XYZ({
                projection: isGeoTile ? 'EPSG:4326' : 'EPSG:3857',
                url: buildTileUrl(this.url, tiandituApiKey || ''),
                // 天地图瓦片级别范围 0-18（最大 19 级含 0）
                minZoom: 0,
                maxZoom: 18,
            }),
            zIndex: this.zIndex ?? -1,
        });
        return this.layer;
    }
    clear(): void {
        logger.warn("TianDiTuGisMapLayer.clear not implemented")
    }
    setStyle(_style?: StyleLike): void {
        logger.warn("TianDiTuGisMapLayer.setStyle not implemented")
    }
}

/**
 * 静态图片底图图层
 * 用于包装 OpenLayers ImageLayer + ImageStatic，作为本地底图
 */
export class ImageGisMapLayer implements GisMapLayer {
    id?: string;
    name?: string;
    visible?: boolean;
    opacity?: number;
    zIndex?: number;
    style?: StyleLike;
    layer?: BaseLayer;
    url: string;
    imageExtent: [number, number, number, number];
    imageProjection: string;
    source?: unknown;
    features?: unknown[];
    sercurityTokens: Map<string, string> = new Map();
    constructor(options: GisLayerOption & { imageExtent: [number, number, number, number]; imageProjection?: string }) {
        this.id = options.id || Common.uuid();
        this.name = options.name || '本地底图';
        this.visible = options.visible ?? true;
        this.opacity = options.opacity ?? 1;
        this.zIndex = options.zIndex ?? -1;
        this.url = options.url || '';
        this.imageExtent = options.imageExtent;
        this.imageProjection = options.imageProjection || 'EPSG:4326';
        if (!this.url) {
            throw new Error('url is required for ImageGisMapLayer');
        }
    }
    on(...args: unknown[]): unknown {
        if (this.layer) {
            return (this.layer.on as (...a: unknown[]) => unknown).apply(this.layer, args);
        }
        return undefined;
    }
    off(...args: unknown[]): unknown {
        if (this.layer) {
            return (this.layer.un as (...a: unknown[]) => unknown).apply(this.layer, args);
        }
        return undefined;
    }
    init() {
        this.layer = new ImageLayer({
            source: new ImageStatic({
                url: this.url,
                imageExtent: this.imageExtent,
                projection: this.imageProjection,
            }),
            zIndex: this.zIndex,
            opacity: this.opacity,
        });
        return this.layer;
    }
    clear(): void {
        logger.warn("ImageGisMapLayer.clear not implemented")
    }
    setStyle(_style?: StyleLike): void {
        logger.warn("ImageGisMapLayer.setStyle not implemented")
    }
}

export interface GisMapLayer {
    id?: string;
    name?: string;
    visible?: boolean;
    opacity?: number;
    zIndex?: number;
    style?: unknown;
    layer?: unknown;
    url?: string;
    sercurityTokens: Map<string, string>;
    source?: unknown;
    features?: unknown[];
    init(): unknown;
    on(...args: unknown[]): unknown;
    off(...args: unknown[]): unknown;
    addFeature?(features: Feature | Record<string, unknown> | undefined): Feature | undefined;
    addFeatures?(features: Feature[]): Feature[];
    getFeatureById?(id: string): Feature | undefined;
    getJSONFeatureById?(id: string): Record<string, unknown> | undefined;
    removeFeatureById?(id: string): boolean;
    getExtent?(): unknown;
    clear(): void;
    setStyle(style: StyleLike): unknown;
}
