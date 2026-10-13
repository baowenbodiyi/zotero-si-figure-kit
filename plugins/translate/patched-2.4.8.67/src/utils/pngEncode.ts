/**
 * ⭐ 补丁：一个零依赖的 PNG 编码器。
 *
 * 为什么不用 canvas：Zotero 插件跑在**纯 JS sandbox** 里（实测连 `globalThis.WebSocket`
 * 都没有），`canvas` / `Blob` / `CompressionStream` / `btoa` **全都不可用**。
 * 借别的 realm 的 canvas 会撞上 Xray（`Permission denied to access property Symbol.iterator`），
 * 那条路已经试过、走不通。所以这里自己把像素编成 PNG。
 *
 * 取舍：
 *  - deflate 用 **stored（不压缩）块** —— 不用实现 Huffman，代码短且绝不会编错；
 *    代价是文件偏大，所以**务必先降采样**（见 `downscaleBox`）。
 *  - 纯函数、不碰任何 Zotero API，因此可以**在 Node 里直接跑测试**。
 */

const SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  // CRC 覆盖 type + data
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  // 5552 是 zlib 里常用的分块长度：这一块内 a/b 不会超过 2^32
  for (let i = 0; i < data.length; ) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * 把 `raw` 包成 zlib 流，全部用 **stored（BTYPE=00）** 块。
 * PNG 的 IDAT 要的就是 zlib 格式（含 2 字节头 + 末尾 adler32）。
 */
export function zlibStored(raw: Uint8Array): Uint8Array {
  const MAX = 65535;
  const nBlocks = Math.max(1, Math.ceil(raw.length / MAX));
  const out = new Uint8Array(2 + nBlocks * 5 + raw.length + 4);
  let o = 0;
  out[o++] = 0x78; // CMF: deflate, 32K window
  out[o++] = 0x01; // FLG: (0x7801 % 31) === 0，无预设字典
  for (let i = 0; i < nBlocks; i++) {
    const start = i * MAX;
    const len = Math.min(MAX, raw.length - start);
    const last = i === nBlocks - 1 ? 1 : 0;
    out[o++] = last; // BFINAL + BTYPE=00
    out[o++] = len & 0xff;
    out[o++] = (len >>> 8) & 0xff;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o);
    o += len;
  }
  const ad = adler32(raw);
  out[o++] = (ad >>> 24) & 0xff;
  out[o++] = (ad >>> 16) & 0xff;
  out[o++] = (ad >>> 8) & 0xff;
  out[o++] = ad & 0xff;
  return out.subarray(0, o);
}

/** 盒式降采样（整数倍，逐通道平均）—— 纯 JS，够快也够清楚 */
export function downscaleBox(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  maxW: number,
): { rgba: Uint8ClampedArray; w: number; h: number } {
  const factor = Math.max(1, Math.ceil(w / maxW));
  if (factor === 1) {
    return {
      rgba: rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba),
      w,
      h,
    };
  }
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const area = factor * factor;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = y * factor + dy;
        if (sy >= h) {
          break;
        }
        let idx = (sy * w + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          if (sx >= w) {
            break;
          }
          r += rgba[idx];
          g += rgba[idx + 1];
          b += rgba[idx + 2];
          a += rgba[idx + 3];
          idx += 4;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / area;
      out[o + 1] = g / area;
      out[o + 2] = b / area;
      out[o + 3] = a / area;
    }
  }
  return { rgba: out, w: nw, h: nh };
}

/** RGBA 像素 → PNG 字节（colorType 6 = RGBA）。 */
export function encodePngRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const stride = w * 4;
  // 每行前面加一个 filter 字节（0 = None）
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), dst + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlibStored(raw);
  const cIhdr = chunk("IHDR", ihdr);
  const cIdat = chunk("IDAT", idat);
  const cIend = chunk("IEND", new Uint8Array(0));
  const total = SIG.length + cIhdr.length + cIdat.length + cIend.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(SIG, o);
  o += SIG.length;
  out.set(cIhdr, o);
  o += cIhdr.length;
  out.set(cIdat, o);
  o += cIdat.length;
  out.set(cIend, o);
  return out;
}

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * 自己实现的 base64（插件 sandbox 里**没有 `btoa`**）。
 * 同样放进这个纯模块，好在 Node 里和 `Buffer.toString("base64")` 对拍。
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let buf = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    buf +=
      B64_CHARS[b0 >> 2] +
      B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)] +
      (has1 ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=") +
      (has2 ? B64_CHARS[b2 & 63] : "=");
    if (buf.length >= 8192) {
      parts.push(buf);
      buf = "";
    }
  }
  parts.push(buf);
  return parts.join("");
}
