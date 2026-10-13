/**
 * ⭐ 补丁：正文里引用的 SI（支撑信息）图注 → 在翻译框旁边给出可点的入口。
 *
 * 需求原话：「需要支撑信息的图，就从支撑信息的文档里把那几个图搞出来，附在旁边」。
 *
 * 现实约束：把 SI 里那张图**当图片抠出来**贴进弹窗做不到 —— 弹窗是 XUL/HTML，
 * Zotero 的 reader 没有「导出某页某区域为图片」的公开接口，硬做要自己跑 pdf.js
 * 渲染再裁剪，又脆又慢。所以这一版走**定位**：给出
 *     `Figure S18 · SI 第 4 页`
 * 的标签 + 该图注原文，点一下用 Zotero 自己的阅读器跳到那一页 ——
 * 图就在旁边，而且是矢量的、可缩放、可复制。
 *
 * 数据来源：SI 附件已索引的全文（`item.attachmentText`），按 `\f` 分页，
 * 段落下标 == PDF 的 0-based 页码（实测 19 页 SI 完全对上）。
 *
 * ⚠️ 只认带 `S` 的编号（`Figure S18`）。正文里的 `Figure 3` 指的是这篇论文自己的图，
 * 不是 SI —— 靠这个 `S` 把两者分开，这是本模块唯一的一道关键防线。
 */
import { debugLog } from "./debugLog";
import type { DocxDoc } from "./docx";
import { findDocxFigure, parseDocx } from "./docx";

/** 插件 realm 的全局（拿 IOUtils 等） */
function g(): any {
  return globalThis as any;
}

export interface SiRef {
  /** 归一化后的类别，如 "Figure" / "Table" / "Scheme" */
  kind: string;
  /** 编号（可能带子图字母），如 "18" / "6b" */
  num: string;
  /** 去掉子图字母的基号，如 "6b" → "6"，用于回退查找 */
  baseNum: string;
  /** 显示用标签，如 "Figure S6b" */
  label: string;
}

/** 一个引用最终解析出来的落点 */
export interface SiTarget {
  ref: SiRef;
  attachmentId: number;
  attachmentTitle: string;
  /**
   * SI 的形态：
   *  · `pdf`  → 按页定位，`pageIndex` 有用，图由 pdf.js 取
   *  · `word` → 没有页的概念，`pageIndex` 恒为 null，图从 `.docx` 的 `word/media/` 里取
   *  · `doc`  → 老的二进制 Word，不是 zip，**取不了图**（但能打开），要给准确提示
   */
  kind: "pdf" | "word" | "doc";
  /** 0-based 页码；null = 没定位到（Word SI 恒为 null） */
  pageIndex: number | null;
  /** Word SI：媒体文件名（如 `image3.tiff`）；PDF 为 null */
  media: string | null;
  /**
   * Word SI：配套的**真 Word 表格**内容（行列）。没有表格则为 null。
   *
   * 为什么单列一档：表格在 `.docx` 里是 `<w:tbl>`，**没有 word/media 图片**，
   * 所以"取图"那条路对它永远返回空。实测 `Table S2` 就是这种（2×2 化学方程式表格）。
   */
  table: string[][] | null;
  /** 图注原文（截断过），没定位到则为空 */
  caption: string;
}

const KIND_CANON: Record<string, string> = {
  figure: "Figure",
  fig: "Figure",
  figs: "Figure",
  table: "Table",
  tab: "Table",
  tabs: "Table",
  scheme: "Scheme",
  schemes: "Scheme",
  chart: "Chart",
  charts: "Chart",
  equation: "Equation",
  eq: "Equation",
  eqs: "Equation",
  // 中文译文里可能是「图 S18」「表 S2」
  图: "Figure",
  图注: "Figure",
  表: "Table",
  方案: "Scheme",
  式: "Equation",
};

/** 各类别在 SI 全文里的写法（用于找图注所在页） */
const KIND_WORDS: Record<string, string> = {
  Figure: "Figures?|Figs?\\.?|图",
  Table: "Tables?|Tabs?\\.?|表",
  Scheme: "Schemes?|方案",
  Chart: "Charts?|图",
  Equation: "Equations?|Eqs?\\.?|式",
};

/**
 * 从一段文字里挑出所有 SI 引用。
 *
 * 两个正则分开写：英文那套靠 `\b` 卡词边界，中文那套没有词边界可用。
 * 顺序按**首次出现**排（阅读顺序），不按编号大小 —— 用户是按正文往下读的。
 */
export function parseSiRefs(text: string): SiRef[] {
  if (!text) return [];
  const out: SiRef[] = [];
  const seen = new Set<string>();

  const push = (rawKind: string, num: string) => {
    const kind = KIND_CANON[rawKind.toLowerCase().replace(/\./g, "")];
    if (!kind) return;
    const clean = num.toLowerCase();
    const label = `${kind} S${clean}`;
    if (seen.has(label)) return;
    seen.add(label);
    out.push({
      kind,
      num: clean,
      baseNum: clean.replace(/[a-z]+$/, ""),
      label,
    });
  };

  const en =
    /\b(Figures?|Figs?|Tables?|Tabs?|Schemes?|Charts?|Equations?|Eqs?)(\.)?[ \t]*S[ \t]*(\d{1,3}[a-z]?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = en.exec(text))) {
    push(m[1], m[3]);
  }

  const zh = /(图注|图|表|方案|式)[ \t]*S[ \t]*(\d{1,3}[a-z]?)/gi;
  while ((m = zh.exec(text))) {
    push(m[1], m[2]);
  }

  return out;
}

const SI_TITLE_RE = /^\s*\[SI\]/i;

function siScore(item: Zotero.Item): number {
  let s = 0;
  let title = "";
  try {
    title = (item.getField("title") as string) || "";
  } catch {
    /* 附件通常没有 title 字段，走下面的 fileName */
  }
  let path = "";
  try {
    path = item.attachmentPath || "";
  } catch {
    /* ignore */
  }
  const hay = `${title} ${path}`;

  if (SI_TITLE_RE.test(title)) s += 10;
  if (/support(ing)?[\s_-]*(information|data|material)/i.test(hay)) s += 6;
  if (/supplement/i.test(hay)) s += 4;
  // 标题里单独一个 SI 词（前后是分隔符）
  if (/(^|[\s\][(_-])SI([\s\][()_-]|$)/.test(title)) s += 3;
  try {
    if (
      item
        .getTags()
        .some((t) => /^SI$/i.test(t.tag) || /supporting/i.test(t.tag))
    ) {
      s += 5;
    }
  } catch {
    /* ignore */
  }
  return s;
}

/**
 * 在**同一父条目**下找 SI 附件。找不到返回 null，调用方静默降级。
 *
 * 只在兄弟附件里找，且要求真的「像 SI」（阈值 3）——
 * 一篇论文常有正文 PDF + 各种补充文件，随便挑一个错的比不显示更糟。
 */
export function findSiAttachment(itemId: number | undefined): Zotero.Item | null {
  if (!itemId) return null;
  try {
    const item = Zotero.Items.get(itemId);
    if (!item) return null;

    let pool: Zotero.Item[] = [];
    if (item.isAttachment()) {
      const parent = item.parentItem;
      if (!parent) return null;
      pool = parent
        .getAttachments()
        .map((id) => Zotero.Items.get(id))
        .filter((a): a is Zotero.Item => !!a && a.id !== item.id);
    } else if (item.isRegularItem()) {
      pool = item
        .getAttachments()
        .map((id) => Zotero.Items.get(id))
        .filter((a): a is Zotero.Item => !!a);
    }

    // ⭐ 不再只认 PDF：**不少期刊的 SI 是 Word**（Elsevier 的 `…-mmc1.docx`）。
    // 之前这里写死 `application/pdf`，Word SI 等于不存在 —— 浮窗永远不出现。
    pool = pool.filter((a) => a.isAttachment() && siKind(a) !== "other");

    let best: Zotero.Item | null = null;
    let bestScore = 0;
    for (const a of pool) {
      const sc = siScore(a);
      if (sc > bestScore) {
        bestScore = sc;
        best = a;
      }
    }
    void debugLog(
      "si",
      `findSiAttachment(item ${itemId}): ${pool.length} 个候选` +
        `(${pool.map((a) => siKind(a)).join("/")}), 最佳得分 ${bestScore}`,
    );
    return bestScore >= 3 ? best : null;
  } catch (e) {
    void debugLog("si", `findSiAttachment 失败: ${e}`);
    return null;
  }
}

/**
 * SI 附件是 PDF 还是 Word。
 *
 * ⚠️ 只把 **`.docx`** 当真能取图的 Word —— 老的二进制 `.doc` 不是 zip，
 * 解析必然失败，所以单列一档，好给出准确的提示而不是"没找到图"。
 */
export function siKind(item: Zotero.Item): "pdf" | "word" | "doc" | "other" {
  let ct = "";
  let fn = "";
  try {
    ct = item.attachmentContentType || "";
  } catch {
    /* ignore */
  }
  try {
    fn = (item.attachmentFilename || "").toLowerCase();
  } catch {
    /* ignore */
  }
  if (ct === "application/pdf" || /\.pdf$/.test(fn)) {
    return "pdf";
  }
  if (
    ct ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    /\.docx$/.test(fn)
  ) {
    return "word";
  }
  if (ct === "application/msword" || /\.doc$/.test(fn)) {
    return "doc";
  }
  return "other";
}

/** 拿 SI 全文并按页切开（按附件 id 缓存，一个附件只读一次） */
const pageCache = new Map<number, Promise<string[]>>();

export function getSiPages(item: Zotero.Item): Promise<string[]> {
  const hit = pageCache.get(item.id);
  if (hit) return hit;
  const job = (async () => {
    let text = "";
    try {
      text =
        (await (item as unknown as { attachmentText: Promise<string> })
          .attachmentText) || "";
    } catch (e) {
      void debugLog("si", `attachmentText 失败: ${e}`);
    }
    if (!text) {
      try {
        const pw = (
          Zotero as unknown as {
            PDFWorker?: { getFullText?: (id: number) => unknown };
          }
        ).PDFWorker;
        if (pw?.getFullText) {
          const r = await pw.getFullText(item.id);
          text =
            typeof r === "string"
              ? r
              : ((r as { text?: string } | null)?.text ?? "");
        }
      } catch (e) {
        void debugLog("si", `PDFWorker.getFullText 失败: ${e}`);
      }
    }
    const pages = text ? text.split("\f") : [];
    void debugLog("si", `SI ${item.id} 全文 ${text.length} 字符 / ${pages.length} 页`);
    return pages;
  })();
  pageCache.set(item.id, job);
  return job;
}

/**
 * 图注截断的两个教训（都是实测踩出来的）：
 *
 * ① **别定太短**。原来是 300 字符，而实测 Table S4 / Table S2 的图注分别是
 *    544 / 576 字符 → 用户看到的是「**翻译了一半就停了**」（中英都被切在半路）。
 *    现在放宽到 1200 字符，只作兜底。
 *
 * ② **别把表格数据当图注**。表格页的排版是「图注 → 表头 → 数据行」，
 *    而它们之间**没有空行**，所以原来「截到空行」的规则会把整张表都吞进来
 *    （`…Parameter 0 min hold 30 min hold … ηc (%) 84.2 63.4 54.0 …`），
 *    既不像图注，还要白花 token 去翻一堆数字。
 *
 *    改法：**先只看前若干行**（图注一般 1–4 行），再**收到句末**为止
 *    （`[.!?]` 后面跟空白 + 大写字母/括号/中文）。对 Table S4 的效果：
 *    图注正好收在 `…by using different voltage hold times.`，表头数据被挡在外面。
 */
const CAPTION_MAX_LINES = 8;
const CAPTION_MAX = 1200;

/** 句末：标点 + 空白 + （大写字母 / 左括号 / 中文）——用来避开 "Fig. 3" 这种缩写点 */
const SENTENCE_END = /[.!?。！？](?=\s+[A-Z(（\u4e00-\u9fa5])/g;

export function extractCaption(page: string, idx: number): string {
  const lines = page.slice(idx).split("\n").slice(0, CAPTION_MAX_LINES);
  let text = lines
    .join(" ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  // 收到最后一个句末为止（太靠前就不收，免得把标题本身切掉）
  let last = -1;
  SENTENCE_END.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(text))) {
    last = m.index;
  }
  if (last > 60) {
    text = text.slice(0, last + 1);
  } else {
    // 兜底：窗口里**一个句末都没有**（实测 Table S6 的图注就没有句号：
    //   "…and other recent electrochemical CO2 capture methods"），
    // 这时后面紧跟的就是表头/数据（"Method Description CO2 source …"）。
    // 只保留「首行 + 后续以小写字母或括号开头的续行」。
    const keep: string[] = [];
    for (const raw of lines) {
      const l = raw.trim();
      if (!l) {
        break;
      }
      if (!keep.length || /^[a-z(（]/.test(l)) {
        keep.push(l);
      } else {
        break;
      }
    }
    text = keep.join(" ").replace(/[ \t]{2,}/g, " ").trim();
  }

  if (text.length > CAPTION_MAX) {
    text = text.slice(0, CAPTION_MAX).trimEnd() + "…";
  }
  return text;
}

/**
 * 找某个引用的图注在哪一页。
 *
 * 只认**行首**出现的标签 —— SI 里表格的说明文字常会行内引用别的图
 * （实测：Table S4 的说明里有一句 "extracted from Figure S6b"），
 * 不加这条限制就会把 S6b 定位到那张表所在的页。
 *
 * 先按完整编号找（`S6b`），找不到再退到基号（`S6`）——
 * 子图 b 常常没有独立图注，实际就在主图那一页。
 */
export function findCaptionPage(
  pages: string[],
  ref: SiRef,
): { pageIndex: number; caption: string } | null {
  const words = KIND_WORDS[ref.kind] || ref.kind;
  const nums =
    ref.baseNum && ref.baseNum !== ref.num ? [ref.num, ref.baseNum] : [ref.num];
  for (const num of nums) {
    let re: RegExp;
    try {
      re = new RegExp(
        `(?:^|\\n)[ \\t]*(${words})[ \\t]*S[ \\t]*${num}(?![0-9])`,
        "i",
      );
    } catch {
      continue;
    }
    for (let i = 0; i < pages.length; i++) {
      const m = re.exec(pages[i]);
      if (m) {
        return { pageIndex: i, caption: extractCaption(pages[i], m.index) };
      }
    }
  }
  return null;
}

/** 拿 Word SI 的解析结果（按附件 id 缓存，含按需解压的 `read()`） */
const docxCache = new Map<number, Promise<DocxDoc | null>>();

export function getSiDocx(item: Zotero.Item): Promise<DocxDoc | null> {
  const hit = docxCache.get(item.id);
  if (hit) {
    return hit;
  }
  const job = (async () => {
    const t0 = Date.now();
    try {
      const path = await item.getFilePathAsync();
      if (!path) {
        void debugLog("si", `Word SI ${item.id} 没有本地文件路径`);
        return null;
      }
      const bytes = (await g().IOUtils.read(path)) as Uint8Array;
      const doc = parseDocx(bytes);
      void debugLog(
        "si",
        `解析 Word SI ${item.id}: ${bytes.length} 字节 → ${doc.paragraphs.length} 段 / ` +
          `${doc.mediaPath.size} 张图（${Date.now() - t0} ms）`,
      );
      return doc;
    } catch (e) {
      void debugLog("si", `解析 Word SI 失败: ${e}`);
      return null;
    }
  })();
  docxCache.set(item.id, job);
  return job;
}

/**
 * 把一批引用解析成可渲染的落点。
 * 同一篇 SI 只读一次全文；找不到 SI 就返回空数组（功能静默消失，不打扰用户）。
 */
export async function lookupSiTargets(
  refs: SiRef[],
  itemId: number | undefined,
): Promise<SiTarget[]> {
  if (!refs.length) return [];
  const si = findSiAttachment(itemId);
  if (!si) {
    void debugLog("si", `item ${itemId} 下没有 SI 附件，跳过`);
    return [];
  }
  const kind = siKind(si);
  let title = "";
  try {
    title =
      (si.getField("title") as string) ||
      (si.attachmentFilename as string) ||
      "SI";
  } catch {
    title = "SI";
  }

  // ── Word SI：没有"页"的概念，按段落找图注、按紧邻段落配图
  if (kind === "word" || kind === "doc") {
    // 老 `.doc` 不是 zip，解析必然失败 → 不试，直接给"取不了图但能打开"
    const doc = kind === "word" ? await getSiDocx(si) : null;
    return refs.map((ref) => {
      const hit = doc
        ? findDocxFigure(
            doc,
            ref.label,
            `${ref.kind} S${ref.baseNum}`,
            // ⭐ 把 PDF 那条路用的类别词变体（Figures?|Figs?\.?|图…）也传过去 ——
            // 否则 SI 图注写成 `Fig. S3` 时整篇 Figure 都定位不到（实测坑）
            KIND_WORDS[ref.kind],
          )
        : null;
      void debugLog(
        "si",
        `${ref.label} → Word SI ${
          kind === "doc"
            ? "老 .doc 格式，不取图"
            : hit
              ? hit.image
                ? `配到图 ${hit.image}`
                : hit.table?.length
                  ? `配到表 ${hit.table.length}×${Math.max(...hit.table.map((r) => r.length))}`
                  : "只有图注、没有图也没有表"
              : "没定位到"
        }`,
      );
      return {
        ref,
        attachmentId: si.id,
        attachmentTitle: title,
        kind: kind === "doc" ? ("doc" as const) : ("word" as const),
        pageIndex: null,
        media: hit?.image ?? null,
        table: hit?.table ?? null,
        caption: hit ? extractCaption(hit.caption, 0) : "",
      };
    });
  }

  let pages: string[] = [];
  try {
    pages = await getSiPages(si);
  } catch (e) {
    void debugLog("si", `读 SI 全文失败: ${e}`);
  }

  return refs.map((ref) => {
    const hit = pages.length ? findCaptionPage(pages, ref) : null;
    void debugLog(
      "si",
      `${ref.label} → ${hit ? `第 ${hit.pageIndex + 1} 页` : "没定位到"}`,
    );
    return {
      ref,
      attachmentId: si.id,
      attachmentTitle: title,
      kind: "pdf" as const,
      pageIndex: hit ? hit.pageIndex : null,
      media: null,
      // PDF 版不需要：表格是矢量的，走"整页渲染"时会跟着页面一起出图
      table: null,
      caption: hit ? hit.caption : "",
    };
  });
}
