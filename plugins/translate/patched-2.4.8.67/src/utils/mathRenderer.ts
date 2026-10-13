import katex from "katex";

// Unified, robust math rendering helpers
// Avoid lookbehind for broader engine compatibility by capturing a non-escape prefix
// Order: display (“$$ … $$”, "\\[ … \"] first), then inline “$ … $” (no newline), then "\\( … \")"
const MATH_REGEX =
  /(^|[^\\])\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|(^|[^\\])\$(?!\$)([^\n]*?)\$(?!\$)|\\\(([\s\S]*?)\\\)/g;

/** ⭐ 补丁：同一个扫描器再认一种标记 —— `**章节标题**` */
const RICH_REGEX =
  /(^|[^\\])\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|(^|[^\\])\$(?!\$)([^\n]*?)\$(?!\$)|\\\(([\s\S]*?)\\\)|\*\*([^\n]+?)\*\*/g;

const BOLD_RE = /\*\*([^\n]+?)\*\*/;

/** 标题加粗用的 class（弹窗 / 侧栏 / 独立窗口共用） */
export const HEADING_CLASS = "zoteropdftranslate-heading";

const DEFAULT_KATEX_OPTIONS = {
  throwOnError: false,
  errorColor: "#cc0000",
  strict: false,
} as const;

export function containsMath(text: string): boolean {
  if (!text) return false;
  const TEST_REGEX =
    /(^|[^\\])\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|(^|[^\\])\$[^\n]*?\$|\\\([\s\S]*?\\\)/;
  return TEST_REGEX.test(text);
}

/**
 * ⭐ 补丁：这段译文值不值得用「富文本叠层」渲染。
 *
 * 除了公式，还认两种情况：
 *  1. 模型按提示词打了 `**…**` 标记的章节标题；
 *  2. 模型没打标记，但某一行本身就长得像章节标题（见 isHeadingLine）。
 */
export function containsRichMarkup(text: string): boolean {
  if (!text) return false;
  if (BOLD_RE.test(text)) return true;
  return text.split("\n").some((line) => isHeadingLine(line));
}

/**
 * ⭐ 补丁：判断一行是不是章节标题。
 *
 * 中文译文里的标题长这样：
 *   `2.1 立方相 $Cu_{2-x}Se$ 与 $Cu_{2-x}Se$–DETA-I 至 V 的合成`
 *   `2. 实验部分` / `参考文献` / `Abstract`
 * 判据刻意保守：**太长的行一律不算**，避免把正文句子误加粗。
 */
export function isHeadingLine(line: string): boolean {
  const t = (line ?? "").trim();
  if (!t) return false;
  // 模型已经标好了
  if (/^\*\*[\s\S]*\*\*$/.test(t)) return true;
  if (t.length > 60) return false;
  // 2.1 xxx / 2、xxx / 2) xxx / 一、xxx
  if (/^\d+(\.\d+)*\s*[.、)]?\s+\S/.test(t)) return true;
  if (/^[一二三四五六七八九十]+[、.]\s*\S/.test(t)) return true;
  // 英文标题词开头（整行较短才算）
  if (
    t.length <= 40 &&
    /^(abstract|introduction|conclusions?|references|acknowledg\w*|appendix|experimental|methods?|results?|discussion)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  // 中文标题词开头（必须很短，否则「结论表明…」这种正文明句会被误判）
  if (
    t.length <= 20 &&
    /^(摘要|引言|前言|绪论|结论|总结|参考文献|致谢|附录|实验部分|实验方法|结果与讨论|讨论)/.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/** 把「没打标记但确实像标题」的行补上 `**…**`，让扫描器统一处理 */
function prepareHeadings(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (/^\*\*[\s\S]*\*\*$/.test(t)) return line;
      return isHeadingLine(t) ? `**${t}**` : line;
    })
    .join("\n");
}

/**
 * ⭐ 补丁：文献引用角标化 —— `[26]` / `[3-5]` / `[1,2]` 抬成上标。
 *
 * 原文里引用是行内的 `[26]`，中文译文沿用后跟正文混在一起很难扫读。
 * 这里在**纯文本段**上做（`$…$` 里的内容已经交给 KaTeX，不会重复处理）。
 * 只认 1~3 位数字，所以 `[2025]` 这种年份不会被误抬。
 */
const CITATION_RE = /\[(\d{1,3}(?:\s*[-,–]\s*\d{1,3})*)\]/g;
const CITATION_TEST_RE = /\[\d{1,3}(?:\s*[-,–]\s*\d{1,3})*\]/;

export function containsCitation(text: string): boolean {
  if (!text) return false;
  return CITATION_TEST_RE.test(text);
}

/** 引用角标用的 class —— 点它去查这篇 PDF 的参考文献表 */
export const CITE_CLASS = "zoteropdftranslate-cite";

function withCitations(escaped: string): string {
  return escaped.replace(
    CITATION_RE,
    (full: string, token: string) =>
      `<sup class="${CITE_CLASS}" data-cite="${token}" title="点击查看这条参考文献">${full}</sup>`,
  );
}

/**
 * ⭐ 补丁：这段译文要不要走「富文本叠层」。
 * 公式、加粗标题、引用角标，任意一个都需要 —— textarea 是纯文本，三者都显示不了。
 */
export function needsRichRendering(text: string): boolean {
  return containsMath(text) || containsRichMarkup(text) || containsCitation(text);
}

export function escapeHtml(doc: Document, text: string): string {
  const div = doc.createElement("div");
  div.textContent = text;
  // ⚠️⚠️ 这里必须写 `<br>`，**绝不能**写 `<br></br>`。
  //
  // 原来的写法是 `<br></br>`，看着像"规范的自闭合"，实际是错的：
  // **HTML5 解析器把 `</br>` 当成又一个 `<br>` 开始标签**
  // （规范 "in body" 插入模式里，br 的结束标签明确按开始标签处理）。
  // 于是每个换行都变成**两个**换行，`\n\n` 渲染出 3 个空行 ——
  // 用户 2026-10-12 反馈的「空太大了」就是这个：
  // 译文里模型用 `\n\n` 分段，视觉上却空了一大片。
  //
  // 用真 HTML5 解析器（parse5）实测过：
  //   `a<br></br>b`                    → 2 个 <br>（应为 1）
  //   `x<br></br><br></br>y`（即 \n\n） → 4 个 <br>（应为 2）
  //   改成 `<br>` 后：1 个 / 2 个 ✅
  //
  // 顺便把 ≥3 个连续换行压成 2 个（等于"最多一个空行"）：
  // 模型偶尔会多打空行，压一下版面更稳。
  return div.innerHTML
    .replace(/\n{2,}/g, "\n\n")
    .replace(/\n/g, "<br>");
}

/** 纯文本段：先转义，再把引用抬成上标 */
function plainHtml(doc: Document, text: string): string {
  return withCitations(escapeHtml(doc, text));
}

/** 共用的扫描器：`$…$` 交给 KaTeX，`**…**` 变成加粗标题，其余转义 */
function scan(
  doc: Document,
  text: string,
  regex: RegExp,
  allowBold: boolean,
): string {
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // 模块级正则带 g，靠跑空来复位；万一中途抛异常会残留，这里显式清一次
  regex.lastIndex = 0;

  while ((match = regex.exec(text)) !== null) {
    const [
      full,
      dispPrefix,
      dispDollar,
      dispBracket,
      inlinePrefix,
      inlineDollar,
      inlineParen,
      boldText,
    ] = match;

    const prefixLen = dispPrefix || inlinePrefix ? 1 : 0;
    const plainEnd = match.index + prefixLen;
    if (plainEnd > lastIndex) {
      result += plainHtml(doc, text.slice(lastIndex, plainEnd));
    }

    // ⭐ 补丁：章节标题 —— 加粗，标题里的公式照样走 KaTeX
    if (allowBold && typeof boldText !== "undefined") {
      const inner = renderMathInText(doc, String(boldText).trim());
      result += `<strong class="${HEADING_CLASS}" style="font-weight:700">${inner}</strong>`;
      lastIndex = match.index + full.length;
      continue;
    }

    let displayMode = false;
    let latex = "";
    if (typeof dispDollar !== "undefined") {
      displayMode = true;
      latex = String(dispDollar).trim();
    } else if (typeof dispBracket !== "undefined") {
      displayMode = true;
      latex = String(dispBracket).trim();
    } else if (typeof inlineDollar !== "undefined") {
      displayMode = false;
      latex = String(inlineDollar).trim();
    } else if (typeof inlineParen !== "undefined") {
      displayMode = false;
      latex = String(inlineParen).trim();
    }

    try {
      const rendered = katex.renderToString(latex, {
        ...DEFAULT_KATEX_OPTIONS,
        displayMode,
      });
      result += rendered;
    } catch (e) {
      result += plainHtml(doc, full.slice(prefixLen));
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < text.length) {
    result += plainHtml(doc, text.slice(lastIndex));
  }

  return result;
}

export function renderMathInText(doc: Document, text: string): string {
  if (!text) return "";
  if (!containsMath(text)) return plainHtml(doc, text);
  return scan(doc, text, MATH_REGEX, false);
}

/**
 * ⭐ 补丁：公式 + 章节标题一起渲染。
 * 标题行加粗，正文照旧；两种内容都不会把对方挤掉。
 */
export function renderRichInText(doc: Document, text: string): string {
  if (!text) return "";
  const useRich = containsRichMarkup(text);
  if (!useRich && !containsMath(text)) return plainHtml(doc, text);
  const prepared = useRich ? prepareHeadings(text) : text;
  return scan(doc, prepared, useRich ? RICH_REGEX : MATH_REGEX, useRich);
}

export function renderMathInElement(element: HTMLElement, text: string): void {
  if (!element) return;
  element.innerHTML = renderRichInText(element.ownerDocument, text);
}
