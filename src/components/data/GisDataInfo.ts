/**
 * @file GIS data info class
 * @description Core data model class for GIS datasets, managing features, CRS, data type,
 *              name, and source information. Provides feature CRUD, append, and validation operations.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-04-13
 */
import * as GeoJSON from 'geojson';

import {GisError, GisErrorCode} from "~/common/GisError";
import {logger} from "~/common/logger";
import GisCrs from "~/components/data/GisCrs";
import type {SymbolizationConfig} from "~/components/data/symbolization";

export enum GisDataType {
    // Base64编码格式
    Base64,
    // 地理JSON格式
    GeoJson,
    // Well-Known Text格式
    Wkt,
    // Well-Known Binary格式
    Wkb,
    // 电子报盘格式
    Exchange,
    // CSV格式
    Csv,
    // ANTU响应数据格式
    ResponseBase,
    ShapeFile,
    ShapeZip,
    EXF,
    DXF,
    // TopoJSON 格式（仅作数据存储类型，使用时转成 GeoJSON）
    TopoJson,
}

export interface DataInfo {
    name: string;
    originalData: unknown;
    descriptions?: Record<string, unknown>;
    features: GeoJSON.Feature[];
    crs?: GisCrs;
}

/* [UNUSED] EmptyDataInfo - 无任何外部引用，已注释掉
export class EmptyDataInfo implements DataInfo {
    descriptions?: Record<string, unknown>;
    features: GeoJSON.Feature[] = [];
    name: string = "";
    originalData: unknown = null;
    
    constructor() {}
}
*/

/**
 * 表示地理信息系统数据的信息类
 */
export default class GisDataInfo implements DataInfo {
    // 数据名称
    public name: string;
    // 原始数据内容
    public originalData: unknown;
    // 数据描述信息
    public descriptions?: Record<string, unknown>;
    // 几何要素
    public features: GeoJSON.Feature[];
    // 坐标系统信息
    public crs?: GisCrs
    // 图斑符号化配置（单一 / 分类），null 表示使用默认样式
    public symbolization?: SymbolizationConfig | null

    /**
     * 构造函数，初始化地理信息系统数据的信息
     * @param options 配置参数对象，可选包含EPSG代码
     */
    constructor(_name?: string, _crs?: GisCrs | number) {
        // 根据提供的EPSG代码初始化坐标系统
        this.features = []
        this.name = _name || "未命名";
        if (_crs instanceof GisCrs) {
            this.crs = _crs;
        } else if (typeof _crs === "number") {
            this.crs = new GisCrs(_crs);
        }
    }

    getTypes(): string[] {
        if (this.features.length > 0) {
            const allTypes = this.features
                .map(x => x.geometry?.type)
                .filter((type): type is GeoJSON.Geometry['type'] => type !== undefined);
            return [...new Set(allTypes)];
        }
        return [];
    }

    /**
     * 计算所有要素的总顶点数（Polygon/MultiPolygon 不含闭合点）
     */
    getTotalVertexCount(): number {
        let count = 0;
        for (const feature of this.features) {
            const geo = feature.geometry;
            if (!geo) continue;
            switch (geo.type) {
                case 'Point': count += 1; break;
                case 'MultiPoint': count += (geo.coordinates as number[][]).length; break;
                case 'LineString': count += (geo.coordinates as number[][]).length; break;
                case 'MultiLineString':
                    (geo.coordinates as number[][][]).forEach(line => { count += line.length; });
                    break;
                case 'Polygon':
                    (geo.coordinates as number[][][]).forEach(ring => { count += Math.max(0, ring.length - 1); });
                    break;
                case 'MultiPolygon':
                    (geo.coordinates as number[][][][]).forEach(poly =>
                        poly.forEach(ring => { count += Math.max(0, ring.length - 1); })
                    );
                    break;
            }
        }
        return count;
    }

    static clone(originData: GisDataInfo): GisDataInfo {
        const gisDataInfo = new GisDataInfo(originData.name, originData.crs);
        try {
            gisDataInfo.features = JSON.parse(JSON.stringify(originData.features));
            if (originData.descriptions) {
                gisDataInfo.descriptions = JSON.parse(JSON.stringify(originData.descriptions));
            }
            if (originData.symbolization !== undefined) {
                gisDataInfo.symbolization = JSON.parse(JSON.stringify(originData.symbolization));
            }
        } catch (e) {
            logger.error('Failed to clone GisDataInfo:', e);
            throw new GisError(GisErrorCode.DATA_PARSE_FAILED, 'Clone operation failed', e);
        }
        return gisDataInfo;
    }
}
