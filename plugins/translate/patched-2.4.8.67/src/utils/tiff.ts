/**
 * 最小 TIFF 解码器：把 SI（Word）里嵌的图变成 RGBA。
 *
 * 为什么非要有这个：Elsevier 的 Word 版 SI 里图是 **TIFF**，而且
 *   实测（两篇真 SI，29 张图，参数完全一致）：
 *     压缩 = **LZW(5)**、Photometric = RGB(2)、BitsPerSample = 8/8/8/8、
 *     SamplesPerPixel = 4、**Predictor = 2（水平差分）**、单 strip、不压缩存储。
 *   Firefox **不能**在 `<img>` 里渲染 TIFF（`data:image/tiff` 是死路），
 *   所以必须先解成像素、再交给 canvas 编成真 PNG。
 *
 * 支持范围按"实际会遇到"来定（够用就好，不追求全 TIFF 规范）：
 *   压缩：1 无 / 5 LZW / 8·32946 Deflate / 32773 PackBits
 *   光度：0 白零 / 1 黑零 / 2 RGB / 3 调色板
 *   位深：8（1 位双色也顺手支持，CCITT 传真压缩明确不支持 → 报错而不是出错图）
 *   Predictor：1 / 2
 *   布局：chunky（PlanarConfig=1）；Planar=2 报错
 */

import { inflateRaw } from "./inflate";

export interface TiffImage {
  width: number;
  height: number;
  /** RGBA，长度 = width*height*4 */
  rgba: Uint8ClampedArray;
}

interface Ifd {
  /** tag → 值数组（数值型都归一成 number[]） */
  tags: Map<number, number[] | Uint8Array>;
}

const COMPRESSION_NONE = 1;
const COMPRESSION_LZW = 5;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_DEFLATE_OLD = 32946;
const COMPRESSION_PACKBITS = 32773;

function readIfd(view: DataView, u8: Uint8Array, le: boolean, offset: number): Ifd {
  const tags = new Map<number, number[] | Uint8Array>();
  const count = view.getUint16(offset, le);
  for (let i = 0; i < count; i++) {
    const p = offset + 2 + i * 12;
    const tag = view.getUint16(p, le);
    const type = view.getUint16(p + 2, le);
    const num = view.getUint32(p + 4, le);
    // 每个类型占的字节数
    const sizeOf: Record<number, number> = {
      1: 1, // BYTE
      2: 1, // ASCII
      3: 2, // SHORT
      4: 4, // LONG
      5: 8, // RATIONAL
      6: 1,
      7: 1,
      8: 2, // SSHORT
      9: 4, // SLONG
      10: 8,
      11: 4, // FLOAT
      12: 8,
    };
    const unit = sizeOf[type] ?? 1;
    const total = unit * num;
    // ≤4 字节直接内联在 entry 里
    const at = total <= 4 ? p + 8 : view.getUint32(p + 8, le);

    if (type === 1 || type === 6 || type === 7) {
      const arr = u8.subarray(at, at + total);
      tags.set(tag, arr);
    } else {
      const arr: number[] = [];
      for (let k = 0; k < num; k++) {
        const q = at + k * unit;
        if (type === 3 || type === 8) {
          arr.push(type === 8 ? view.getInt16(q, le) : view.getUint16(q, le));
        } else if (type === 4 || type === 9) {
          arr.push(type === 9 ? view.getInt32(q, le) : view.getUint32(q, le));
        } else if (type === 11) {
          arr.push(view.getFloat32(q, le));
        } else if (type === 5 || type === 10) {
          // RATIONAL：取分子/分母的商（本解码器用不到，但别炸）
          const n = view.getUint32(q, le);
          const d = view.getUint32(q + 4, le) || 1;
          arr.push(n / d);
        } else {
          arr.push(0);
        }
      }
      tags.set(tag, arr);
    }
  }
  return { tags };
}

/** 取一个数值数组；单值返回 [v] */
function nums(ifd: Ifd, tag: number): number[] | null {
  const v = ifd.tags.get(tag);
  if (!v) {
    return null;
  }
  if (v instanceof Uint8Array) {
    return Array.from(v);
  }
  return v;
}

function num(ifd: Ifd, tag: number, dflt: number): number {
  const v = nums(ifd, tag);
  return v && v.length ? v[0] : dflt;
}

/** TIFF 的 LZW：**MSB-first** 打包，且码宽比标准早一位增长（early change = 1） */
function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let outPos = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  const firstChar = (code: number): number => {
    let c = code;
    while (c >= 256) {
      c = prefix[c];
    }
    return c;
  };

  let bits = 9;
  let nextCode = 258;
  let prevCode = -1;
  let bitBuf = 0;
  let bitCnt = 0;
  let pos = 0;

  const getCode = (): number => {
    while (bitCnt < bits) {
      if (pos >= src.length) {
        return -1;
      }
      bitBuf = (bitBuf << 8) | src[pos++];
      bitCnt += 8;
    }
    bitCnt -= bits;
    return (bitBuf >> bitCnt) & ((1 << bits) - 1);
  };

  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
  }

  for (;;) {
    let code = getCode();
    if (code < 0 || code === 257) {
      break;
    }
    if (code === 256) {
      bits = 9;
      nextCode = 258;
      prevCode = -1;
      continue;
    }
    const inCode = code;
    let sp = 0;
    if (code >= nextCode) {
      // KwKwK：码还没进字典，等于「上一个串 + 它的首字符」
      if (prevCode < 0) {
        throw new Error("TIFF LZW: 首个码越界");
      }
      stack[sp++] = firstChar(prevCode);
      code = prevCode;
    }
    while (code >= 256) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    const first = code;
    stack[sp++] = suffix[code];
    while (sp > 0) {
      if (outPos >= out.length) {
        break;
      }
      out[outPos++] = stack[--sp];
    }
    if (prevCode >= 0 && nextCode < 4096) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = first;
      nextCode++;
      // ⭐ early change：TIFF 在这一步就加宽（不是等到 2^bits）
      if (nextCode === (1 << bits) - 1 && bits < 12) {
        bits++;
      }
    }
    prevCode = inCode;
  }
  return out.subarray(0, outPos);
}

function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (i < src.length && o < out.length) {
    const n = (src[i++] << 24) >> 24; // 有符号
    if (n >= 0) {
      for (let k = 0; k <= n && i < src.length && o < out.length; k++) {
        out[o++] = src[i++];
      }
    } else if (n !== -128) {
      const b = src[i++];
      for (let k = 0; k < 1 - n && o < out.length; k++) {
        out[o++] = b;
      }
    }
  }
  return out.subarray(0, o);
}

/**
 * 把（可能不止一条的）strip 拼成一条连续的行数据。
 *
 * ⚠️ 每条 strip 都是一条**独立的**压缩流，所以解压时必须按"这条 strip 覆盖多少行"
 * 算目标长度 —— 单 strip（实测的 SI 全是这种）时它就等于全图长度。
 */
function readStrips(
  u8: Uint8Array,
  ifd: Ifd,
  compression: number,
  rowBytes: number,
  height: number,
): Uint8Array {
  const offsets = nums(ifd, 273) ?? [];
  let counts = nums(ifd, 279) ?? [];
  const rowsPerStrip = num(ifd, 278, height) || height;
  const nStrips = Math.max(1, Math.ceil(height / rowsPerStrip));
  if (counts.length === 1 && nStrips > 1) {
    // 有些写出器只给一个 count，含义是"每 strip 一样大"
    counts = new Array(nStrips).fill(counts[0]);
  }

  const out = new Uint8Array(rowBytes * height);
  let o = 0;
  for (let s = 0; s < offsets.length; s++) {
    const start = offsets[s];
    const len = counts[s] ?? 0;
    const rows = Math.max(0, Math.min(rowsPerStrip, height - s * rowsPerStrip));
    const want = rows * rowBytes;
    if (want <= 0) {
      continue;
    }
    const raw = u8.subarray(start, start + len);
    let part: Uint8Array;
    if (compression === COMPRESSION_NONE) {
      part = raw;
    } else if (compression === COMPRESSION_LZW) {
      part = lzwDecode(raw, want);
    } else if (compression === COMPRESSION_PACKBITS) {
      part = packBitsDecode(raw, want);
    } else {
      part = inflateRaw(raw);
    }
    const n = Math.min(part.length, want, out.length - o);
    out.set(part.subarray(0, n), o);
    o += n;
  }
  return out;
}

/** Predictor=2：逐行水平差分还原 */
function undoPredictor2(
  data: Uint8Array,
  width: number,
  height: number,
  spp: number,
  bitsPerSample: number,
): void {
  const rowBytes = Math.ceil((width * spp * bitsPerSample) / 8);
  if (bitsPerSample % 8 !== 0) {
    throw new Error("TIFF: Predictor=2 只支持整字节位深");
  }
  const bps = bitsPerSample / 8;
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes;
    if (row + rowBytes > data.length) {
      break;
    }
    for (let i = spp * bps; i < rowBytes; i++) {
      data[row + i] = (data[row + i] + data[row + i - spp * bps]) & 0xff;
    }
  }
}

export function decodeTiff(bytes: Uint8Array): TiffImage {
  if (bytes.length < 8) {
    throw new Error("TIFF: 文件太短");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const b0 = bytes[0];
  const b1 = bytes[1];
  const le = b0 === 0x49 && b1 === 0x49;
  const be = b0 === 0x4d && b1 === 0x4d;
  if (!le && !be) {
    throw new Error("TIFF: 魔数不对（不是 II/MM）");
  }
  const magic = view.getUint16(2, le);
  if (magic !== 42) {
    throw new Error(`TIFF: 版本号不是 42（${magic}，可能是 BigTIFF，暂不支持）`);
  }

  const ifdOffset = view.getUint32(4, le);
  const ifd = readIfd(view, bytes, le, ifdOffset);

  const width = num(ifd, 256, 0);
  const height = num(ifd, 257, 0);
  if (!width || !height) {
    throw new Error("TIFF: 缺宽度/高度");
  }
  const spp = num(ifd, 277, 1);
  const bitsArr = nums(ifd, 258) ?? [8];
  const bps = bitsArr[0];
  const compression = num(ifd, 259, 1);
  const photometric = num(ifd, 262, 1);
  const predictor = num(ifd, 317, 1);
  const planar = num(ifd, 284, 1);
  const extraSamples = nums(ifd, 338) ?? [];

  if (planar !== 1) {
    throw new Error(`TIFF: PlanarConfig=${planar}（分离通道）暂不支持`);
  }
  if (![1, 5, 8, 32946, 32773].includes(compression)) {
    throw new Error(`TIFF: 不支持的压缩方式 ${compression}`);
  }
  if (bps !== 8 && bps !== 1) {
    throw new Error(`TIFF: 不支持的位深 ${bps}`);
  }

  const rowBytes = Math.ceil((width * spp * bps) / 8);
  const data = readStrips(bytes, ifd, compression, rowBytes, height);

  if (predictor === 2) {
    undoPredictor2(data, width, height, spp, bps);
  } else if (predictor !== 1) {
    throw new Error(`TIFF: 不支持的 Predictor ${predictor}`);
  }

  // ── 展开成 RGBA
  const rgba = new Uint8ClampedArray(width * height * 4);

  if (photometric === 3) {
    // 调色板
    const cm = nums(ifd, 320);
    if (!cm || cm.length < 3 * 256) {
      throw new Error("TIFF: 调色板型但缺 ColorMap");
    }
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const v = data[i];
      rgba[i * 4] = cm[v] >> 8;
      rgba[i * 4 + 1] = cm[256 + v] >> 8;
      rgba[i * 4 + 2] = cm[512 + v] >> 8;
      rgba[i * 4 + 3] = 255;
    }
    return { width, height, rgba };
  }

  if (bps === 1) {
    // 双色（WhiteIsZero=0 / BlackIsZero=1）
    const zeroIsWhite = photometric === 0;
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const bit = (data[i >> 3] >> (7 - (i & 7))) & 1;
      const v = zeroIsWhite ? (bit ? 0 : 255) : bit ? 255 : 0;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    return { width, height, rgba };
  }

  const n = width * height;
  if (photometric === 2) {
    // RGB（可能带 alpha）
    const hasAlpha = spp >= 4 && extraSamples.length > 0;
    for (let i = 0; i < n; i++) {
      const s = i * spp;
      rgba[i * 4] = data[s];
      rgba[i * 4 + 1] = data[s + 1];
      rgba[i * 4 + 2] = data[s + 2];
      rgba[i * 4 + 3] = spp >= 4 ? (hasAlpha ? data[s + 3] : 255) : 255;
    }
    return { width, height, rgba };
  }

  // 灰度（0 = 白零，1 = 黑零），可能带 alpha
  const zeroIsWhite = photometric === 0;
  for (let i = 0; i < n; i++) {
    const g = zeroIsWhite ? 255 - data[i * spp] : data[i * spp];
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = spp >= 2 ? data[i * spp + 1] : 255;
  }
  return { width, height, rgba };
}
