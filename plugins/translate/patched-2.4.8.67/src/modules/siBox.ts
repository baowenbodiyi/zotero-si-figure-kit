/**
 * ⭐ 补丁：一块**独立的 SI 插图浮窗**。
 *
 * 需求演变（值得记下来）：
 *  v1 做成了「Figure S3 · SI 第 8 页」页码链接 —— 不是用户要的；
 *  v2 把插图塞进**翻译弹窗内部** —— 用户明确否掉：
 *     「这个支撑信息的图要独立出来，和我翻译的框不在一起，
 *       并且图的大小位置我都能随意改变」。
 *
 * 所以现在是：挂在阅读器文档上的**独立浮窗**，
 *  · 拖标题栏 → 移动；拖右下角把手 → 自由改大小（插图跟着缩放）
 *  · 不在翻译弹窗里，所以也不再撑长弹窗、不再把缩放手柄顶走
 *  · 位置/尺寸记进 pref，下次还在原地
 *  · 没有 SI 引用的划选**不会**动它 —— 它就该是独立的，不是每次划词都刷新
 *
 * 渲染一律走 DOM 节点 + textContent：图注是从 PDF 抽出来的任意字符串，
 * 拼 innerHTML 等于自己开一个注入口子。
 */
import { config } from "../../package.json";
import type { SiTarget } from "../utils/siRefs";
import { getSiFigure } from "../utils/siFigure";
import { addTranslateTask } from "../utils/task";
import { lookupSiTargets, parseSiRefs } from "../utils/siRefs";
import { debugLog } from "../utils/debugLog";
import { needsRichRendering, renderRichInText } from "../utils/mathRenderer";

const PANEL_ID = `${config.addonRef}-sifloat`;
/** 右下角缩放把手的边长 */
const GRIP = 16;
/** 短于这个长度的划选不触发「自动收起」，避免一次拖拽的第二次事件把刚弹出的图收掉 */
const MIN_HIDE_LEN = 16;
const MIN_W = 220;
const MIN_H = 140;
const DEFAULT_W = 460;
const DEFAULT_H = 520;

/**
 * ⭐ 浮窗显隐。
 *
 * ⚠️ 和 citationBox 同一个坑：浮窗的内联样式里有 `display: flex`，
 * 它会**压掉** `[hidden] { display: none }` —— 所以不能只设 `panel.hidden = true`，
 * 必须把 `display` 一起写掉，否则点 ✕ **看起来毫无反应**。
 */
function setPanelVisible(panel: HTMLElement, visible: boolean): void {
  panel.hidden = !visible;
  panel.style.display = visible ? "flex" : "none";
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  style?: Partial<CSSStyleDeclaration>,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (style) {
    Object.assign(node.style, style);
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** 用 Zotero 阅读器打开 SI 的某一页 */
function openSiPage(attachmentId: number, pageIndex: number | null): void {
  try {
    const item = Zotero.Items.get(attachmentId);
    // Word SI 没有 reader：交给系统默认程序（Word）打开。
    // `Zotero.FileHandlers.open` 内部就是按 `attachmentReaderType` 分流的 ——
    // docx 没有 reader type，它会走 `Zotero.launchFile`。
    if (item && item.attachmentContentType !== "application/pdf") {
      void Zotero.FileHandlers.open(item, {});
      return;
    }
    const loc =
      pageIndex === null
        ? undefined
        : { pageIndex, scale: "page-height" as const };
    void Zotero.Reader.open(attachmentId, loc);
  } catch (e) {
    void debugLog("si", `打开 SI 失败: ${e}`);
    try {
      Zotero.getMainWindow().alert(`打开支撑信息失败：${e}`);
    } catch {
      /* ignore */
    }
  }
}

/** 每一行的副标题（说明这条落到哪儿了） */
function targetHint(t: SiTarget): string {
  if (t.kind === "doc") {
    // 老二进制 .doc 不是 zip，取不了图 —— 别说成"没有对应图片"，那是误报
    return "Word（.doc 旧格式）取不了图（点击打开文档）";
  }
  if (t.kind === "word") {
    if (t.media) {
      return "Word SI 里的原图（点击打开文档）";
    }
    if (t.table?.length) {
      const cols = Math.max(...t.table.map((r) => r.length));
      return `Word SI 里的表格（${t.table.length}×${cols}）`;
    }
    return "Word SI 里没有对应图片";
  }
  return t.pageIndex === null ? "SI 里没找到" : `SI 第 ${t.pageIndex + 1} 页（点击跳转）`;
}

/**
 * 把 Word 表格画成 HTML `<table>`。
 *
 * 全部走 `textContent` —— 单元格文字是从文档里抽的任意字符串，拼 innerHTML 等于自己开注入口子。
 * 第一行按表头加粗（Word 表格多数首行是表头；判断不了时也只是加粗一行，无害）。
 */
function buildTable(doc: Document, rows: string[][]): HTMLElement {
  const cols = Math.max(...rows.map((r) => r.length));
  const table = el(doc, "table", {
    marginTop: "5px",
    borderCollapse: "collapse",
    width: "100%",
    fontSize: "0.92em",
    tableLayout: "fixed",
  });
  const tbody = el(doc, "tbody", {});
  rows.forEach((row, ri) => {
    const tr = el(doc, "tr", {});
    for (let ci = 0; ci < cols; ci++) {
      const cell = el(doc, "td", {
        border: "1px solid rgba(127,127,127,0.45)",
        padding: "3px 5px",
        verticalAlign: "top",
        // 长内容（化学方程式那种）必须能换行，否则会把浮窗撑宽
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontWeight: ri === 0 ? "700" : "400",
        background:
          ri === 0 ? "rgba(127,127,127,0.10)" : "transparent",
      });
      // ⚠️ 单元格里可能有 `$_{2}$` 这种（由 Word 的下标 run 转来）——
      //    用 textContent 会**原样显示成 "Na$_{2}$CO$_{3}$"**，KaTeX 根本不会被调用。
      //    含公式/富文本的走 setRichText（它内部还会做 HTML 转义），其余仍走 textContent。
      const raw = row[ci] ?? "";
      if (needsRichRendering(raw)) {
        setRichText(doc, cell, raw);
      } else {
        cell.textContent = raw;
      }
      tr.appendChild(cell);
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  return table;
}

/** 这一条有没有"可点开"的目标 */
function targetClickable(t: SiTarget): boolean {
  return t.kind === "word" || t.kind === "doc" ? true : t.pageIndex !== null;
}

/* ---------------- 位置 / 尺寸的持久化 ---------------- */

interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const RECT_PREF = `${config.prefsPrefix}.siPanelRect`;

function loadRect(): PanelRect | null {
  try {
    const s = Zotero.Prefs.get(RECT_PREF, true) as string | undefined;
    if (!s) {
      return null;
    }
    const o = JSON.parse(s) as PanelRect;
    if (
      typeof o?.w === "number" &&
      typeof o?.h === "number" &&
      typeof o?.x === "number" &&
      typeof o?.y === "number"
    ) {
      return o;
    }
  } catch (e) {
    void debugLog("si", `读浮窗位置失败（忽略）: ${e}`);
  }
  return null;
}

function saveRect(r: PanelRect): void {
  try {
    Zotero.Prefs.set(RECT_PREF, JSON.stringify(r), true);
  } catch (e) {
    void debugLog("si", `存浮窗位置失败（忽略）: ${e}`);
  }
}

/**
 * ⚠️ 阅读器**工具栏是一块"窗口拖动区"**（`reader.css` 里 `.toolbar{-moz-window-dragging:drag}`）。
 * Firefox 的拖动区是**窗口级矩形**：不管谁盖在上面，只要按下点落在那块区域，
 * 就被当成"拖标题栏"，整个 Zotero 窗口会跟着鼠标走。
 *
 * 所以这里把浮窗的**上边界卡在工具栏下方** —— 让它压根不压到那块区域。
 * （另一道保险是给浮窗自己设 `-moz-window-dragging: no-drag`，双保险。）
 */
function topLimit(doc: Document): number {
  try {
    const tb = doc.querySelector(".toolbar") as HTMLElement | null;
    if (tb) {
      const b = tb.getBoundingClientRect();
      if (b.height > 0) {
        return Math.ceil(b.bottom) + 2;
      }
    }
  } catch {
    /* ignore */
  }
  return 0;
}

function clampToView(doc: Document, r: PanelRect): PanelRect {
  const view = doc.defaultView;
  const vw = view?.innerWidth ?? 1200;
  const vh = view?.innerHeight ?? 800;
  const w = Math.min(Math.max(MIN_W, r.w), Math.max(MIN_W, vw - 20));
  const h = Math.min(Math.max(MIN_H, r.h), Math.max(MIN_H, vh - 20));
  // 至少留 60px 在视野内，免得拖没了找不回来
  const x = Math.min(Math.max(r.x, 60 - w), vw - 60);
  const yMin = topLimit(doc);
  const y = Math.min(Math.max(r.y, yMin), vh - 30);
  return { x, y, w, h };
}

/* ---------------- 浮窗本体 ---------------- */

/**
 * 建浮窗骨架（只建一次，之后复用）。
 */
function ensurePanel(doc: Document): HTMLElement {
  const existing = doc.getElementById(PANEL_ID) as HTMLElement | null;
  if (existing) {
    return existing;
  }

  const rect = clampToView(doc, loadRect() ?? {
    x: (doc.defaultView?.innerWidth ?? 1200) - DEFAULT_W - 24,
    y: 80,
    w: DEFAULT_W,
    h: DEFAULT_H,
  });

  const panel = el(doc, "div", {
    position: "fixed",
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.w}px`,
    height: `${rect.h}px`,
    display: "flex",
    flexDirection: "column",
    // 浮在 PDF 与划词弹窗之上
    zIndex: "2147483000",
    background: "var(--color-sidepane, #f5f5f5)",
    color: "var(--fill-primary, #111)",
    border: "1px solid rgba(0,0,0,0.35)",
    borderRadius: "8px",
    boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
    overflow: "hidden",
    boxSizing: "border-box",
    fontSize: "13px",
    lineHeight: "1.45",
  });
  panel.id = PANEL_ID;
  // ⚠️ 显式声明这里**不是窗口拖动区**。
  // Firefox 的窗口拖动区由祖先的 `-moz-window-dragging: drag` 决定；
  // 子元素写 `no-drag` 用于**从祖先的拖动区里挖掉自己**。
  // 不写的话：浮窗若落在某个拖动区上，按住标题栏拖动会变成"拖整个窗口"
  // （用户实测反馈：「支撑信息的框我一拖动，就把整个软件拖动了」）。
  //
  // ⚠️ 这条**不是**靠 CSS 类/样式表设的，而是内联 + 直接写 property，
  //    因为 `-moz-window-dragging` 不是标准属性，TS 的 CSSStyleDeclaration 里没有它。
  panel.style.setProperty("-moz-window-dragging", "no-drag");

  // ── 标题栏（拖动把手）
  const head = el(doc, "div", {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "5px 8px",
    background: "rgba(127,127,127,0.22)",
    cursor: "move",
    flexShrink: "0",
    userSelect: "none",
    // 同上（非标准属性，用 setProperty 写更稳）
  });
  head.id = `${PANEL_ID}-head`;
  // 同上：标题栏是拖动把手，绝不能同时是"窗口拖动区"
  head.style.setProperty("-moz-window-dragging", "no-drag");
  const title = el(
    doc,
    "span",
    { fontWeight: "700", flexShrink: "0", whiteSpace: "nowrap" },
    "支撑信息",
  );
  head.appendChild(title);
  const hint = el(
    doc,
    "span",
    { flex: "1", opacity: "0.55", fontSize: "0.85em", whiteSpace: "nowrap" },
    "拖动移动 · 右下角缩放",
  );
  head.appendChild(hint);
  const openAll = el(
    doc,
    "span",
    {
      cursor: "pointer",
      padding: "1px 8px",
      borderRadius: "4px",
      background: "rgba(127,127,127,0.25)",
      flexShrink: "0",
    },
    "打开 SI",
  );
  openAll.id = `${PANEL_ID}-open`;
  head.appendChild(openAll);
  const close = el(
    doc,
    "span",
    { cursor: "pointer", opacity: "0.6", flexShrink: "0", padding: "0 4px" },
    "✕",
  );
  close.title = "关闭这一块";
  close.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setPanelVisible(panel, false);
  });
  head.appendChild(close);
  panel.appendChild(head);

  // ── 内容区（自己滚动）
  const body = el(doc, "div", {
    flex: "1 1 auto",
    minHeight: "0",
    overflow: "auto",
    padding: "6px 8px 8px 8px",
  });
  body.id = `${PANEL_ID}-body`;
  panel.appendChild(body);

  // ── 右下角缩放手柄
  const grip = el(doc, "div", {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: `${GRIP}px`,
    height: `${GRIP}px`,
    cursor: "nwse-resize",
    // 三道斜线，明确「这里能拉」
    background:
      "linear-gradient(135deg, transparent 0 40%, currentColor 40% 48%, transparent 48% 62%, currentColor 62% 70%, transparent 70% 84%, currentColor 84% 92%, transparent 92%)",
    opacity: "0.55",
    borderBottomRightRadius: "8px",
  });
  grip.title = "拖动改变大小";
  panel.appendChild(grip);

  doc.body.appendChild(panel);
  // ── 取证：浮窗会不会压在「窗口拖动区」上
  //
  // ⚠️ 必须用**几何重叠**判定，不能走祖先链：
  //    阅读器的 `.toolbar` 是 `-moz-window-dragging: drag`，而浮窗是它的**兄弟节点**
  //    （都挂在 reader 文档的 body 下）。祖先链上一个拖动区都查不到，
  //    但 Firefox 的拖动区是**窗口级矩形**，不管谁盖在上面 —— 于是拖浮窗就拖了整个窗口。
  try {
    const w = doc.defaultView as any;
    const inPdf = !!w?.PDFViewerApplication;
    const tb = doc.querySelector(".toolbar") as HTMLElement | null;
    let note = "没找到 .toolbar";
    if (tb) {
      const a = panel.getBoundingClientRect();
      const b = tb.getBoundingClientRect();
      const overlap = !(
        a.right < b.left ||
        a.left > b.right ||
        a.bottom < b.top ||
        a.top > b.bottom
      );
      const drag =
        w?.getComputedStyle?.(tb)?.getPropertyValue("-moz-window-dragging") || "?";
      const mine =
        w?.getComputedStyle?.(panel)?.getPropertyValue("-moz-window-dragging") ||
        "?";
      note =
        `工具栏拖动区=${drag.trim()} 与工具栏重叠=${overlap ? "是" : "否"}` +
        ` 浮窗自身=${mine.trim()}`;
    }
    void debugLog(
      "si",
      `浮窗文档=${inPdf ? "内层(PDF)" : "外层(reader)"} | ${note}`,
    );
  } catch (e) {
    void debugLog("si", `取证失败: ${e}`);
  }

  attachPanelDrag(doc, panel, head, rect);
  attachPanelResize(doc, panel, grip, rect);

  void debugLog("si", `SI 浮窗已创建 @ ${rect.x},${rect.y} ${rect.w}x${rect.h}`);
  return panel;
}

/** 拖标题栏移动 */
function attachPanelDrag(
  doc: Document,
  panel: HTMLElement,
  head: HTMLElement,
  rect: PanelRect,
) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseX = rect.x;
  let baseY = rect.y;

  head.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    // 别把「打开 SI / ✕」的点击吃掉
    const t = e.target as HTMLElement | null;
    if (t && t.id && t.id.startsWith(`${PANEL_ID}-`)) {
      return;
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    baseX = panel.offsetLeft;
    baseY = panel.offsetTop;
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  });
  // ⚠️ 补一道 mousedown：Firefox 的原生"窗口拖动"是**在 mousedown 上**判定的，
  //    pointerdown 里 preventDefault 未必拦得住（用户实测：拖浮窗把整个窗口拖走了）。
  head.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  });
  // 别让浏览器把这次按下当成 HTML5 拖放（拖出一张"幽灵图"或触发原生拖动）
  head.addEventListener("dragstart", (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  });
  head.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const vw = doc.defaultView?.innerWidth ?? 1200;
    const vh = doc.defaultView?.innerHeight ?? 800;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const x = Math.min(Math.max(baseX + e.clientX - startX, 60 - w), vw - 60);
    // 上边界同样卡在工具栏下方 —— 那是一条"窗口拖动区"，不能压上去
    const y = Math.min(
      Math.max(baseY + e.clientY - startY, topLimit(doc)),
      vh - 30,
    );
    panel.style.left = `${Math.round(x)}px`;
    panel.style.top = `${Math.round(y)}px`;
  });
  const up = (e: PointerEvent) => {
    if (!dragging) {
      return;
    }
    dragging = false;
    try {
      head.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    saveRect({
      x: panel.offsetLeft,
      y: panel.offsetTop,
      w: panel.offsetWidth,
      h: panel.offsetHeight,
    });
  };
  head.addEventListener("pointerup", up);
  head.addEventListener("pointercancel", up);
}

/** 拖右下角自由改大小（插图会跟着缩放） */
function attachPanelResize(
  doc: Document,
  panel: HTMLElement,
  grip: HTMLElement,
  rect: PanelRect,
) {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let baseW = rect.w;
  let baseH = rect.h;

  grip.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) {
      return;
    }
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    baseW = panel.offsetWidth;
    baseH = panel.offsetHeight;
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  });
  grip.addEventListener("pointermove", (e: PointerEvent) => {
    if (!resizing) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const vw = doc.defaultView?.innerWidth ?? 1200;
    const vh = doc.defaultView?.innerHeight ?? 800;
    const w = Math.min(Math.max(MIN_W, baseW + e.clientX - startX), vw - 20);
    const h = Math.min(Math.max(MIN_H, baseH + e.clientY - startY), vh - 20);
    panel.style.width = `${Math.round(w)}px`;
    panel.style.height = `${Math.round(h)}px`;
  });
  const up = (e: PointerEvent) => {
    if (!resizing) {
      return;
    }
    resizing = false;
    try {
      grip.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    saveRect({
      x: panel.offsetLeft,
      y: panel.offsetTop,
      w: panel.offsetWidth,
      h: panel.offsetHeight,
    });
  };
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

/**
 * 保证 KaTeX 样式表在这个文档里（浮窗与划词弹窗在同一个阅读器文档上，
 * 弹窗建的时候通常已经注入了；这里只是兜底，重复注入会被 href 判重挡掉）。
 */
function ensureKatexCss(doc: Document): void {
  try {
    const href = `chrome://${config.addonRef}/content/styles/katex.min.css`;
    if (!doc.querySelector(`link[href="${href}"]`)) {
      const link = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "link",
      ) as HTMLLinkElement;
      link.rel = "stylesheet";
      link.href = href;
      (doc.head || doc.documentElement).appendChild(link);
    }
  } catch (e) {
    void debugLog("si", `注入 KaTeX 样式失败: ${e}`);
  }
}

/**
 * ⭐ 把一段（可能是模型输出的）富文本放进容器。
 *
 * 图和表注里几乎必然带 `$...$` 公式（`$\eta_c$`、`$3\ M\ MgCl_2$`）和 `**加粗**`。
 * 一开始我直接 `textContent = 译文`，结果用户看到的是**原始标记**：
 *     **表 S4** 采用…与 $3\ M\ MgCl_2$ 电解液…能量指标 $\eta_c$ (%)
 * 主译文走的是 `renderRichInText`（KaTeX + 粗体），图注必须走同一条路。
 * 该函数内部是**转义后**再拼标签的，和主译文的处理完全一致，不引入新的注入面。
 */
function setRichText(doc: Document, box: HTMLElement, text: string): void {
  if (needsRichRendering(text)) {
    ensureKatexCss(doc);
    box.innerHTML = renderRichInText(doc, text);
  } else {
    box.textContent = text;
  }
}

/* ---------------- 图注翻译 ---------------- */

/** 图注译文缓存：同一条图注只翻一次（插件自己的翻译记忆也会兜一层） */
const captionTrans = new Map<string, Promise<string>>();

/**
 * ⭐ SI 图注专用提示词。
 *
 * 直接用全局那套正文提示词会出两个问题（实测）：
 *  1. 它的第 2 条把「短独立行」当章节标题要求用 `**` 包起来 ——
 *     SI 图注开头的 `Table S4` / `Figure S3` 正好命中，于是输出变成 `**表 S4**`；
 *  2. 它是给成段正文写的（保句结构、不合并段落…），而图注是**一整句到几句的说明**，
 *     更该按「图注」的习惯组织语言。
 *
 * 所以给图注单独一套规则。模板里必须保留 `${sourceText}` 与 `${langTo}` 占位符 ——
 * `buildPromptParts` 靠 `${sourceText}` 把指令和待译文本切开。
 */
const CAPTION_PROMPT = `这是一篇学术论文**支撑信息（Supporting Information）**里的图注或表注，请翻译成 \${langTo}。

规则：
1. 开头形如 "Figure S3" / "Table S4" / "Fig. S2" 的**编号标签**要保留（编号 S3、S6b 不得改写），并用 ** ** 让它突出显示，例如 **表 S4**；不要把它当成章节标题单独换行。
2. 术语准确、语句通顺，按中文科技论文图注的习惯表达（如 "SSA experiments with BPL electrodes" 译为 "BPL 电极的 SSA 实验"）。
3. 公式、上下标、化学式、单位用 LaTeX 写在 $...$ 里（如 $CO_2$、$3\\ M\\ MgCl_2$、$\\eta_c$、$mmol\\ kg^{-1}$）；不要输出 Unicode 上下标；普通数字与百分号保持普通文本（如 84.2 %、0 min）。
4. 所有数值、单位、字母编号、交叉引用（(a)、(b)、Figure S6b、Table S4）原样保留，一个都不能改或省略。
5. 原文若把表头几列挤在一起（如 "Parameter 0 min hold 30 min hold 60 min hold"），按中文习惯在列名之间加顿号或空格分开，但仍保持同一行。
6. 只输出译文：不要解释、不要加引号、不要 markdown 标题、不要用 # 或 - 列表。

\${sourceText}`;

/**
 * ⭐ 顺带把 SI 图注也翻译了。
 *
 * 走插件**自己的翻译服务**（和正文翻译同一套）：`addTranslateTask` + `onTranslate`，
 * 所以用的还是你配的 MiMo、也吃同一份翻译记忆缓存 —— 不会额外多花钱。
 *
 * `type` 用 `"custom"`：这样它不会混进 `getLastTranslateTask({type:"text"})`，
 * 也就不会干扰划词弹窗那条链路。
 */
function translateCaption(text: string, itemId?: number): Promise<string> {
  const key = text.trim();
  if (!key) {
    return Promise.resolve("");
  }
  const hit = captionTrans.get(key);
  if (hit) {
    return hit;
  }
  const job = (async () => {
    try {
      const addon = (Zotero as unknown as Record<string, any>)[
        config.addonInstance
      ];
      if (!addon?.hooks?.onTranslate) {
        return "";
      }
      const task = addTranslateTask(key, itemId, "custom");
      if (!task) {
        return "";
      }
      // 图注用专用提示词（见 CAPTION_PROMPT 的说明）
      task.promptOverride = CAPTION_PROMPT;
      await addon.hooks.onTranslate(task, {
        noCheckZoteroItemLanguage: true,
        noDisplay: true,
      });
      if (task.status !== "success") {
        void debugLog("si", `图注翻译未成功: ${task.status} ${task.result}`);
        return "";
      }
      return task.result || "";
    } catch (e) {
      void debugLog("si", `图注翻译异常: ${e}`);
      return "";
    }
  })();
  captionTrans.set(key, job);
  return job;
}

/* ---------------- 内容 ---------------- */

/**
 * 把一批 SI 引用画进浮窗。
 * 插图宽度跟随浮窗宽度 —— 用户拉大浮窗，图就变大，这就是「大小随意改」。
 */
function renderContent(
  doc: Document,
  body: HTMLElement,
  targets: SiTarget[],
  sizeHint: HTMLElement,
  itemId?: number,
): void {
  body.textContent = "";

  const pending: {
    slot: HTMLElement;
    attachmentId: number;
    pageIndex: number;
    media: string | null;
  }[] = [];

  targets.forEach((t, idx) => {
    const block = el(doc, "div", {
      marginTop: idx === 0 ? "0" : "10px",
      paddingTop: idx === 0 ? "0" : "8px",
      borderTop: idx === 0 ? "none" : "1px solid rgba(127,127,127,0.3)",
    });

    const clickable = targetClickable(t);
    const line = el(doc, "div", {
      display: "flex",
      alignItems: "baseline",
      gap: "6px",
      cursor: clickable ? "pointer" : "default",
    });
    line.appendChild(
      el(
        doc,
        "span",
        { fontWeight: "700", flexShrink: "0", whiteSpace: "nowrap" },
        t.ref.label,
      ),
    );
    line.appendChild(
      el(
        doc,
        "span",
        { flex: "1", opacity: "0.65", fontSize: "0.9em" },
        targetHint(t),
      ),
    );
    if (clickable) {
      line.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openSiPage(t.attachmentId, t.pageIndex);
      });
    }
    block.appendChild(line);

    if (t.caption) {
      block.appendChild(
        el(
          doc,
          "div",
          {
            marginTop: "3px",
            opacity: "0.85",
            fontSize: "0.92em",
            lineHeight: "1.4",
          },
          t.caption,
        ),
      );
      // ⭐ 图注也翻译一份（异步填，先占位）
      const trans = el(
        doc,
        "div",
        {
          marginTop: "2px",
          fontSize: "0.92em",
          lineHeight: "1.4",
          color: "var(--fill-secondary, #0a84ff)",
          opacity: "0.9",
        },
        "（正在翻译图注…）",
      );
      block.appendChild(trans);
      void translateCaption(t.caption, itemId).then((zh) => {
        if (!trans.isConnected) {
          return;
        }
        if (!zh) {
          trans.remove();
          return;
        }
        setRichText(doc, trans, zh);
      });
    }

    // ⭐ Word 里的**真表格**：没有图片可给，直接把行列画出来
    //    （实测 `Table S2` 是 2×2 化学方程式表格，之前只显示"没有对应图片"）
    if (t.table?.length) {
      block.appendChild(buildTable(doc, t.table));
    }

    // 有图才占位：PDF 要有页码，Word 要有媒体名
    if (t.pageIndex !== null || t.media) {
      const slot = el(
        doc,
        "div",
        { marginTop: "5px", opacity: "0.6", fontSize: "0.9em" },
        "正在取图…",
      );
      block.appendChild(slot);
      pending.push({
        slot,
        attachmentId: t.attachmentId,
        pageIndex: t.kind === "word" ? -1 : (t.pageIndex as number),
        media: t.media,
      });
    }
    body.appendChild(block);
  });

  if (pending.length) {
    void fillFigures(doc, pending, sizeHint);
  }
}

async function fillFigures(
  doc: Document,
  pending: {
    slot: HTMLElement;
    attachmentId: number;
    pageIndex: number;
    media: string | null;
  }[],
  sizeHint: HTMLElement,
): Promise<void> {
  let ok = 0;
  await Promise.all(
    pending.map(async ({ slot, attachmentId, pageIndex, media }) => {
      const url = await getSiFigure(attachmentId, pageIndex, doc, media);
      if (!slot.isConnected) {
        return;
      }
      if (!url) {
        slot.textContent = media
          ? "（这张图取不到：Word 里的图片格式解不了）"
          : "（这一页取不到图：嵌入位图和整页渲染都失败了）";
        slot.style.opacity = "0.6";
        return;
      }
      slot.textContent = "";
      slot.style.opacity = "1";
      const img = el(doc, "img", {
        display: "block",
        // 宽度跟随浮窗 → 拉大浮窗图就变大
        width: "100%",
        height: "auto",
        borderRadius: "4px",
        border: "1px solid rgba(127,127,127,0.35)",
        background: "#ffffff",
      });
      img.src = url;
      img.alt = media ? `Word SI 插图 ${media}` : `SI 第 ${pageIndex + 1} 页插图`;
      img.addEventListener("error", () => {
        void debugLog("si", `插图加载失败: ${url.slice(0, 64)}…`);
        slot.textContent = "插图加载失败";
        slot.style.opacity = "0.6";
      });
      slot.appendChild(img);
      ok++;
    }),
  );
  if (ok > 0) {
    sizeHint.textContent = "拖动移动 · 右下角缩放";
  }
}

/* ---------------- 对外入口 ---------------- */

/** 上一次画的 key，避免流式翻译期间反复重画 */
let lastKey = "";

/**
 * 正文里出现 SI 引用时显示/更新浮窗；**不再出现时就收掉**。
 *
 * ⭐ 这条行为是用户定的：
 *   「我读文献的时候，翻译到这里了，把支撑信息的图搞出来；我读下一部分了，
 *     支撑信息的图就可以移除了」
 * 我上一版恰好写反了（特意做成「没有引用也不动它」），所以图会一直挂在那儿 ——
 * 现在改成：**译文不再提到 SI 图 → 自动收起**（位置尺寸仍然记住，下次还在原地）。
 */
export async function updateSiFloating(
  doc: Document,
  taskId: string,
  sourceText: string,
  itemId: number | undefined,
): Promise<void> {
  try {
    const refs = parseSiRefs(sourceText);
    const key = `${taskId}|${itemId}|${refs.map((r) => r.label).join(",")}`;
    if (key === lastKey) {
      return;
    }
    lastKey = key;

    if (!refs.length) {
      // ⚠️ 保护：**太短的碎片划选不触发收起**。
      // 实测一次拖拽会派发两次选区事件，第二次常是半句/一个词；
      // 不加这条就会「图刚出来就被自己收掉」，用户看到的是闪一下。
      const trimmed = (sourceText || "").trim();
      if (trimmed.length < MIN_HIDE_LEN) {
        return;
      }
      // 译文里不再有 SI 引用 → 收起浮窗（不清 pref，位置尺寸留着）
      const old = doc.getElementById(PANEL_ID) as HTMLElement | null;
      if (old && !old.hidden) {
        setPanelVisible(old, false);
        void debugLog(
          "si",
          `本段没有 SI 引用，浮窗已自动收起（本次原文 ${JSON.stringify(trimmed.slice(0, 48))}）`,
        );
      }
      return;
    }

    const targets = await lookupSiTargets(refs, itemId);
    if (key !== lastKey) {
      return;
    }
    if (!targets.length) {
      void debugLog("si", "这篇没有 SI 附件，浮窗不动");
      return;
    }

    const panel = ensurePanel(doc);
    setPanelVisible(panel, true);
    const body = doc.getElementById(`${PANEL_ID}-body`) as HTMLElement | null;
    const head = doc.getElementById(`${PANEL_ID}-head`) as HTMLElement | null;
    const openAll = doc.getElementById(
      `${PANEL_ID}-open`,
    ) as HTMLElement | null;
    if (!body) {
      return;
    }
    const hint = head?.querySelector("span:nth-child(2)") as HTMLElement | null;
    // 「打开 SI」按钮始终指向当前这批的第一条
    if (openAll) {
      const first = targets[0];
      openAll.onclick = (ev: Event) => {
        ev.preventDefault();
        ev.stopPropagation();
        openSiPage(first.attachmentId, null);
      };
    }
    renderContent(doc, body, targets, hint ?? doc.body, itemId);
  } catch (e) {
    void debugLog("si", `更新 SI 浮窗失败: ${e}`);
  }
}
