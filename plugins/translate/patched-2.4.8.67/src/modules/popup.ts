import { SVGIcon } from "../utils/config";
import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
// ⭐ 补丁：字体族/字号/行高统一入口
import { applyFontStyle, getFontStyle } from "../utils/fontStyle";
// ⭐ 补丁：公式（KaTeX）+ 章节标题加粗 + 引用角标——弹窗里用叠层显示
import { needsRichRendering, renderRichInText } from "../utils/mathRenderer";
// ⭐ 补丁：点引用角标 → 显示那条参考文献
import {
  attachCitationHandler,
  CITATION_BOX_STYLE,
  setBoxVisible,
} from "./citationBox";
import { addTranslateTask, getLastTranslateTask } from "../utils/task";
import { slice } from "../utils/str";
// ⭐ 补丁：正文提到 SI 图（Figure S18）时，在译文下面列出 SI 里那条图注 + 页码
import { updateSiFloating } from "./siBox";
import { BUILD_TAG, debugLog } from "../utils/debugLog";

/**
 * ⭐ 补丁：公式叠层的默认尺寸。
 * 用 `em` 而不是 `px`：字号调大时行宽同比变大，每行字数保持稳定。
 * 这里是**纯 CSS 字符串**，不读布局——`updateReaderPopup()` 是逐 token 调的，
 * 在里面量 scrollHeight 会把流式翻译拖卡。
 */
const MATH_OVERLAY_WIDTH = "min(30em, 76vw)";
const MATH_OVERLAY_MAX_HEIGHT = "60vh";

/**
 * ⭐ 补丁：弹窗里「除译文之外」那一坨的大致高度
 * （高亮色块行 + 拖动条 + A−/A＋/字体按钮行 + 缩放手柄）。
 * 拖右下角时给的是整个弹窗的高度，算叠层的可用高度要把这部分减掉，
 * 否则松开鼠标后 updateReaderPopup 又会按整高撑开一次。
 */
const POPUP_CHROME_HEIGHT = 110;

export function updateReaderPopup() {
  const popup = addon.data.popup.currentPopup;
  if (!popup) {
    return;
  }
  const enablePopup = getPref("enablePopup");
  const hidePopupTextarea = getPref("enableHidePopupTextarea") as boolean;
  Array.from(popup.querySelectorAll(`.${config.addonRef}-readerpopup`)).forEach(
    (elem) => ((elem as HTMLElement).hidden = !enablePopup),
  );

  const idPrefix = popup?.getAttribute(`${config.addonRef}-prefix`);
  const makeId = (type: string) => `${idPrefix}-${type}`;
  const audiobox = popup?.querySelector(
    `#${makeId("audiobox")}`,
  ) as HTMLDivElement;
  const translateButton = popup?.querySelector(
    `#${makeId("translate")}`,
  ) as HTMLDivElement;
  const textarea = popup?.querySelector(
    `#${makeId("text")}`,
  ) as HTMLTextAreaElement;
  const addToNoteButton = popup?.querySelector(
    `#${makeId("addtonote")}`,
  ) as HTMLDivElement;

  const updateHidden = (elem: HTMLElement, hidden: boolean) => {
    if (hidden) {
      elem.style.display = "none";
    } else {
      elem.style.removeProperty("display");
    }
  };

  if (!enablePopup) {
    updateHidden(audiobox, true);
    updateHidden(translateButton, true);
    updateHidden(textarea, true);
    updateHidden(addToNoteButton, true);
    return;
  }
  const task = getLastTranslateTask({ type: "text" });
  if (!task) {
    return;
  }
  popup.setAttribute("translate-task-id", task.id);

  if (task.audio.length > 0 && getPref("showPlayBtn")) {
    audiobox.innerHTML = "";
    updateHidden(audiobox, false);
    ztoolkit.UI.appendElement(
      {
        tag: "fragment",
        children: task.audio.map((audioData) => ({
          tag: "button",
          namespace: "html",
          classList: ["toolbar-button", "wide-button"],
          attributes: {
            tabindex: "-1",
            title: audioData.text,
          },
          properties: {
            innerHTML: `🔊 ${audioData.text}`,
            onclick: () => {
              new (ztoolkit.getGlobal("Audio"))(audioData.url).play();
            },
          },
          styles: { whiteSpace: "nowrap", flexGrow: "1" },
        })),
      },
      audiobox,
    );
  }

  if (task.audio.length > 0 && getPref("showPlayBtn") && getPref("autoPlay")) {
    const firstAudio = task.audio[0];
    const audio = new (ztoolkit.getGlobal("Audio"))(firstAudio.url);
    audio.play();
  }

  const hideTranslateButton = task.status !== "waiting";
  updateHidden(translateButton, hideTranslateButton);

  // ⭐ 补丁：换了新任务（新划词）就把上一条引用详情收起来
  const refbox = popup?.querySelector(`#${makeId("refbox")}`) as HTMLElement | null;
  if (refbox && refbox.dataset.task !== String(task.id)) {
    refbox.dataset.task = String(task.id);
    // ⚠️ 不能只设 hidden：show 过一次之后内联 display 会压掉 [hidden]，见 setBoxVisible
    setBoxVisible(refbox, false);
    refbox.textContent = "";
  }

  switch (task.langto?.split("-")[0]) {
    case "ar":
    case "fa":
    case "he":
      textarea.style.direction = "rtl";
      break;
    default:
      textarea.style.direction = "ltr";
  }

  textarea.hidden = hidePopupTextarea || !hideTranslateButton;
  // 标题标记 `**…**` 在叠层里渲染成加粗；走到 textarea 这条路（没开富文本）时剥掉，
  // 免得用户看到一堆星号
  textarea.value = (task.result || task.raw).replace(/\*\*([^\n]+?)\*\*/g, "$1");
  textarea.style.fontSize = `${getPref("fontSize")}px`;
  textarea.style.lineHeight = `${
    Number(getPref("lineHeight")) * Number(getPref("fontSize"))
  }px`;
  // ⭐ 补丁：字体族（原版这里完全没设置，popup 里还写死成 inherit）
  applyFontStyle(textarea);

  // ⭐ 补丁：译文含公式/上下标时，用 KaTeX 叠层渲染
  // （textarea 是纯文本，结构上无法显示 Cu_{2-x}Se、mAh g^{-1} 这类公式）
  const mathOverlay = popup?.querySelector(
    `#${makeId("mathoverlay")}`,
  ) as HTMLDivElement | null;
  let mathShown = false;
  if (mathOverlay) {
    const rawText = task.result || task.raw || "";
    const mathOn = (getPref("enableMathRendering") as boolean) === true;
    mathShown = !textarea.hidden && mathOn && needsRichRendering(rawText);
    if (mathShown) {
      mathOverlay.innerHTML = renderRichInText(popup.ownerDocument, rawText);
      applyFontStyle(mathOverlay);
    }
    updateHidden(mathOverlay, !mathShown);
    // ⚠️ textarea 的显隐归它的 hidden 属性管（updateHidden 设的是内联 display，
    // 不清掉会残留），所以这里每次都按「该不该显示」重算一遍
    updateHidden(textarea, !!textarea.hidden || mathShown);
  }

  const enableAddToNote = getPref("enableNote") as boolean;
  if (
    !Zotero.getMainWindow().ZoteroContextPane.activeEditor ||
    !enableAddToNote
  ) {
    updateHidden(addToNoteButton, true);
  }

  // 叠层是自适应高度的 div，交给它自己撑开；textarea 被压掉时按它算尺寸会算成 3px
  if (mathShown && mathOverlay) {
    mathOverlay.style.height = "auto";
    // ⚠️ 这里必须「显式写回默认值」，不能 removeProperty：
    // markup 里的宽度也是内联样式，removeProperty 会把它一起删掉，
    // 元素退回 width:auto → 绝对定位父元素走 shrink-to-fit → 撑成整页宽、一行 130 字。
    // （第一版就是这么错的，而且当时测的那条译文很短、max-content 本来就小，
    //   看着像修好了，实际没生效。）
    const keepSize = getPref("keepPopupSize") as boolean;
    mathOverlay.style.width = keepSize
      ? `${getPref("popupWidth")}px`
      : MATH_OVERLAY_WIDTH;
    mathOverlay.style.maxHeight = keepSize
      ? `${Math.max(60, Number(getPref("popupHeight")) - POPUP_CHROME_HEIGHT)}px`
      : MATH_OVERLAY_MAX_HEIGHT;
  } else {
    updatePopupSize(popup, textarea);
  }

  // ⭐ 补丁：正文提到 SI 图就更新那块**独立浮窗**（不在这个弹窗里 —— 用户明确要求分开）。
  // 扫的是**原文** task.raw；翻译把 "Figure" 译成「图」也不影响。
  // 没有 SI 引用时它会直接返回，不动已经打开的浮窗。
  void updateSiFloating(
    popup.ownerDocument,
    task.id,
    task.raw || "",
    Number(popup.dataset.itemId) || undefined,
  );
}

/**
 * ⭐ 补丁：划词弹窗里也放一个「字体」按钮，循环切换几套常用字体。
 * 改的是全局 fontFamily pref，设置里、独立窗口里同步。
 */
/**
 * ⭐ 补丁：译文字体预设。
 * 原插件根本没有「字体」这个概念（上游 issue #504 的答复是 "we cannot change that"），
 * 这里给一个闭集，避免用户手打 CSS font-family 打错。空串 = 跟随 Zotero 主题字体。
 */
export const FONT_PRESETS: {
  label: string;
  short: string;
  value: string;
}[] = [
  { label: "跟随 Zotero", short: "跟随", value: "" },
  {
    label: "思源宋体 / 衬线",
    short: "宋体",
    value: '"Noto Serif SC", "Times New Roman", SimSun, serif',
  },
  {
    label: "微软雅黑 / 无衬线",
    short: "雅黑",
    value: '"Microsoft YaHei", sans-serif',
  },
  { label: "等宽（代码 / 数字对齐）", short: "等宽", value: "Consolas, Ubuntu Mono, monospace" },
];

export function getFontPreset() {
  const current = String(getPref("fontFamily") ?? "");
  const found = FONT_PRESETS.find((p) => p.value === current);
  return found ?? { label: `自定义：${current}`, short: "自定义", value: current };
}

/**
 * ⭐ 补丁：循环切换译文字体（跟随 → 宋体 → 雅黑 → 等宽 → 跟随…）。
 * 按钮文字直接显示当前档位简称，省得用户点完不知道生效没。
 */
export function cycleFontFamily(btn?: HTMLElement | null) {
  const current = String(getPref("fontFamily") ?? "");
  let idx = FONT_PRESETS.findIndex((p) => p.value === current);
  idx = (idx + 1) % FONT_PRESETS.length;
  const next = FONT_PRESETS[idx];
  setPref("fontFamily", next.value);
  // pref 监听也会刷新；这里显式再刷一次，保证当前弹窗立刻变
  updateReaderPopup();
  if (btn) {
    btn.textContent = next.short;
    btn.setAttribute("title", `当前字体：${next.label}（点击切换下一档）`);
  }
}

/**
 * ⭐ 补丁：在划词弹窗里直接改「全局字号」并立刻刷新弹窗。
 * 改的是同一个 fontSize pref，所以在设置里、独立窗口里看到的数字是同步的。
 */
function bumpFontSize(delta: number) {
  const current = Number(getPref("fontSize")) || 12;
  const next = Math.min(48, Math.max(8, current + delta));
  if (next === current) {
    return;
  }
  setPref("fontSize", String(next));
  // pref 监听也会触发刷新；这里再显式刷一次，保证当前弹窗立刻变
  updateReaderPopup();
}

export function buildReaderPopup(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const { reader, doc, append } = event;
  const annotation = event.params.annotation;
  const popup = doc.querySelector(".selection-popup") as HTMLDivElement;
  addon.data.popup.currentPopup = popup;
  void debugLog("boot", `buildReaderPopup | build=${BUILD_TAG}`);
  // ⭐ 补丁：弹窗挂在阅读器文档里，KaTeX 样式表要单独注入，否则渲染出来是裸 HTML
  try {
    const katexHref = `chrome://${config.addonRef}/content/styles/katex.min.css`;
    if (!doc.querySelector(`link[href="${katexHref}"]`)) {
      const link = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "link",
      ) as HTMLLinkElement;
      link.rel = "stylesheet";
      link.href = katexHref;
      (doc.head || doc.documentElement).appendChild(link);
    }
  } catch (e) {
    ztoolkit.log("inject katex css failed", e);
  }
  popup.style.maxWidth = "none";
  popup.setAttribute(
    `${config.addonRef}-prefix`,
    `${config.addonRef}-${reader._instanceID}`,
  );

  const ZoteroContextPane = Zotero.getMainWindow().ZoteroContextPane;

  const colors = popup.querySelector(".colors") as HTMLDivElement;
  colors.style.width = "100%";
  colors.style.justifyContent = "space-evenly";

  const keepSize = getPref("keepPopupSize") as boolean;

  const makeId = (type: string) =>
    `${config.addonRef}-${reader._instanceID}-${type}`;
  const onTextAreaCopy = getOnTextAreaCopy(popup, makeId("text"));

  const hidePopupTextarea = getPref("enableHidePopupTextarea") as boolean;
  append(
    ztoolkit.UI.createElement(doc, "fragment", {
      children: [
        // ⭐ 补丁：拖动手柄。Zotero 自己把 .selection-popup 摆在选区旁边，
        // 但它盖住正文、又挪不走 —— 这里给一条横杠，按住就能把整个弹窗拖开。
        // 做成 16px 高的「点阵抓手」：6px 的细线太不起眼（用户反馈「横线太小」）。
        {
          tag: "div",
          id: makeId("dragbar"),
          classList: [`${config.addonRef}-readerpopup`],
          attributes: { title: getString("readerpopup-drag-title") },
          styles: {
            width: "calc(100% - 4px)",
            margin: "0 2px 6px 2px",
            height: "16px",
            flexShrink: "0",
            borderRadius: "6px",
            background: "rgba(127,127,127,0.12)",
            backgroundImage:
              "radial-gradient(circle, currentColor 1.6px, transparent 1.7px)",
            backgroundSize: "11px 16px",
            backgroundPosition: "center center",
            backgroundRepeat: "repeat",
            opacity: "0.85",
            cursor: "move",
          },
          properties: {
            onpointerup: (e: Event) => e.stopPropagation(),
            onpointerdown: (e: Event) => e.stopPropagation(),
          },
          ignoreIfExists: true,
        },
        {
          tag: "div",
          id: makeId("audiobox"),
          classList: [`${config.addonRef}-readerpopup`],
          styles: {
            display: "flex",
            width: "calc(100% - 4px)",
            marginLeft: "2px",
            justifyContent: "space-evenly",
          },
          ignoreIfExists: true,
        },
        {
          tag: "button",
          namespace: "html",
          id: makeId("translate"),
          classList: [
            "toolbar-button",
            "wide-button",
            `${config.addonRef}-readerpopup`,
          ],
          properties: {
            innerHTML: `${SVGIcon}${getString("readerpopup-translate-label")}`,
            hidden: getPref("enableAuto"),
          },
          listeners: [
            {
              type: "click",
              listener: (ev: Event) => {
                addon.hooks.onTranslate({
                  noCheckZoteroItemLanguage: true,
                  noCache: true,
                });
                const button = ev.target as HTMLDivElement;
                button.hidden = true;
                (
                  button.ownerDocument.querySelector(
                    `#${makeId("text")}`,
                  ) as HTMLTextAreaElement
                ).hidden = hidePopupTextarea;
              },
            },
          ],
          ignoreIfExists: true,
        },
        // ⭐ 补丁：就在划词弹窗（带高亮色块那个）里放 A- / A+，边看译文边调字号
        {
          tag: "div",
          id: makeId("fontsizer"),
          classList: [`${config.addonRef}-readerpopup`],
          styles: {
            display: "flex",
            gap: "4px",
            alignItems: "center",
            marginInline: "2px",
            width: "calc(100% - 4px)",
          },
          children: [
            {
              tag: "button",
              namespace: "html",
              classList: ["toolbar-button", "wide-button"],
              styles: { flex: "1", minWidth: "0" },
              attributes: { title: getString("readerpopup-font-minus-title") },
              properties: {
                textContent: getString("readerpopup-font-minus-label"),
                // 别让点击穿透到选区，否则弹窗会被关掉
                onpointerup: (e: Event) => e.stopPropagation(),
                onpointerdown: (e: Event) => e.stopPropagation(),
              },
              listeners: [{ type: "click", listener: () => bumpFontSize(-1) }],
            },
            {
              tag: "button",
              namespace: "html",
              classList: ["toolbar-button", "wide-button"],
              styles: { flex: "1", minWidth: "0" },
              attributes: { title: getString("readerpopup-font-plus-title") },
              properties: {
                textContent: getString("readerpopup-font-plus-label"),
                onpointerup: (e: Event) => e.stopPropagation(),
                onpointerdown: (e: Event) => e.stopPropagation(),
              },
              listeners: [{ type: "click", listener: () => bumpFontSize(1) }],
            },
            {
              tag: "button",
              namespace: "html",
              classList: ["toolbar-button", "wide-button"],
              styles: { flex: "1", minWidth: "0" },
              attributes: {
                title: `${getString("readerpopup-font-family-title")}（当前：${getFontPreset().label}）`,
              },
              properties: {
                textContent: getFontPreset().short,
                onpointerup: (e: Event) => e.stopPropagation(),
                onpointerdown: (e: Event) => e.stopPropagation(),
              },
              listeners: [
                {
                  type: "click",
                  listener: (ev: Event) =>
                    cycleFontFamily(ev.target as HTMLElement),
                },
              ],
            },
          ],
          ignoreIfExists: true,
        },
        {
          tag: "textarea",
          id: makeId("text"),
          attributes: {
            rows: "3",
            columns: "10",
          },
          classList: [
            `${config.addonRef}-popup-textarea`,
            `${config.addonRef}-readerpopup`,
          ],
          styles: {
            // ⭐ 补丁：原版这里 fontFamily 写死 "inherit"，现在跟随设置
            ...getFontStyle(),
            width: keepSize ? `${getPref("popupWidth")}px` : "-moz-available",
            // Minimum width to prevent the textarea from being smaller than the popup
            minWidth: "184px",
            // ⭐ 补丁：高度随字号自动长高。
            // 原版固定 30px，字号调大后文字被截断/只能滚动，看着就像"改了没变大"。
            height: `${Math.max(
              keepSize ? Number(getPref("popupHeight")) : 30,
              Math.ceil(
                (Number(getPref("fontSize")) || 12) *
                  (Number(getPref("lineHeight")) || 1.5) *
                  1.6,
              ),
            )}px`,
            marginInline: "2px",
            border: "none",
            background: "var(--color-sidepane)",
            borderRadius: "6px",
            padding: "5px",
          },
          properties: {
            onpointerup: (e: Event) => e.stopPropagation(),
            ondragstart: (e: Event) => e.stopPropagation(),
            spellcheck: false,
            value: addon.data.translate.selectedText,
          },
          ignoreIfExists: true,
          listeners: [
            {
              type: "mousedown",
              listener: (_ev) => {
                _ev.target?.addEventListener(
                  "mousemove",
                  onTextAreaResize as (ev: Event) => void,
                );
              },
            },
            {
              type: "mouseup",
              listener: (_ev) => {
                _ev.target?.removeEventListener(
                  "mousemove",
                  onTextAreaResize as (ev: Event) => void,
                );
              },
            },
            {
              type: "keydown",
              listener: onTextAreaCopy as (ev: Event) => void,
            },
            {
              type: "dblclick",
              listener: (_ev) => {
                const textarea = popup.querySelector(
                  `#${makeId("text")}`,
                ) as HTMLTextAreaElement;
                textarea.selectionStart = 0;
                textarea.selectionEnd = textarea.value.length;
                const text = textarea.value.slice(
                  textarea.selectionStart,
                  textarea.selectionEnd,
                );
                new ztoolkit.Clipboard().addText(text, "text/plain").copy();
                new ztoolkit.ProgressWindow("Copied to Clipboard")
                  .createLine({
                    text: slice(text, 50),
                    progress: 100,
                    type: "default",
                  })
                  .show();
              },
            },
          ],
        },
        // ⭐ 补丁：公式叠层。译文含 $...$ / \(...\) 时用 KaTeX 渲染成 HTML 盖在文本框上。
        // 弹窗原本是 <textarea>（纯文本，结构上无法渲染公式），所以走叠层方案。
        {
          tag: "div",
          id: makeId("mathoverlay"),
          classList: [`${config.addonRef}-readerpopup`],
          styles: {
            display: "none",
            // ⭐ 补丁：叠层是 div，不像 textarea 会自己收敛宽度。
            // 不限宽的话长段落会摊成 2500px 宽、一行 130 字，根本没法读。
            // 按「每行约 30 个汉字」定宽（em 跟着 applyFontStyle 设的字号走），
            // 纯 CSS 不读布局（updateReaderPopup 是逐 token 调的，不能强制回流）。
            width: MATH_OVERLAY_WIDTH,
            minWidth: "184px",
            marginInline: "2px",
            background: "var(--color-sidepane)",
            borderRadius: "6px",
            padding: "5px",
            overflow: "auto",
            maxHeight: MATH_OVERLAY_MAX_HEIGHT,
            // ⚠️ 不能用 pre-wrap：renderMathInText 已经把换行转成 <br>，
            // 再 pre-wrap 会一行变两行，而且 KaTeX 内部的空白会被当可见空白
            whiteSpace: "normal",
            wordBreak: "break-word",
          },
          properties: {
            onpointerup: (e: Event) => e.stopPropagation(),
            onpointerdown: (e: Event) => e.stopPropagation(),
          },
          ignoreIfExists: true,
        },
        {
          tag: "button",
          namespace: "html",
          id: makeId("addtonote"),
          classList: [
            "toolbar-button",
            "wide-button",
            `${config.addonRef}-readerpopup`,
          ],
          styles: {
            marginTop: "8px",
          },
          properties: {
            innerHTML: `${SVGIcon}${getString("readerpopup-addToNote-label")}`,
          },
          ignoreIfExists: true,
          listeners: [
            {
              type: "click",
              listener: async (ev) => {
                const noteEditor =
                  ZoteroContextPane && ZoteroContextPane.activeEditor;
                if (!noteEditor) {
                  return;
                }
                const editorInstance = noteEditor.getCurrentInstance();
                if (!editorInstance) {
                  return;
                }
                const task = addTranslateTask(
                  addon.data.translate.selectedText,
                  reader.itemID,
                  "addtonote",
                );
                if (!task) {
                  return;
                }
                await addon.hooks.onTranslate(task, {
                  noCheckZoteroItemLanguage: true,
                  noDisplay: true,
                });
                if (task.status !== "success") {
                  return;
                }
                const replaceMode = getPref("enableNoteReplaceMode") as boolean;
                if (replaceMode) {
                  annotation.text = task.result;
                } else {
                  annotation.comment = task.result;
                }
                // @ts-ignore should be fixed in the zotero-types
                reader._addToNote([annotation]);
              },
            },
          ],
        },
        // ⭐ 补丁：引用详情框。点译文里的 [26] 角标 → 在这里显示那条参考文献 + DOI。
        // 刻意**不加** `${config.addonRef}-readerpopup` class：那个 class 会被
        // updateReaderPopup 里的 enablePopup 开关统一切换显隐，会把关掉的框又打开。
        {
          tag: "div",
          id: makeId("refbox"),
          styles: {
            ...CITATION_BOX_STYLE,
          },
          properties: {
            hidden: true,
            onpointerup: (e: Event) => e.stopPropagation(),
            onpointerdown: (e: Event) => e.stopPropagation(),
          },
          ignoreIfExists: true,
        },
        // ⭐ 补丁：缩放手柄。textarea 自带一个原生手柄，但显示公式叠层时
        // textarea 被 display:none 压掉了，等于没得调；这里补一条**整宽的底边**，
        // 改的是同一组 popupWidth / popupHeight / keepPopupSize，设置页里也能看到数字。
        // （先做成 22×16 的角标、又做成 72×8 的短条，实测都太难命中，索性整条底边。）
        // ⚠️ 现在是 **markup 的最后一个元素** —— SI 插图已经挪到独立的浮窗里，
        // 弹窗里不再有会把它顶出屏幕的东西。（中间有一版把 SI 面板塞在弹窗里，
        // 结果手柄被顶到看不见，用户报「调节翻译框弄不上了」。）
        {
          tag: "div",
          id: makeId("resizer"),
          classList: [`${config.addonRef}-readerpopup`],
          attributes: { title: getString("readerpopup-resize-title") },
          styles: {
            width: "100%",
            height: "9px",
            marginTop: "3px",
            flexShrink: "0",
            borderRadius: "4px",
            background: "currentColor",
            opacity: "0.25",
            cursor: "nwse-resize",
          },
          properties: {
            onpointerup: (e: Event) => e.stopPropagation(),
            onpointerdown: (e: Event) => e.stopPropagation(),
          },
          ignoreIfExists: true,
        },
      ],
    }),
  );

  // ⭐ 补丁：记下这篇附件，供「点角标查文献」用
  popup.dataset.itemId = String(reader.itemID ?? "");

  // ⭐ 补丁：译文叠层里的引用角标可点
  const mathOverlayForCite = popup.querySelector(
    `#${makeId("mathoverlay")}`,
  ) as HTMLElement | null;
  if (mathOverlayForCite) {
    attachCitationHandler(
      mathOverlayForCite,
      () => popup.querySelector(`#${makeId("refbox")}`) as HTMLElement | null,
      () => Number(popup.dataset.itemId) || undefined,
    );
  }

  // ⭐ 补丁：接上「拖动移动」和「右下角缩放」
  const dragbar = popup.querySelector(`#${makeId("dragbar")}`) as HTMLElement;
  const resizer = popup.querySelector(`#${makeId("resizer")}`) as HTMLElement;
  if (dragbar) {
    attachPopupDrag(popup, dragbar);
  }
  if (resizer) {
    attachPopupResize(popup, resizer, makeId);
  }

}

/**
 * ⭐ 补丁：按住横杠把弹窗拖到别处。
 *
 * ⚠️ 用 `transform: translate()` 而不是 left/top。
 * 实测 `.selection-popup` 的定位基准**不是窗口**（offsetLeft=93 时视觉 x≈1442，
 * 基准是页面容器），按 left/top 加增量会被基准偏移坑掉，横向拖不动。
 * transform 是在布局之后叠加的视觉位移，跟 Zotero 用什么定位完全无关。
 *
 * 只对「当前这一个弹窗」有效：重新划词会回到选区旁边 —— 这本就是弹窗该有的行为。
 */
function attachPopupDrag(popup: HTMLElement, handle: HTMLElement) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseTransform = "";
  let rect: DOMRect | null = null;

  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    rect = popup.getBoundingClientRect();
    baseTransform = popup.style.transform || "";
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      /* 某些环境下不支持，忽略即可 */
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging || !rect) return;
    e.preventDefault();
    e.stopPropagation();
    const view = popup.ownerDocument.defaultView;
    const vw = view?.innerWidth ?? 1200;
    const vh = view?.innerHeight ?? 800;
    // 至少留 80px 在视野内，免得拖没了找不回来（重新划词也会复位）
    const dx = clamp(
      e.clientX - startX,
      80 - rect.right,
      Math.max(80 - rect.right, vw - 80 - rect.left),
    );
    const dy = clamp(
      e.clientY - startY,
      8 - rect.top,
      Math.max(8 - rect.top, vh - 44 - rect.top),
    );
    const move = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    popup.style.transform = baseTransform ? `${baseTransform} ${move}` : move;
  };

  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  };

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

/**
 * ⭐ 补丁：拖右下角改弹窗大小。
 *
 * ⚠️ 拖动过程中**不能**调 `updateReaderPopup()` —— 它会重跑
 * `renderRichInText()`（KaTeX 全量重排），每像素一次会卡死。
 * 这里直接改样式，pref 只是顺带存下来（下一次刷新/重启继续用）。
 */
function attachPopupResize(
  popup: HTMLElement,
  handle: HTMLElement,
  makeId: (type: string) => string,
) {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    resizing = true;
    startX = e.clientX;
    startY = e.clientY;
    startW = popup.offsetWidth;
    startH = popup.offsetHeight;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onMove = (e: PointerEvent) => {
    if (!resizing) return;
    e.preventDefault();
    e.stopPropagation();
    const w = Math.round(Math.min(1400, Math.max(260, startW + (e.clientX - startX))));
    const h = Math.round(Math.min(1200, Math.max(90, startH + (e.clientY - startY))));
    setPref("keepPopupSize", true);
    setPref("popupWidth", w);
    setPref("popupHeight", h);

    const overlay = popup.querySelector(
      `#${makeId("mathoverlay")}`,
    ) as HTMLElement | null;
    const textarea = popup.querySelector(
      `#${makeId("text")}`,
    ) as HTMLTextAreaElement | null;
    const overlayVisible = !!overlay && overlay.style.display !== "none";
    if (overlay && overlayVisible) {
      // 叠层是 div：宽度给到弹窗内宽，高度当上限用（内容短就短）
      overlay.style.width = `${Math.max(200, w - 16)}px`;
      overlay.style.maxHeight = `${Math.max(60, h - POPUP_CHROME_HEIGHT)}px`;
    }
    if (textarea) {
      textarea.style.width = `${Math.max(200, w - 16)}px`;
      if (!overlayVisible) {
        textarea.style.height = `${Math.max(30, h - POPUP_CHROME_HEIGHT)}px`;
      }
    }
  };

  const onUp = (e: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
  };

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

function onTextAreaResize(ev: MouseEvent) {
  if (getPref("keepPopupSize")) {
    const textarea = ev.target as HTMLTextAreaElement;
    setPref("popupWidth", textarea.offsetWidth);
    setPref("popupHeight", textarea.offsetHeight);
  }
}

function getOnTextAreaCopy(selectionMenu: HTMLElement, targetId: string) {
  return (ev: KeyboardEvent) => {
    const textarea = selectionMenu.querySelector(
      `#${targetId}`,
    ) as HTMLTextAreaElement;
    const isMod = ev.ctrlKey || ev.metaKey;
    if (ev.key === "c" && isMod) {
      ztoolkit.getGlobal("setTimeout")(() => {
        new ztoolkit.Clipboard()
          .addText(
            textarea.value.slice(
              textarea.selectionStart,
              textarea.selectionEnd,
            ),
            "text/plain",
          )
          .copy();
      }, 10);
      ev.stopPropagation();
    } else if (ev.key === "a" && isMod) {
      textarea.selectionStart = 0;
      textarea.selectionEnd = textarea.value.length;
      ev.stopPropagation();
    } else if (ev.key === "x" && isMod) {
      new ztoolkit.Clipboard()
        .addText(
          textarea.value.slice(textarea.selectionStart, textarea.selectionEnd),
          "text/plain",
        )
        .copy();
      textarea.value = `${textarea.value.slice(
        0,
        textarea.selectionStart,
      )}${textarea.value.slice(textarea.selectionEnd)}`;
      ev.stopPropagation();
    }
  };
}

function updatePopupSize(
  selectionMenu: HTMLDivElement,
  textarea: HTMLTextAreaElement,
  resetSize: boolean = true,
): void {
  const keepSize = getPref("keepPopupSize") as boolean;
  if (keepSize) {
    return;
  }
  if (resetSize) {
    textarea.style.width = "-moz-available";
    textarea.style.height = "30px";
  }
  const viewer = selectionMenu.ownerDocument.body;
  // Get current H & W
  const textHeight = textarea.scrollHeight;
  const textWidth = textarea.scrollWidth;
  const newWidth = textWidth + 20;
  // Check until H/W<0.75 and don't overflow viewer border
  if (
    textHeight / textWidth > 0.75 &&
    selectionMenu.offsetLeft + newWidth < viewer.offsetWidth
  ) {
    // Update width
    textarea.style.width = `${newWidth}px`;
    updatePopupSize(selectionMenu, textarea, false);
    return;
  }
  // Update height
  textarea.style.height = `${textHeight + 3}px`;
}
