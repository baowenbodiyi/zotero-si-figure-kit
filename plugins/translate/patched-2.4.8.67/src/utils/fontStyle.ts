/**
 * 统一计算/应用「字体」相关样式。
 *
 * 原本 fontSize / lineHeight 在三个地方各写一遍内联样式
 * （侧栏面板 elements/panel.ts、划词弹窗 modules/popup.ts、阅读器 Tab modules/tabpanel.ts），
 * 且 popup 里 fontFamily 被写死成 "inherit"，用户无法设置字体。
 *
 * 这里收敛成一份：新增 fontFamily 设置，三个地方共用。
 */
import { getPref } from "./prefs";

export interface FontStyle {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

export function getFontStyle(): FontStyle {
  const size = Number(getPref("fontSize")) || 12;
  const ratio = Number(getPref("lineHeight")) || 1.5;
  const family = String(getPref("fontFamily") ?? "").trim();
  return {
    // 留空 = 跟随 Zotero 自己的字体
    fontFamily: family || "inherit",
    fontSize: `${size}px`,
    lineHeight: `${ratio * size}px`,
  };
}

/** 把字体样式打到 DOM 元素上（HTML 元素或 XUL 元素都可用） */
export function applyFontStyle(el: { style: CSSStyleDeclaration }): void {
  const { fontFamily, fontSize, lineHeight } = getFontStyle();
  el.style.fontFamily = fontFamily;
  el.style.fontSize = fontSize;
  el.style.lineHeight = lineHeight;
}
