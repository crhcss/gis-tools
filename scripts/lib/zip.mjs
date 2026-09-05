/**
 * @file zip.mjs
 * @description 零依赖的最小 ZIP 打包器（store + deflate），用于生成部署包。
 *              仅实现 ZIP32（单文件 < 4GB、条目 < 65535），前端部署包场景完全够用。
 *              之所以不依赖系统 zip / PowerShell，是为了让打包脚本在 Windows / Linux / macOS
 *              上行为完全一致（Git Bash 下 tar.exe 对 zip 的支持并不可靠）。
 * @author yuanyu
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

/** 解压所需最低版本（2.0 = deflate） */
const VERSION = 20
/** 高位 0x03 = UNIX，低位 20 = zip 规范版本；配合 externalAttrs 记录文件权限 */
const VERSION_MADE_BY = 0x031e

/** 已经是压缩格式或本身就是二进制的资源，deflate 收益极低，直接 store */
const STORE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.gz', '.br', '.zip', '.7z', '.rar', '.pdf',
  '.mp3', '.mp4', '.webm', '.wasm',
])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ -1) >>> 0
}

function shouldStore(name, size) {
  if (size < 256) return true
  return STORE_EXT.has(path.extname(name).toLowerCase())
}

/** JS 的 Date → ZIP 使用的 MS-DOS 日期时间（本地时区，与系统 zip 行为一致） */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, dosDate }
}

/**
 * 写出 zip 文件
 *
 * @param {string} outputPath 输出 zip 路径（父目录不存在时自动创建）
 * @param {Array<{name: string, data?: Buffer, abs?: string}>} entries
 *        name 使用 `/` 分隔；data 为空 Buffer 之外，传 `abs` 表示写时再读取（省内存）
 * @returns {{entries: number, bytes: number}} 条目数与文件字节数
 */
export function writeZip(outputPath, entries) {
  const { time, dosDate } = dosDateTime(new Date())
  const bodyParts = []
  const centralParts = []
  let offset = 0
  let totalBytes = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    // 文件名含非 ASCII 时置 UTF-8 标志位（bit 11）
    const flags = /[^\x20-\x7e]/.test(entry.name) ? 0x0800 : 0
    const isDir = entry.data == null && entry.abs == null
    const raw = isDir ? Buffer.alloc(0) : (entry.data ?? fs.readFileSync(entry.abs))
    const store = isDir || shouldStore(entry.name, raw.length)
    const comp = store ? raw : zlib.deflateRawSync(raw, { level: 9 })
    const crc = isDir ? 0 : crc32(raw)
    const externalAttrs = isDir ? (0o40755 << 16) : (0o100644 << 16)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(store ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度

    bodyParts.push(local, nameBuf, comp)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(VERSION_MADE_BY, 4)
    central.writeUInt16LE(VERSION, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(store ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // 注释
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(externalAttrs >>> 0, 38)
    central.writeUInt32LE(offset, 42) // 本地头相对偏移

    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + comp.length
    totalBytes += raw.length
  }

  const centralDir = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4) // 当前磁盘号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, Buffer.concat([...bodyParts, centralDir, eocd]))

  return { entries: entries.length, bytes: totalBytes }
}

/**
 * 将目录打包为 zip
 *
 * @param {string} srcDir 源目录
 * @param {string} outputPath 输出 zip 路径
 * @param {{prefix?: string, filter?: (relPath: string, stats: import('node:fs').Stats) => boolean}} [options]
 */
export function zipDirectory(srcDir, outputPath, options = {}) {
  const { prefix = '', filter } = options
  const entries = []

  const walk = (dir, relBase) => {
    const items = fs.readdirSync(dir, { withFileTypes: true })
    for (const item of items) {
      const abs = path.join(dir, item.name)
      const rel = relBase ? `${relBase}/${item.name}` : item.name
      if (filter && !filter(rel, fs.statSync(abs))) continue
      if (item.isDirectory()) {
        entries.push({ name: `${prefix}${rel}/` })
        walk(abs, rel)
      } else if (item.isFile()) {
        entries.push({ name: `${prefix}${rel}`, abs })
      }
    }
  }

  walk(srcDir, '')
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return writeZip(outputPath, entries)
}
