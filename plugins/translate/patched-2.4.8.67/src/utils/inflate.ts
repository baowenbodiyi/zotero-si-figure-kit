/**
 * 纯 JS 的 raw DEFLATE 解压（RFC1951，无 zlib 头）。
 *
 * 为什么不用平台的 `DecompressionStream`：
 *   插件跑在 Zotero 的 bootstrap **Sandbox** 里，那里能拿到哪些 WebIDL 全局
 *   并不确定（不像 reader 窗口是完整 chrome 窗口）。而解 `.docx` 是 Word SI
 *   的必经步骤，不能赌一个"运行时也许有"的 API —— 之前已经栽过好几次
 *   （`navigator`、`cloneInto`、reader realm）。所以这里自己实现，任何 realm 都能跑，
 *   而且**能在 Node 里对着 zlib 逐字节验证**。
 *
 * 算法照 puff/tiny-inflate 的规范实现（逐位 Huffman 解码）：
 * 慢一点但每行都能对应到 RFC，比查表版本好审。
 */

/** 位读取器：DEFLATE 的位序是 **LSB-first** */
class BitReader {
  private readonly buf: Uint8Array;
  private pos = 0;
  private bitbuf = 0;
  private bitcnt = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  /** 读 need 个 bit（need ≤ 16） */
  bits(need: number): number {
    let val = this.bitbuf;
    while (this.bitcnt < need) {
      if (this.pos >= this.buf.length) {
        throw new Error("inflate: 数据提前结束（位流截断）");
      }
      val |= this.buf[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    this.bitbuf = val >>> need;
    this.bitcnt -= need;
    return val & ((1 << need) - 1);
  }

  /** 丢弃当前字节里剩余的位（stored 块用） */
  align(): void {
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  /** 当前字节位置 */
  get offset(): number {
    return this.pos;
  }

  /** 读一个字节（调用前必须 align） */
  byte(): number {
    if (this.pos >= this.buf.length) {
      throw new Error("inflate: 读字节越界");
    }
    return this.buf[this.pos++];
  }
}

interface Huffman {
  counts: Int32Array;
  symbols: Int32Array;
}

/** 由码长表构造规范 Huffman（puff 的做法：只存 counts + 按码长排序的符号表） */
function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Int32Array(16);
  for (let i = 0; i < n; i++) {
    counts[lengths[i]]++;
  }
  counts[0] = 0;
  const offs = new Int32Array(16);
  for (let i = 1; i < 16; i++) {
    offs[i] = offs[i - 1] + counts[i - 1];
  }
  const symbols = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (lengths[i]) {
      symbols[offs[lengths[i]]++] = i;
    }
  }
  return { counts, symbols };
}

/** 解一个 Huffman 符号（逐位：len 从 1 到 15，累积码值后和 first 比较） */
function decodeSym(br: BitReader, h: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len <= 15; len++) {
    code |= br.bits(1);
    const count = h.counts[len];
    if (code - first < count) {
      return h.symbols[index + (code - first)];
    }
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("inflate: Huffman 码非法");
}

const LEN_BASE = new Int32Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67,
  83, 99, 115, 131, 163, 195, 227, 258,
]);
const LEN_EXTRA = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5,
  5, 5, 5, 0,
]);
const DIST_BASE = new Int32Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Int32Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13,
]);
/** 动态块里码长码的传输顺序（RFC1951 §3.2.7） */
const CLC_ORDER = new Int32Array([
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
]);

const FIXED_LIT: Huffman = (() => {
  const l = new Int32Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return buildHuffman(l, 288);
})();
const FIXED_DIST: Huffman = (() => {
  const l = new Int32Array(30).fill(5);
  return buildHuffman(l, 30);
})();

/**
 * 解压一段 raw DEFLATE 数据。
 *
 * @param input 压缩数据
 * @param expected 已知的解压后长度（ZIP 目录里有）；给了就一次性分配，
 *                 没给则按 64 KB 增长 —— 只有「已知长度」这条路径会被 DOCX 用到。
 */
export function inflateRaw(input: Uint8Array, expected?: number): Uint8Array {
  const br = new BitReader(input);
  let out = new Uint8Array(expected && expected > 0 ? expected : 1 << 16);
  let outPos = 0;

  const grow = (need: number): void => {
    if (outPos + need <= out.length) {
      return;
    }
    let cap = out.length * 2;
    while (cap < outPos + need) {
      cap *= 2;
    }
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, outPos));
    out = bigger;
  };

  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);

    if (type === 0) {
      // ── stored：原始字节，先对齐到字节边界
      br.align();
      const len = br.byte() | (br.byte() << 8);
      const nlen = br.byte() | (br.byte() << 8);
      if ((len ^ 0xffff) !== nlen) {
        throw new Error("inflate: stored 块的 LEN/NLEN 不匹配");
      }
      grow(len);
      for (let i = 0; i < len; i++) {
        out[outPos++] = br.byte();
      }
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        lit = FIXED_LIT;
        dist = FIXED_DIST;
      } else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clcLens = new Int32Array(19);
        for (let i = 0; i < hclen; i++) {
          clcLens[CLC_ORDER[i]] = br.bits(3);
        }
        const clc = buildHuffman(clcLens, 19);
        const lens = new Int32Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const sym = decodeSym(br, clc);
          if (sym < 16) {
            lens[i++] = sym;
          } else if (sym === 16) {
            if (i === 0) {
              throw new Error("inflate: 码长重复码出现在开头");
            }
            const prev = lens[i - 1];
            const rep = 3 + br.bits(2);
            for (let k = 0; k < rep && i < lens.length; k++) {
              lens[i++] = prev;
            }
          } else if (sym === 17) {
            const rep = 3 + br.bits(3);
            for (let k = 0; k < rep && i < lens.length; k++) {
              lens[i++] = 0;
            }
          } else {
            const rep = 11 + br.bits(7);
            for (let k = 0; k < rep && i < lens.length; k++) {
              lens[i++] = 0;
            }
          }
        }
        lit = buildHuffman(lens, hlit);
        dist = buildHuffman(lens.subarray(hlit), hdist);
      }

      for (;;) {
        const sym = decodeSym(br, lit);
        if (sym < 256) {
          grow(1);
          out[outPos++] = sym;
          continue;
        }
        if (sym === 256) {
          break;
        }
        const li = sym - 257;
        if (li >= LEN_BASE.length) {
          throw new Error(`inflate: 长度码越界 ${sym}`);
        }
        const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
        const dsym = decodeSym(br, dist);
        const distance = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
        if (distance > outPos) {
          throw new Error("inflate: 回溯距离超出已输出范围");
        }
        grow(length);
        let src = outPos - distance;
        for (let i = 0; i < length; i++) {
          out[outPos++] = out[src++];
        }
      }
    } else {
      throw new Error("inflate: 非法的块类型 3");
    }

    if (final) {
      break;
    }
  }

  return out.subarray(0, outPos);
}
