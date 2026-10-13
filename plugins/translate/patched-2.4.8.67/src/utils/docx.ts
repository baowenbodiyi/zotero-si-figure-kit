/**
 * 从 `.docx` 里取「图 + 图注」。
 *
 * 背景：**不少期刊的支撑信息是 Word 而不是 PDF**（实测 Elsevier 的
 * `…-mmc1.docx`）。`pdf.js` 只能读 PDF，所以这条路必须自己走：
 * `.docx` 本质是个 ZIP，图在 `word/media/`，正文在 `word/document.xml`。
 *
 * 关键的一条实测规律（两篇真 SI，29 张图）：
 *   **图独占一个段落，图注在紧邻的段落里** —— 例如
 *     p37  [image1.tiff]          （空文字，只有图）
 *     p38  "Figure S1. (a) FT-IR …"
 *   有的文件顺序反过来（先图注后图）。所以配图用 **±2 段的对称就近搜索**，
 *   而不是"第 N 个图配第 N 条图注"这种脆弱的按序对应。
 *
 * 无图的图注（实测 Table S1/S2/S3 是真 Word 表格，不是图片）会返回图片为空 ——
 * 这时只翻图注，不假装有图。
 */

import { inflateRaw } from "./inflate";

export interface DocxParagraph {
  /** 段落纯文字（`<w:t>` 拼接，tab/换行按空格处理） */
  text: string;
  /** 本段引用的媒体文件名（如 `image1.tiff`），可能多个 */
  images: string[];
  /**
   * 本"段"其实是一个 **真 Word 表格**时，这里是它的行列内容。
   *
   * 为什么需要：`<w:tbl>` 里**没有 `word/media` 图片**，
   * 只找图片的话表格一律显示不出来（实测 `Table S2` 就是 2×2 的化学方程式表格）。
   */
  table?: string[][];
}

export interface DocxDoc {
  paragraphs: DocxParagraph[];
  /** 媒体文件名 → 相对 zip 的完整路径 */
  mediaPath: Map<string, string>;
  /** 读某个 zip 条目的原始字节（按需解压，避免把 13 MB 的图全解开） */
  read: (name: string) => Uint8Array | null;
}

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function findEocd(view: DataView): number {
  const max = Math.min(view.byteLength, 0xffff + 22);
  for (let i = 22; i <= max; i++) {
    const at = view.byteLength - i;
    if (at < 0) {
      break;
    }
    if (view.getUint32(at, true) === SIG_EOCD) {
      return at;
    }
  }
  return -1;
}

function readCentralDirectory(u8: Uint8Array, view: DataView): ZipEntry[] {
  const eocd = findEocd(view);
  if (eocd < 0) {
    throw new Error("ZIP: 找不到 EOCD（不是 zip 或已损坏）");
  }
  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64：真遇到超大文件时才走这条路（docx 一般不会，但别默默读错）
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const locAt = eocd - 20;
    if (locAt >= 0 && view.getUint32(locAt, true) === SIG_EOCD64_LOC) {
      const z64 = Number(view.getBigUint64(locAt + 8, true));
      count = Number(view.getBigUint64(z64 + 32, true));
      cdOffset = Number(view.getBigUint64(z64 + 48, true));
    }
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > u8.length || view.getUint32(p, true) !== SIG_CENTRAL) {
      break;
    }
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = new TextDecoder("utf-8").decode(
      u8.subarray(p + 46, p + 46 + nameLen),
    );
    entries.push({
      name,
      method: view.getUint16(p + 10, true),
      compSize: view.getUint32(p + 20, true),
      uncompSize: view.getUint32(p + 24, true),
      localOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry(u8: Uint8Array, view: DataView, e: ZipEntry): Uint8Array | null {
  const p = e.localOffset;
  if (p + 30 > u8.length || view.getUint32(p, true) !== SIG_LOCAL) {
    return null;
  }
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const raw = u8.subarray(start, start + e.compSize);
  if (e.method === 0) {
    return raw;
  }
  if (e.method === 8) {
    return inflateRaw(raw, e.uncompSize);
  }
  throw new Error(`ZIP: 不支持的压缩方式 ${e.method}（${e.name}）`);
}

/** 解析 XML 属性值里的实体 */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 一个段落的 XML → 纯文字 + 引用的图片 */
function parseParagraph(xml: string): DocxParagraph {
  let text = "";
  // <w:t> 的文字；xml:space="preserve" 时要保留首尾空格
  const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  // 段内的 tab / 换行也算空白
  const tokenRe =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml))) {
    if (m[1] !== undefined) {
      text += unescapeXml(m[1]);
    } else {
      text += " ";
    }
  }
  void tRe;

  const images: string[] = [];
  // DrawingML：<a:blip r:embed="rId5"/>；VML：<v:imagedata r:id="rId5"/>
  const imgRe = /<a:blip[^>]*\br:embed="([^"]+)"|<v:imagedata[^>]*\br:id="([^"]+)"/g;
  let im: RegExpExecArray | null;
  while ((im = imgRe.exec(xml))) {
    images.push(im[1] ?? im[2]);
  }
  return { text: text.replace(/\s+/g, " ").trim(), images };
}

/**
 * 解析一个 `.docx`。只解压 `document.xml` 和 `_rels`（都是小文件）；
 * 图片字节等真正要用了再通过 `read()` 按需取。
 */
export function parseDocx(bytes: Uint8Array): DocxDoc {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(bytes, view);
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) {
    byName.set(e.name, e);
  }
  const readCache = new Map<string, Uint8Array | null>();
  const read = (name: string): Uint8Array | null => {
    if (readCache.has(name)) {
      return readCache.get(name) ?? null;
    }
    const e = byName.get(name);
    const out = e ? extractEntry(bytes, view, e) : null;
    readCache.set(name, out);
    return out;
  };

  const docEntry = byName.get("word/document.xml");
  if (!docEntry) {
    throw new Error("DOCX: 没有 word/document.xml（可能不是 Word 文档）");
  }
  const docXml = new TextDecoder("utf-8").decode(
    read("word/document.xml") as Uint8Array,
  );

  // ── rId → 媒体文件名
  const relXml = (() => {
    const b = read("word/_rels/document.xml.rels");
    return b ? new TextDecoder("utf-8").decode(b) : "";
  })();
  const mediaPath = new Map<string, string>();
  const rid2media = new Map<string, string>();
  const relRe = /<Relationship\b[^>]*>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relXml))) {
    const tag = rm[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    let target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (!id || !target) {
      continue;
    }
    if (!/media\//i.test(target)) {
      continue;
    }
    target = unescapeXml(target).replace(/^\.\.\//, "").replace(/^\//, "");
    const file = target.split("/").pop() as string;
    rid2media.set(id, file);
    mediaPath.set(file, target.startsWith("word/") ? target : `word/${target}`);
  }

  // ── 段落 / 表格（**按文档顺序**）
  //
  // ⚠️ 必须把 `<w:tbl>` 单独切出来，两个原因：
  //   1. **真 Word 表格里没有 `word/media` 图片** —— 只找图片的话，表格一律"没图可给"
  //      （实测：`Table S2` 是 2×2 的 `<w:tbl>`，装的是化学方程式，不是图）；
  //   2. 表格单元格里的 `<w:p>` 会被"按 `<w:p` 切段"顺带切成**一堆散段落**，
  //      既把段落序号搅乱，又可能让某个单元格文字冒充图注。
  const paragraphs: DocxParagraph[] = [];
  const BLOCK_RE =
    /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?(?=<w:tbl>|<w:p(?:\s[^>]*)?>|<\/w:body>)/g;
  let bm: RegExpExecArray | null;
  while ((bm = BLOCK_RE.exec(docXml))) {
    const chunk = bm[0];
    if (chunk.startsWith("<w:tbl>")) {
      const rows = parseTableRows(chunk);
      if (!rows.length) {
        continue;
      }
      paragraphs.push({
        // 表格的"文字"= 所有单元格拼起来，供图注判断/日志用
        text: rows
          .map((r) => r.join(" "))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        images: [],
        table: rows,
      });
    } else {
      const para = parseParagraph(chunk);
      paragraphs.push({
        text: para.text,
        images: para.images
          .map((rid) => rid2media.get(rid) ?? "")
          .filter((f) => !!f),
      });
    }
  }

  return { paragraphs, mediaPath, read };
}

/** KaTeX 行内公式里需要转义的字符（下标内容一般只有数字/字母，但别赌） */
function escMath(s: string): string {
  return s.replace(/[\\{}$%#&_^~]/g, (c) => "\\" + c);
}

/**
 * 一个 `<w:p>` → 文字，**保留上下标**。
 *
 * ⚠️ 为什么必须保留：实测化学方程式里 `Na2CO3` 的 `2` 是**独立 run**，
 *    带 `<w:vertAlign w:val="subscript"/>`。
 *    只把 `<w:t>` 拼起来会得到 `Na2CO3` —— **化学式就错了**（看着像对的，其实不是）。
 *    这里把它变成 `$_{2}$`，交给插件本来就有的 KaTeX 渲染成真下标。
 *
 * 选这条而不是"把表格截成图"：不需要额外的渲染引擎，文字仍可选中/复制，缩放不糊。
 */
function paragraphTextWithScripts(pp: string): string {
  let out = "";
  const runRe = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(pp))) {
    const run = m[0];
    const txt = Array.from(
      run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g),
    )
      .map((x) => unescapeXml(x[1]))
      .join("");
    if (!txt) {
      continue;
    }
    const va = /<w:vertAlign\s+w:val="(subscript|superscript)"\s*\/>/.exec(run);
    if (va) {
      const mark = va[1] === "subscript" ? "_" : "^";
      // ⚠️ 空格要留在公式**外面**：`'3 '` 这种 run 里的尾随空格是词间分隔，
      //    塞进 $_{3 }$ 会变成"下标里带空格"，而直接 trim 又会把 `Na2CO3 + 2C` 粘成 `Na2CO3+ 2C`
      const lead = /^\s*/.exec(txt)![0];
      const trail = /\s*$/.exec(txt)![0];
      const core = txt.trim();
      out += core ? `${lead}$${mark}{${escMath(core)}}$${trail}` : txt;
    } else {
      out += txt;
    }
  }
  return out.replace(/[ \t]+/g, " ").trim();
}

/** 一个 `<w:tbl>` → 二维字符串（按 `<w:tr>` / `<w:tc>` 拆；不做合并单元格还原） */
function parseTableRows(xml: string): string[][] {
  const rows: string[][] = [];
  for (const tr of xml.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []) {
    const cells: string[] = [];
    for (const tc of tr.match(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g) ?? []) {
      // ⚠️ 单元格里常有**多个段落**（化学方程式就是一个反应一行）。
      //    直接把所有 <w:t> 拼成一串会粘成 "2H22NaOH" 这种鬼东西，
      //    必须按段落切、段间补换行 —— 渲染时靠 white-space: pre-wrap 还原成多行。
      const paras =
        tc.match(/<w:p(?:\s[^>]*)?>[\s\S]*?(?=<w:p(?:\s[^>]*)?>|<\/w:tc>)/g) ??
        [];
      const lines = paras
        .map(paragraphTextWithScripts)
        .filter((l) => l.length > 0);
      cells.push(lines.join("\n"));
    }
    if (cells.length) {
      rows.push(cells);
    }
  }
  return rows;
}

/**
 * 一段文字是不是「图注段」（段首就是 `Figure S1` / `Table S2` 这种标签）。
 *
 * 用途只有一个，但很关键：**防止就近取图越位抢走邻居图注的图**（见下）。
 */
const CAPTION_START_RE =
  /^\s*(?:Figures?|Figs?\.?|Tables?|Tabs?\.?|Schemes?|Charts?|Equations?|Eqs?\.?)\s*S\s*\d/i;

function isCaptionParagraph(text: string): boolean {
  return CAPTION_START_RE.test(text ?? "");
}

/**
 * 从 `Figure S6b` 里抠出 S 后面的编号与子图字母。
 * 抠不出来返回 null（调用方退回"整串当字面量"的老办法）。
 */
function splitSiLabel(label: string): { num: string; sub: string } | null {
  const m = /S\s*(\d{1,3})([a-z]?)\s*$/i.exec((label ?? "").trim());
  return m ? { num: m[1], sub: m[2] || "" } : null;
}

/**
 * 生成"段首是这个图注标签"的正则。
 *
 * ⚠️⚠️ 这里必须接受**类别词的缩写写法**，这是实测踩出来的坑：
 *   很多期刊的 SI 图注写成 **`Fig. S3.`**（缩写 + 句点），
 *   而 `parseSiRefs` 会把正文里的引用规范化成 `Figure S3`。
 *   只拿规范写法去文档里搜 → **整篇 Figure 全部定位不到**。
 *   实测某 SI：113 段 / 19 张图，Figure S3/S5/S6/S7/S8/S17 全 miss，
 *   而写全称的 `Table S1` 能中 —— 差别就在这一个句点上。
 *
 * PDF 那条路（`findCaptionPage`）本来就有 `Figs?\.?` 这套变体，所以只有 Word 这边漏了。
 * `kindPattern` 由调用方从 `KIND_WORDS` 传进来，让两条路**共用同一套写法**。
 */
function captionRe(
  label: string,
  kindPattern: string | undefined,
  tail: string,
): RegExp {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = splitSiLabel(label);
  if (!parts) {
    // 解析不出来：老实按字面量找（段首锚定，允许内部空白）
    return new RegExp(
      `^\\s*${esc(label).replace(/\\?\s+/g, "\\s*")}${tail}`,
      "i",
    );
  }
  // 类别词：优先用调用方给的变体（Figures?|Figs?\.?|图…），兜底给一套常见缩写
  const kind = `(?:${kindPattern || "Figures?|Figs?\\.?"})`;
  // 「S」前后允许空格，类别词后面允许一个句点：`Fig. S3` / `Fig S 3` / `Figure S3` 都吃
  return new RegExp(
    `^[ \\t]*${kind}[ \\t]*\\.?[ \\t]*S[ \\t]*${parts.num}${parts.sub}${tail}`,
    "i",
  );
}

/**
 * 在段落里找某条引用（`Figure S3`）的图注段，并返回**就近**的图片文件名。
 *
 * `label` / `baseLabel` 由调用方按已归一化的引用给出（如 ["Figure S3", "Figure S3"]）。
 * 只在段首认标签 —— 表格说明里常行内引用别的图（"as shown in Figure S6b"），
 * 不加这条限制就会张冠李戴。
 *
 * `kindPattern` 可选：类别词的正则变体（由 `siRefs.ts` 传 `KIND_WORDS[kind]`），
 * 使 Word 与 PDF 两条路认同一套写法。
 */
export function findDocxFigure(
  doc: DocxDoc,
  label: string,
  baseLabel: string,
  kindPattern?: string,
): {
  paragraphIndex: number;
  caption: string;
  image: string | null;
  table: string[][] | null;
} | null {
  const reExact = captionRe(label, kindPattern, "(?![0-9A-Za-z])");
  const reBase = captionRe(baseLabel, kindPattern, "(?![0-9])");

  let hit = -1;
  for (let i = 0; i < doc.paragraphs.length; i++) {
    if (reExact.test(doc.paragraphs[i].text)) {
      hit = i;
      break;
    }
  }
  if (hit < 0) {
    for (let i = 0; i < doc.paragraphs.length; i++) {
      if (reBase.test(doc.paragraphs[i].text)) {
        hit = i;
        break;
      }
    }
  }
  if (hit < 0) {
    return null;
  }

  // ⭐ 就近取图：优先级 上一段 → 下一段 → 本段 → 上二 → 下二。
  //
  // ⚠️ 距离 2 是**有条件的**：只有当中间那一段**不是图注**时才允许。
  // 真实排版里，"图注和图之间夹一个空段"很常见（实测 26 张图里有 2 张是这样，
  // 中间段文字为空），所以 ±2 必须留着；但若不设防，一个**本身没有图**的图注
  // 会隔着邻居的图注把它的图抢过来 —— 那就显示出**错误的图**了
  // （构造 fixture 时实测到：Figure S2 抢走了 Figure S1 的图）。
  // 加这一条，两种情形都满足：空段可以跳，别的图注不能越。
  const mids = doc.paragraphs;
  const order: number[] = [hit - 1, hit + 1, hit];
  if (!isCaptionParagraph(mids[hit - 1]?.text ?? "")) {
    order.push(hit - 2);
  }
  if (!isCaptionParagraph(mids[hit + 1]?.text ?? "")) {
    order.push(hit + 2);
  }

  let image: string | null = null;
  for (const idx of order) {
    const p = doc.paragraphs[idx];
    if (p && p.images.length) {
      image = p.images[0];
      break;
    }
  }

  // ⭐ 没有图 → 找**邻近的真 Word 表格**（表格不是图片，上面那轮永远找不到）
  const table = image ? null : findNearbyTable(doc.paragraphs, hit);

  return { paragraphIndex: hit, caption: doc.paragraphs[hit].text, image, table };
}

/**
 * 找与图注配套的 Word 表格。
 *
 * 规则（和取图的"±2 就近"不同，因为表格是**块级**的，隔着另一个图注抢过来必错）：
 *   1. 先**往后**找，遇到下一个图注段就停 —— 封面式排版多是「图注在上、表格在下」；
 *   2. 再**往前**找，同样遇到图注就停 —— 有些排版反过来。
 *
 * 实测为什么要这样：某 SI 的块序是
 *   [10] Table S1 图注 → [11] Table S1 表格 → [12] Table S2 图注 → [13] Table S2 表格
 * 若按"上一块优先"，Table S2 会抢走 **Table S1** 的表。
 */
function findNearbyTable(
  paras: DocxParagraph[],
  hit: number,
): string[][] | null {
  for (let i = hit + 1; i < paras.length; i++) {
    if (isCaptionParagraph(paras[i].text)) {
      break;
    }
    if (paras[i].table?.length) {
      return paras[i].table ?? null;
    }
  }
  for (let i = hit - 1; i >= 0; i--) {
    if (isCaptionParagraph(paras[i].text)) {
      break;
    }
    if (paras[i].table?.length) {
      return paras[i].table ?? null;
    }
  }
  return null;
}
