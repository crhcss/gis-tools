/**
 * @file Local database (IndexedDB) wrapper
 * @description Provides an IndexedDB-based local storage for GIS file data with
 *              CRUD operations, history management, and structured data persistence.
 * @author yuanyu <yuanyu@supermap.com>
 * @date 2026-04-13
 */
import {GisError, GisErrorCode} from "~/common/GisError";
import {logger} from "~/common/logger";

const DB_NAME = 'gis-tool';
const DB_VERSION = 1;
const DB_OBJECT_NAME = 'GisFileData';
const DB_OBJECT_PK = 'id';

/**
 * Represents a stored file data record in IndexedDB
 */
export class GisFileData {
    /** Primary key */
    id: number = 0;
    name: string = '';
    content: ArrayBuffer | string = '';
    /** 元数据（保存时从解析结果中提取，用于历史记录列表展示） */
    crs?: string = '';
    types?: string = '';
    featureCount?: number = 0;
    vertexCount?: number = 0;
}

export default class LocalDb {
    _initedHandler: ((value: unknown) => void) | null = null;
    _inited: Promise<unknown>;
    iDb: IDBFactory;
    isSupport: boolean;
    idbDatabase: IDBDatabase | null = null;
    handlds: { [key: string]: (e: unknown) => void } = {};

    constructor() {
        this._inited = new Promise(resolve => this._initedHandler = resolve)
        this.iDb = window.indexedDB;
        this.isSupport = !!this.iDb;
        if (!this.isSupport) {
            logger.warn('你的浏览器不支持IndexedDB');
            return;
        }
        const request = this.iDb.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function (e) {
            const db = (e.target as IDBOpenDBRequest).result
            if (!db.objectStoreNames.contains(DB_OBJECT_NAME)) {
                const gisFileData = db.createObjectStore(DB_OBJECT_NAME, {keyPath: DB_OBJECT_PK, autoIncrement: true})
                gisFileData.createIndex(DB_OBJECT_PK, DB_OBJECT_PK, {unique: true})
                gisFileData.transaction.oncomplete = () => {};
            }
        }
        request.onerror = () => {
            logger.error('IndexedDB打开失败');
        }
        request.onsuccess = (e) => {
            this.idbDatabase = (e.target as IDBOpenDBRequest).result;
            if (this._initedHandler) {
                this._initedHandler(this.idbDatabase);
            }
        }
    }

    getIDBObjectStore(mode: 'readonly' | 'readwrite'): IDBObjectStore {
        if (!this.idbDatabase) {
            throw new GisError(GisErrorCode.STORAGE_NOT_SUPPORTED, 'IndexedDB未初始化');
        }
        const trans: IDBTransaction = this.idbDatabase.transaction([DB_OBJECT_NAME], mode)
        return trans.objectStore(DB_OBJECT_NAME)
    }

    clear(): Promise<unknown> {
        return new Promise((resolve, reject) => {
            this._inited.then(() => {
                const objectStore: IDBObjectStore = this.getIDBObjectStore('readwrite');
                const result = objectStore.clear()
                result.onsuccess = (e) => {
                    this.disPatchChanged(e);
                    resolve(e);
                }
                result.onerror = (e) => {
                    logger.error('IndexedDB清空失败:', e);
                    reject(new GisError(GisErrorCode.STORAGE_WRITE_FAILED, 'IndexedDB清空失败', e));
                }
            })
        })
    }

    add(name: string, content: ArrayBuffer | string, meta?: { crs?: string; types?: string; featureCount?: number; vertexCount?: number }): Promise<unknown> {
        const gisFileData = new GisFileData();
        gisFileData.id = new Date().getTime()
        gisFileData.name = name;
        gisFileData.content = content;
        if (meta) {
            gisFileData.crs = meta.crs || '';
            gisFileData.types = meta.types || '';
            gisFileData.featureCount = meta.featureCount ?? 0;
            gisFileData.vertexCount = meta.vertexCount ?? 0;
        }
        return this.addGisFileData(gisFileData);
    }

    disPatchChanged(e: unknown) {
        const handler = this.handlds['changed']
        if (typeof handler === 'function') {
            handler(e);
        }
    }

    addGisFileData(gisFileData: GisFileData): Promise<unknown> {
        return new Promise((resolve, reject) => {
            this._inited.then(() => {
                const objectStore: IDBObjectStore = this.getIDBObjectStore('readwrite');
                const result = objectStore.add(gisFileData)
                result.onsuccess = (e) => {
                    this.disPatchChanged(e);
                    resolve(e);
                }
                result.onerror = (e) => {
                    logger.error('IndexedDB插入失败:', e);
                    reject(new GisError(GisErrorCode.STORAGE_WRITE_FAILED, 'IndexedDB插入失败', e));
                }
            })
        })
    }

    /* queryById(id: number): Promise<GisFileData> {
        return new Promise<GisFileData>((resolve, reject) => {
            this._inited.then(() => {
                const objectStore: IDBObjectStore = this.getIDBObjectStore('readonly');
                const result = objectStore.get(id)
                result.onsuccess = (e) => {
                    resolve((e.target as IDBRequest).result);
                }
                result.onerror = (e) => {
                    logger.error('IndexedDB查询失败:', e);
                    reject(new GisError(GisErrorCode.STORAGE_READ_FAILED, 'IndexedDB查询失败', e));
                }
            })
        })
    } */

    /**
     * 删除指定历史记录
     * @param id 记录主键（GisFileData.id）
     */
    remove(id: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            this._inited.then(() => {
                try {
                    const objectStore: IDBObjectStore = this.getIDBObjectStore('readwrite');
                    const result = objectStore.delete(id)
                    result.onsuccess = (e) => {
                        this.disPatchChanged(e);
                        resolve(e);
                    }
                    result.onerror = (e) => {
                        logger.error('IndexedDB删除失败:', e);
                        reject(new GisError(GisErrorCode.STORAGE_WRITE_FAILED, 'IndexedDB删除失败', e));
                    }
                } catch (e) {
                    logger.error('IndexedDB删除失败:', e);
                    reject(new GisError(GisErrorCode.STORAGE_WRITE_FAILED, 'IndexedDB删除失败', e));
                }
            })
        })
    }

    listAll(): Promise<GisFileData[]> {
        return new Promise<GisFileData[]>((resolve, reject) => {
            this._inited.then(() => {
                const objectStore: IDBObjectStore = this.getIDBObjectStore('readonly');
                const result = objectStore.getAll()
                result.onsuccess = (e) => {
                    resolve((e.target as IDBRequest).result.map((x: GisFileData) => Object.assign(new GisFileData(), x)));
                }
                result.onerror = (e) => {
                    logger.error('IndexedDB列表查询失败:', e);
                    reject(new GisError(GisErrorCode.STORAGE_READ_FAILED, 'IndexedDB列表查询失败', e));
                }
            })
        })
    }

    on(name: 'changed', callBack: (e: unknown) => void) {
        this.handlds[name] = callBack;
    }
}
