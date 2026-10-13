/**
 * ⭐ 补丁：句子级翻译记忆。
 *
 * **问题**：持久化缓存的键是「整段原文」。翻译了一整段之后，
 * 再选中其中的几句话 —— 那是一段**不同的原文** → 键不同 → 必然重新请求 API，
 * 哪怕那几句刚刚才翻过。
 *
 * **做法**：一段多句译文落盘时，**顺便把「源句 → 译句」成对存下来**。
 * 下次选中若正好是若干完整句子，全部命中就本地拼起来，一次 API 都不发。
 *
 * ⚠️ **只在「源句数 == 译句数」时才成对存**。
 * 提示词里明确要求「保留原句结构，不合并、不省略」，所以句数应当一致；
 * 一旦不一致就整段跳过 —— **宁可不存，也不存可能错位的对**
 * （把 A 句的译文配到 B 句上，比重新翻译糟得多）。
 *
 * ⚠️ 匹配前统一把空白折叠掉：PDF 抽出来的文本在句子中间常有换行，
 * 大段的原文和后来单独选的几句，空白必然不同。
 */
import { cacheKeyFor, isCacheable, persistentCache } from "./persistentCache";
import { debugLog } from "./debugLog";

/**
 * 写入侧的门限：少于这么多句就不成对存（单句本来就有一条整段记忆，重复存没意义）。
 *
 * ⚠️ 读取侧**没有**这个门限 —— 早先误以为「单句总能命中整段缓存」，
 * 结果把「从大段里只选一句」和「只选一个碎片」这两种最常见的情况挡掉了。
 */
const MIN_SENTENCES = 2;
/** 太短的「句子」多半是切错的碎片，不存 */
const MIN_SENTENCE_LEN = 6;

export function hasCJK(text: string): boolean {
  return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(text);
}

/** 判断目标语言是不是中日韩（决定拼回去时加不加空格） */
function isCJKTarget(lang: string | undefined): boolean {
  return /^(zh|ja|ko)/i.test(String(lang ?? ""));
}

/** 空白归一：换行、多余空格全部折成一个空格 */
function norm(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 句末是这些缩写的点号，不算句子结束 */
const EN_ABBREV_TAIL =
  /(?:\b[A-Z]|\bet al|\be\.g|\bi\.e|\bcf|\bvs|\bFig|\bFigs|\bEq|\bEqs|\bRef|\bRefs|\bNo|\bNos|\bapprox|\bca|\bDr|\bProf|\bMr|\bMrs|\bMs|\bSt|\bInc|\bLtd|\bCo|\bUniv|\bVol|\bpp|\bSec|\bTab|\bTemp|\bSect)\.$/;

/**
 * 切句。
 *  - 含中日韩字符：按 `。！？` 切
 *  - 否则：按 `. ! ?` + 空白切，但把缩写/首字母后面的切点合回去
 */
export function splitSentences(text: string): string[] {
  const t = norm(text);
  if (!t) return [];

  if (hasCJK(t)) {
    return t
      .split(/(?<=[。！？!?])/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const out: string[] = [];
  for (const piece of t.split(/(?<=[.!?])\s+/)) {
    const p = piece.trim();
    if (!p) continue;
    const prev = out[out.length - 1];
    if (prev && EN_ABBREV_TAIL.test(prev)) {
      out[out.length - 1] = `${prev} ${p}`;
    } else {
      out.push(p);
    }
  }
  return out;
}

type TaskLike = {
  service: string;
  langfrom?: string;
  langto?: string;
};

/**
 * 用句子级记忆拼出结果。
 * 任意一句没命中就返回 null（**不做部分拼装** —— 只翻一半再缝起来会掉上下文质量）。
 */
export async function lookupBySentences(
  path: string,
  task: TaskLike,
  raw: string,
): Promise<string | null> {
  const sentences = splitSentences(raw);
  if (!sentences.length) {
    return null;
  }
  const parts: string[] = [];
  let looseHits = 0;
  for (const sentence of sentences) {
    const q = norm(sentence);
    const key = cacheKeyFor({
      raw: q,
      service: task.service,
      langfrom: task.langfrom,
      langto: task.langto,
    });
    const hit = await persistentCache.get(path, key);
    if (hit) {
      parts.push(hit.r);
      continue;
    }

    // ⭐ 补丁：半句也要能用 —— 找一条「源文包含这段碎片」的记忆，
    // 直接返回**那一整句**的译文（用户明确要的就是这个：
    // 「半句你直接按照整句输出」）。比只翻碎片更贴合阅读。
    const contained = await findContainingSentence(path, q);
    if (contained) {
      looseHits++;
      parts.push(contained.r);
      continue;
    }

    void debugLog(
      "sentmem",
      `lookup MISS at piece ${parts.length + 1}/${sentences.length}: "${q.slice(0, 90)}"`,
    );
    return null;
  }
  const joiner = isCJKTarget(task.langto) ? "" : " ";
  void debugLog(
    "sentmem",
    `lookup HIT ${sentences.length} pieces (${looseHits} by whole-sentence containment) -> assembled`,
  );
  return parts.join(joiner);
}

/** 太短的碎片不做包含匹配，否则「in our system」这种会乱撞 */
const MIN_CONTAIN_LEN = 24;

/**
 * ⭐ 补丁：在句子级记忆里找一条「源文包含这段碎片」的条目。
 * 命中就返回整条 —— 也就是**整句的译文**。
 * 多条都包含时取源文最长的那条（边界最贴近）。
 */
async function findContainingSentence(
  path: string,
  piece: string,
): Promise<{ r: string } | null> {
  if (piece.length < MIN_CONTAIN_LEN) {
    return null;
  }
  let best: { r: string; q: string } | null = null;
  for (const entry of await persistentCache.all(path)) {
    const src = entry.q;
    if (!src || !entry.r) {
      continue;
    }
    if (!src.includes(piece)) {
      continue;
    }
    if (!best || src.length > best.q.length) {
      best = { r: entry.r, q: src };
    }
  }
  return best ? { r: best.r } : null;
}

/** 一次翻译成功后，把「源句 → 译句」成对写进记忆（句数不等就整段跳过） */
export async function storeSentencePairs(
  path: string,
  task: TaskLike,
  raw: string,
  result: string,
): Promise<number> {
  if (!isCacheable(raw) || !result) {
    return 0;
  }
  const src = splitSentences(raw);
  const dst = splitSentences(result);
  if (src.length < MIN_SENTENCES || !dst.length) {
    void debugLog(
      "sentmem",
      `store skip: src=${src.length}, dst=${dst.length}`,
    );
    return 0;
  }

  // 句数相等时直接 1:1；不等时按长度比做单调对齐
  const groups: AlignGroup[] =
    src.length === dst.length
      ? src.map((v, i) => ({ src: [v], dst: [dst[i]] }))
      : (alignByLengthRatio(src, dst) ?? []);
  if (!groups.length) {
    void debugLog(
      "sentmem",
      `store skip: alignment failed (src=${src.length}, dst=${dst.length})`,
    );
    return 0;
  }

  const at = Date.now();
  let stored = 0;
  for (const g of groups) {
    const q = norm(g.src.join(" "));
    if (q.length < MIN_SENTENCE_LEN) {
      continue;
    }
    await persistentCache.set(
      path,
      cacheKeyFor({
        raw: q,
        service: task.service,
        langfrom: task.langfrom,
        langto: task.langto,
      }),
      {
        r: g.dst.join(""),
        s: task.service,
        f: task.langfrom || "",
        t: task.langto || "",
        at,
        // ⭐ 源文一起存，半句才能靠包含匹配找回整句
        q,
      },
    );
    stored++;
  }
  void debugLog(
    "sentmem",
    `store OK ${stored}/${groups.length} groups (src=${src.length}, dst=${dst.length})`,
  );
  return stored;
}

/* ------------------------------------------------------------------ *
 * 长度比 DP 句对齐
 *
 * 为什么必须有：早期版本要求「源句数 == 译句数」才成对存。
 * **实测这个假设是错的** —— 中文译文会拆句（真实日志：src=4/dst=6、src=5/dst=8），
 * 于是配对一次都没成，缓存里带源文的条目是 0 条，整个功能等于没做。
 *
 * 现在的做法：按「字符长度比的偏离」做单调对齐（Gale-Church 那套），
 * 允许 1:1 / 1:2 / 2:1 三种步长，代价 = (实际译长 − 期望译长)² / 期望译长。
 * 真实数据验证（Energy Storage Mater. 那篇的双语样本，源 4 句 / 译 6 句）：
 * 每一对的语义都对得上，偏离落在 0.73–1.30。
 * ------------------------------------------------------------------ */

/** 单组的长度比偏离超出这个区间就认为对齐不可信 → 整段不存 */
const DEV_MIN = 0.45;
const DEV_MAX = 2.2;

type AlignGroup = { src: string[]; dst: string[] };

export function alignByLengthRatio(
  src: string[],
  dst: string[],
): AlignGroup[] | null {
  const m = src.length;
  const n = dst.length;
  if (!m || !n) return null;

  const srcLen = src.map((v) => v.length);
  const dstLen = dst.map((v) => v.length);
  const srcSum: number[] = [0];
  const dstSum: number[] = [0];
  for (let i = 0; i < m; i++) srcSum.push(srcSum[i] + srcLen[i]);
  for (let j = 0; j < n; j++) dstSum.push(dstSum[j] + dstLen[j]);

  const ratio = dstSum[n] / Math.max(srcSum[m], 1);
  const stepCost = (a1: number, a2: number, b1: number, b2: number): number => {
    const ls = srcSum[a2] - srcSum[a1];
    const lt = dstSum[b2] - dstSum[b1];
    if (ls <= 0) return 1e9;
    const expected = ratio * ls;
    return ((lt - expected) * (lt - expected)) / Math.max(expected, 1);
  };

  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(INF),
  );
  const back: ([number, number] | null)[][] = Array.from({ length: m + 1 }, () =>
    new Array<[number, number] | null>(n + 1).fill(null),
  );
  dp[0][0] = 0;

  const moves: [number, number][] = [
    [1, 1],
    [1, 2],
    [2, 1],
  ];
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      if (dp[i][j] === INF) continue;
      for (const [di, dj] of moves) {
        const ni = i + di;
        const nj = j + dj;
        if (ni > m || nj > n) continue;
        const c = dp[i][j] + stepCost(i, ni, j, nj);
        if (c < dp[ni][nj]) {
          dp[ni][nj] = c;
          back[ni][nj] = [i, j];
        }
      }
    }
  }
  if (dp[m][n] === INF) return null;

  const groups: AlignGroup[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    const prev = back[i][j];
    if (!prev) return null;
    groups.push({ src: src.slice(prev[0], i), dst: dst.slice(prev[1], j) });
    [i, j] = prev;
  }
  groups.reverse();

  // 偏离校验：任何一组离期望长度太远，就说明这次对齐不可信，整段不存
  for (const g of groups) {
    const ls = g.src.join(" ").length;
    const lt = g.dst.join("").length;
    const dev = lt / Math.max(ratio * ls, 1);
    if (dev < DEV_MIN || dev > DEV_MAX) {
      void debugLog(
        "sentmem",
        `align rejected: group dev=${dev.toFixed(2)} src="${g.src.join(" ").slice(0, 50)}"`,
      );
      return null;
    }
  }
  return groups;
}
