import { debugLog } from "./debugLog";
/**
 * ⭐ 补丁：把译文里的引用角标 `[26]` 变成「点开就能看原文」的入口。
 *
 * 数据来源是**这篇 PDF 自己的参考文献表** —— Zotero 索引好的全文
 * （`item.attachmentText`，也就是 storage 里的 `.zotero-ft-cache`）。
 * 不联网、不依赖条目里有没有存引用关系，也不需要用户事先做什么。
 *
 * 实测（CuSe 那篇）：58 条编号全部解析出来，45 条自带 DOI，
 * `[26]`→MoSe2、`[27]`→VSe2、`[28]`→WSe2、`[29]`→Bi2Se3、`[30]`→MnSe，
 * 与正文「transition metal selenides (MoSe2[26], VSe2[27], …)」完全对应。
 */

export type CiteRef = {
  n: number;
  /** 参考文献条目原文（已把跨行连字符和换行洗干净） */
  text: string;
  /** 条目里自带的 DOI（可能没有） */
  doi?: string;
};

/** 参考文献表标题（注意 PDF 抽取出来的常在行首带 \f 换页符） */
const REFS_HEADING =
  /^[ \t\f\r]*(references|reference list|bibliography|works cited|literature cited|参考文献|引用文献)[ \t]*$/gim;
/** `[26] Xxx, …` 这种编号条目 */
const BRACKET_ENTRY = /\[(\d{1,3})\]\s/g;
/** `(26) Xxx, …` 这种圆括号编号（ACS 系期刊，条目还是连排的） */
const PAREN_ENTRY = /\((\d{1,3})\)\s/g;
/** `26. Xxx, …` 这种编号条目 */
const PLAIN_ENTRY = /(?:^|\n)[ \t]*(\d{1,3})[.)]\s+(?=[A-Z\u4e00-\u9fa5])/g;
const DOI_RE = /(10\.\d{4,9}\/[^\s"'<>,;)\]]+)/;

const cache = new Map<number, Map<number, CiteRef>>();
const pending = new Map<number, Promise<Map<number, CiteRef>>>();

export function extractDoi(text: string): string | undefined {
  const m = DOI_RE.exec(text);
  if (!m) return undefined;
  return m[1].replace(/[.,;]+$/, "");
}

function cleanEntry(raw: string): string {
  return raw
    .replace(/-\s*\n\s*/g, "") // 跨行断词
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 定位参考文献表的起点。
 *
 * 两条路：先找标题；标题找不到（不同期刊/扫描件差异很大）就靠
 * 「连续的 [n][n+1][n+2][n+3] 且间隔不大」这种密度特征兜底。
 * 正文里的引用是散落的，凑不出连续 4 个递增编号。
 */
function findReferenceStart(fullText: string): number {
  let headingEnd = -1;
  REFS_HEADING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFS_HEADING.exec(fullText)) !== null) {
    headingEnd = m.index + m[0].length;
  }
  if (headingEnd >= 0) {
    return headingEnd;
  }
  const ms = [...fullText.matchAll(BRACKET_ENTRY)];
  for (let i = 0; i + 3 < ms.length; i++) {
    const nums = [0, 1, 2, 3].map((j) => parseInt(ms[i + j][1], 10));
    const okNums = nums.every((v, j) => v === nums[0] + j);
    if (!okNums) continue;
    const gaps = [1, 2, 3].map(
      (j) => (ms[i + j].index ?? 0) - (ms[i + j - 1].index ?? 0),
    );
    if (Math.max(...gaps) < 1200) {
      return ms[i].index ?? 0;
    }
  }
  return 0;
}

/** 从整篇全文里解析「编号 → 条目」。纯函数，方便单测。 */
export function parseReferences(fullText: string): Map<number, CiteRef> {
  const refs = new Map<number, CiteRef>();
  if (!fullText) return refs;

  let body = fullText.slice(Math.max(0, findReferenceStart(fullText)));

  // ⭐ 三种编号风格都试一遍，取命中条数最多的那种。
  //    [26] Xxx   ← 大多数 Elsevier / RSC
  //    (26) Xxx   ← ACS 系（而且是连排的，条目之间没有换行）
  //    26. Xxx    ← 部分期刊
  let matches: RegExpMatchArray[] = [];
  for (const pattern of [BRACKET_ENTRY, PAREN_ENTRY, PLAIN_ENTRY]) {
    const found = [...body.matchAll(pattern)];
    if (found.length > matches.length) {
      matches = found;
    }
  }
  if (matches.length < 3) return refs;

  matches.forEach((mm, i) => {
    const n = parseInt(mm[1], 10);
    const from = (mm.index ?? 0) + mm[0].length;
    const to = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length;
    const text = cleanEntry(body.slice(from, to));
    if (!text || text.length < 12) return;
    const doi = extractDoi(text);
    refs.set(n, { n, text, doi });
  });

  return refs;
}

/** 拿这篇附件的参考文献表（按 itemID 缓存，一篇只解析一次） */
export function getReferenceMap(
  itemId: number | undefined,
): Promise<Map<number, CiteRef>> {
  const empty = new Map<number, CiteRef>();
  if (!itemId) return Promise.resolve(empty);
  const hit = cache.get(itemId);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(itemId);
  if (inflight) return inflight;

  const job = (async () => {
    let text = "";
    try {
      const item = Zotero.Items.get(itemId);
      if (item) {
        text = (await (item as unknown as { attachmentText: Promise<string> })
          .attachmentText) || "";
      }
    } catch (e) {
      Zotero.debug(`[pdf-translate] attachmentText failed: ${e}`);
    }
    if (!text) {
      try {
        const pw = (Zotero as unknown as { PDFWorker?: { getFullText?: (id: number) => unknown } })
          .PDFWorker;
        if (pw?.getFullText) {
          const r = await pw.getFullText(itemId);
          text =
            typeof r === "string"
              ? r
              : ((r as { text?: string } | null)?.text ?? "");
        }
      } catch (e) {
        Zotero.debug(`[pdf-translate] PDFWorker.getFullText failed: ${e}`);
      }
    }
    const refs = parseReferences(text);
    Zotero.debug(
      `[pdf-translate] parsed ${refs.size} references for item ${itemId}`,
    );
    cache.set(itemId, refs);
    pending.delete(itemId);
    return refs;
  })();

  pending.set(itemId, job);
  return job;
}

/** `[3-5]` / `[1,2]` / `[15,16]` → [3,4,5] / [1,2] */
export function expandCiteToken(token: string): number[] {
  const out: number[] = [];
  for (const part of String(token ?? "").split(/[,，;；]/)) {
    const t = part.trim();
    const range = t.match(/^(\d{1,3})\s*[-–—~]\s*(\d{1,3})$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (b >= a && b - a <= 60) {
        for (let i = a; i <= b; i++) out.push(i);
      }
      continue;
    }
    if (/^\d{1,3}$/.test(t)) out.push(parseInt(t, 10));
  }
  return [...new Set(out)];
}

/**
 * ⭐ 补丁：条目里没带 DOI 时，用 CrossRef 按题录反查一个。
 *
 * 为什么需要：ACS 系（JACS / Chem. Rev. …）的参考文献**按格式就不写 DOI**，
 * 实测 37 条里只有 2 条自带。用户要的是「点角标看 DOI」，那就得在线补。
 * 只在用户点了角标之后才发请求，结果按条目文本缓存，同一条不重复查。
 */
const doiLookupCache = new Map<string, string | null>();

type LookupResult = { doi: string | null; source: string; detail: string };

/**
 * ⭐ 补丁：相关性校验 —— 别把「碰巧返回的第一条」当成答案。
 *
 * 实测教训：CrossRef 的 `query.bibliographic` **对完全不相干的输入也会返回一条**，
 * 拿一条中文乱码去查，它回了 `10.2307/j.ctv1mgmd7p.94`。
 * 直接显示这种 DOI 比不显示更糟（用户会拿错文献）。所以要求：
 * 年份对得上（±1），**且**至少有一个名字/期刊词能在返回的著者里找到。
 * 两条信号都没有（比如中文条目）就宁可不给。
 */
function entryYear(entry: string): number | undefined {
  const ys = entry.match(/\b(?:19|20)\d{2}\b/g);
  return ys ? Number(ys[ys.length - 1]) : undefined;
}

function entryNameTokens(entry: string): string[] {
  const words = entry.match(/\b[A-Z][a-zA-Z]{3,}\b/g) || [];
  return [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 24);
}

type RefLike = {
  author?: { family?: string; given?: string }[];
  issued?: { "date-parts"?: number[][] };
};

function itemMatchesEntry(entry: string, item: RefLike | undefined): boolean {
  if (!item) return false;
  const y = entryYear(entry);
  const itemYear = item.issued?.["date-parts"]?.[0]?.[0];
  if (y && itemYear && Math.abs(y - itemYear) > 1) return false;

  const tokens = entryNameTokens(entry);
  const authors = (item.author || [])
    .flatMap((a) => [a.family, a.given].filter(Boolean) as string[])
    .map((v) => v.toLowerCase());
  if (!tokens.length || !authors.length) return false;
  return tokens.some((t) => authors.some((a) => a.includes(t) || t.includes(a)));
}

async function tryCrossref(entry: string): Promise<LookupResult> {
  const url =
    "https://api.crossref.org/works?rows=3&select=DOI,author,issued,title" +
    `&query.bibliographic=${encodeURIComponent(entry.slice(0, 400))}`;
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 20000,
      successCodes: false,
    });
    const resp = (xhr as unknown as { response?: unknown }).response;
    const items = (
      resp as {
        message?: {
          items?: {
            DOI?: string;
            author?: { family?: string; given?: string }[];
            issued?: { "date-parts"?: number[][] };
          }[];
        };
      }
    )?.message?.items;
    const hit = items?.find((it) => itemMatchesEntry(entry, it));
    if (hit?.DOI) return { doi: String(hit.DOI), source: "crossref", detail: "ok" };
    if (items?.length) {
      return {
        doi: null,
        source: "crossref",
        detail: `rejected-by-relevance (top=${items[0]?.DOI})`,
      };
    }
    return {
      doi: null,
      source: "crossref",
      detail: `no-item status=${(xhr as unknown as { status?: number }).status} resp=${String(
        typeof resp === "string" ? resp.slice(0, 160) : JSON.stringify(resp)?.slice(0, 160),
      )}`,
    };
  } catch (e) {
    return { doi: null, source: "crossref", detail: `throw ${String(e)}` };
  }
}

async function tryOpenAlex(entry: string): Promise<LookupResult> {
  // ⚠️ 这里**故意不带 `mailto=`**。
  // OpenAlex 的 "polite pool" 要求填一个**真实联系人邮箱**（能提高额度），
  // 但那是**使用者本人**的信息 —— 写死在要分发出去的补丁里，
  // 等于把作者的个人邮箱塞给每一个用这份补丁的人（对方还会替你消耗额度）。
  // 想进 polite pool 的人，自己在下面这行末尾加 `&mailto=你的邮箱`。
  const url =
    "https://api.openalex.org/works?per-page=3&search=" +
    encodeURIComponent(entry.slice(0, 400));
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "json",
      timeout: 20000,
      successCodes: false,
    });
    const resp = (xhr as unknown as { response?: unknown }).response;
    const results = (
      resp as {
        results?: {
          doi?: string;
          authorships?: { author?: { display_name?: string } }[];
          publication_year?: number;
        }[];
      }
    )?.results;
    const hit = results?.find((r) => {
      const asItem = {
        author: (r.authorships || []).map((a) => ({
          family: a.author?.display_name,
        })),
        issued: r.publication_year
          ? { "date-parts": [[r.publication_year]] }
          : undefined,
      };
      return itemMatchesEntry(entry, asItem);
    });
    if (hit?.doi) {
      return {
        doi: String(hit.doi).replace(/^https?:\/\/doi\.org\//i, ""),
        source: "openalex",
        detail: "ok",
      };
    }
    return {
      doi: null,
      source: "openalex",
      detail: `no-item status=${(xhr as unknown as { status?: number }).status}`,
    };
  } catch (e) {
    return { doi: null, source: "openalex", detail: `throw ${String(e)}` };
  }
}

/**
 * ⭐ 补丁：条目里没带 DOI 时，联网反查一个。
 *
 * 为什么需要：ACS 系（JACS / Chem. Rev. …）的参考文献**按格式就不写 DOI**，
 * 实测 37 条里只有 2 条自带。用户要的是「点角标看 DOI」，那就得在线补。
 * 只在用户点了角标之后才发请求，结果按条目文本缓存，同一条不重复查。
 *
 * 两个源依次试：CrossRef（覆盖最全）→ OpenAlex（免费、无需 key、对残缺题录更宽容）。
 */
export async function resolveDoiOnline(entry: string): Promise<string | null> {
  const key = entry.slice(0, 240);
  if (doiLookupCache.has(key)) {
    return doiLookupCache.get(key) ?? null;
  }
  let doi: string | null = null;
  const details: string[] = [];
  for (const attempt of [tryCrossref, tryOpenAlex]) {
    const r = await attempt(entry);
    details.push(`${r.source}:${r.detail}`);
    if (r.doi) {
      doi = r.doi;
      break;
    }
  }
  void debugLog("doi", `lookup ${JSON.stringify(entry.slice(0, 120))} -> ${doi ?? "null"} | ${details.join(" ; ")}`);
  doiLookupCache.set(key, doi);
  return doi;
}
