/**
 * ⭐ 补丁：点译文里的引用角标 `[26]` → 就地显示这条参考文献 + DOI。
 *
 * 渲染一律用 DOM 节点 + textContent，**绝不 innerHTML 拼参考文献文本**
 * （那是从 PDF 抽出来的任意字符串，拼 HTML 等于自己开了个注入口子）。
 */
import type { CiteRef } from "../utils/citationRefs";
import {
  expandCiteToken,
  getReferenceMap,
  resolveDoiOnline,
} from "../utils/citationRefs";
import { CITE_CLASS } from "../utils/mathRenderer";

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

function copyText(text: string, label: string) {
  try {
    new ztoolkit.Clipboard().addText(text, "text/plain").copy();
    new ztoolkit.ProgressWindow("Translate for Zotero", { closeTime: 1500 })
      .createLine({ text: `${label}已复制`, type: "success" })
      .show();
  } catch (e) {
    ztoolkit.log("copy failed", e);
  }
}

/**
 * 把引用渲染进 `box`。再点同一个角标 = 收起。
 */
/**
 * ⭐ 统一显隐。
 *
 * ⚠️⚠️ 这里有个踩过的坑：`CITATION_BOX_STYLE` 里有 **内联的 `display: block`**，
 * 而 `hidden` 属性是靠 UA 规则 `[hidden] { display: none }` 生效的 ——
 * **内联样式的优先级更高，会把 `[hidden]` 压掉**。
 * 后果：这个框从建好起就**一直显示**（弹窗下方那块空灰色区域就是它），
 * 点 ✕ 设 `hidden = true` 也**毫无视觉变化** → 用户报「参考文献窗口关不掉」。
 *
 * 所以：**设 hidden 的同时把 display 一起写掉**，不再依赖属性单独的语义。
 */
export function setBoxVisible(box: HTMLElement, visible: boolean): void {
  box.hidden = !visible;
  box.style.display = visible ? "block" : "none";
}

export async function renderCitationBox(
  box: HTMLElement,
  token: string,
  itemId: number | undefined,
): Promise<void> {
  const doc = box.ownerDocument;
  if (box.dataset.cite === token && !box.hidden) {
    setBoxVisible(box, false);
    return;
  }
  box.dataset.cite = token;
  setBoxVisible(box, true);
  box.textContent = `正在从这篇 PDF 的参考文献表里读取 [${token}] …`;

  const refs = await getReferenceMap(itemId);
  const nums = expandCiteToken(token);
  const found = nums
    .map((n) => refs.get(n))
    .filter((r): r is CiteRef => !!r);

  box.textContent = "";

  // ⭐⭐ 补丁：**统一一条带 ✕ 的标题栏，成功和失败都要有。**
  //
  // 曾经的 bug（用户报「参考文献窗口关不掉」）：解析不到条目时只渲染一条提示、
  // **那个分支里没有 ✕**，于是除了「再点一次同一个角标」或「重新划词」就没法收起它。
  // 教训：**任何能打开的面板，都要有一条不依赖数据是否存在的关闭路径。**
  const bar = el(doc, "div", {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    marginBottom: "4px",
  });
  bar.appendChild(
    el(doc, "span", { fontWeight: "700", flexShrink: "0" }, `参考文献 [${token}]`),
  );
  bar.appendChild(el(doc, "span", { flex: "1" }));
  const closeBtn = el(
    doc,
    "span",
    { cursor: "pointer", opacity: "0.6", flexShrink: "0", padding: "0 4px" },
    "✕",
  );
  closeBtn.title = "关闭";
  closeBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setBoxVisible(box, false);
  });
  bar.appendChild(closeBtn);
  box.appendChild(bar);

  if (!found.length) {
    box.appendChild(
      el(
        doc,
        "div",
        { opacity: "0.75", lineHeight: "1.5" },
        refs.size
          ? `没能在这篇 PDF 的参考文献表里找到编号 [${token}]。`
          : "没能从这篇 PDF 里解析出参考文献表（可能没有编号引用，或全文还没被 Zotero 索引）。",
      ),
    );
    return;
  }

  found.forEach((ref, idx) => {
    const row = el(doc, "div", {
      marginTop: idx === 0 ? "0" : "10px",
      paddingTop: idx === 0 ? "0" : "8px",
      borderTop: idx === 0 ? "none" : "1px solid rgba(127,127,127,0.25)",
    });

    const head = el(doc, "div", {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      marginBottom: "3px",
    });
    head.appendChild(
      el(doc, "span", { fontWeight: "700", flexShrink: "0" }, `[${ref.n}]`),
    );
    head.appendChild(el(doc, "span", { flex: "1" }));
    // 关闭按钮只在顶部那条统一栏里放一个（这里原来每行都有一个，重复且容易看花）
    row.appendChild(head);

    row.appendChild(el(doc, "div", { lineHeight: "1.45" }, ref.text));

    if (ref.doi) {
      const url = `https://doi.org/${ref.doi}`;
      const link = el(
        doc,
        "a",
        {
          display: "inline-block",
          marginTop: "4px",
          color: "var(--fill-secondary, #0a84ff)",
          textDecoration: "underline",
          cursor: "pointer",
          wordBreak: "break-all",
        },
        url,
      );
      link.title = "在浏览器里打开";
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        Zotero.launchURL(url);
      });
      row.appendChild(link);

      const actions = el(doc, "div", { marginTop: "4px", display: "flex", gap: "6px" });
      const doiBtn = el(
        doc,
        "span",
        {
          cursor: "pointer",
          padding: "1px 8px",
          borderRadius: "4px",
          background: "rgba(127,127,127,0.18)",
        },
        "复制 DOI",
      );
      doiBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        copyText(ref.doi as string, "DOI ");
      });
      actions.appendChild(doiBtn);
      const entBtn = el(
        doc,
        "span",
        {
          cursor: "pointer",
          padding: "1px 8px",
          borderRadius: "4px",
          background: "rgba(127,127,127,0.18)",
        },
        "复制条目",
      );
      entBtn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        copyText(ref.text, "条目");
      });
      actions.appendChild(entBtn);
      row.appendChild(actions);
    } else {
      // ⭐ ACS 系参考文献按格式就不写 DOI，这里在线补一个（只在用户点开后才发请求）
      const placeholder = el(
        doc,
        "div",
        { marginTop: "4px", opacity: "0.6" },
        "条目里没写 DOI，正在用 CrossRef 反查…",
      );
      row.appendChild(placeholder);
      void resolveDoiOnline(ref.text).then((doi) => {
        if (!doi) {
          placeholder.textContent = "条目里没写 DOI，CrossRef 也没反查到";
          return;
        }
        ref.doi = doi;
        const url = `https://doi.org/${doi}`;
        const link = el(
          doc,
          "a",
          {
            display: "inline-block",
            marginTop: "4px",
            color: "var(--fill-secondary, #0a84ff)",
            textDecoration: "underline",
            cursor: "pointer",
            wordBreak: "break-all",
          },
          url,
        );
        link.title = "在浏览器里打开（CrossRef 反查得到）";
        link.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          Zotero.launchURL(url);
        });
        placeholder.replaceWith(link);
      });
    }

    box.appendChild(row);
  });
}

/**
 * 给 `source` 挂上「点角标查文献」的委托监听。
 * 点中的必须是 `.${CITE_CLASS}`，其他点击原样放行。
 */
export function attachCitationHandler(
  source: HTMLElement,
  getBox: () => HTMLElement | null,
  getItemId: () => number | undefined,
): void {
  source.addEventListener("click", (ev: Event) => {
    const target = ev.target as HTMLElement | null;
    const cite = target?.closest?.(`.${CITE_CLASS}`) as HTMLElement | null;
    if (!cite) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    const box = getBox();
    if (!box) {
      return;
    }
    void renderCitationBox(box, cite.getAttribute("data-cite") || "", getItemId());
  });
}

/** 引用框的统一样式（弹窗 / 侧栏共用） */
export const CITATION_BOX_STYLE: Partial<CSSStyleDeclaration> = {
  width: "100%",
  boxSizing: "border-box",
  marginTop: "4px",
  padding: "6px 7px",
  borderRadius: "6px",
  background: "rgba(127,127,127,0.12)",
  maxHeight: "38vh",
  overflow: "auto",
  lineHeight: "1.45",
  whiteSpace: "normal",
  wordBreak: "break-word",
  cursor: "default",
};
