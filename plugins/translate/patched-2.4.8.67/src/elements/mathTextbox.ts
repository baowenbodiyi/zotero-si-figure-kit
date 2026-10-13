import { config } from "../../package.json";
// ⭐ 补丁：公式 + 章节标题（加粗）一起渲染
import { needsRichRendering, renderRichInText } from "../utils/mathRenderer";
// ⭐ 补丁：点引用角标 → 显示那条参考文献
import {
  attachCitationHandler,
  CITATION_BOX_STYLE,
} from "../modules/citationBox";
import { getLastTranslateTask } from "../utils/task";
import { getPref } from "../utils/prefs";

export class MathTextboxElement extends XULElementBase {
  private _textbox: XULTextBoxElement | null = null;
  private _overlay: HTMLElement | null = null;
  private _value: string = "";

  get content() {
    return MozXULElement.parseXULToFragment(`
      <editable-text id="inner-textbox" multiline="true" />
      <linkset>
        <html:link
          rel="stylesheet"
          href="chrome://${config.addonRef}/content/styles/mathTextbox.css"
        ></html:link>
        <html:link
          rel="stylesheet"
          href="chrome://${config.addonRef}/content/styles/katex.min.css"
        ></html:link>
      </linkset>
    `);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.init();
  }

  init(): void {
    this._textbox = this.querySelector("#inner-textbox") as XULTextBoxElement;
    if (!this._textbox) return;
    this._textbox.addEventListener("input", this._onInput);
    this._textbox.addEventListener("focus", this._onFocus);
    this._textbox.addEventListener("blur", this._onBlur);
  }

  set value(v: string) {
    this._value = v ?? "";
    if (this._textbox) this._textbox.value = this._value;
    this._updateOverlay();
  }
  get value() {
    return this._textbox?.value ?? this._value;
  }

  set placeholder(v: string) {
    if (this._textbox) this._textbox.placeholder = v;
  }

  focus(): void {
    this._textbox?.focus();
  }

  private _onInput = (e: Event) => {
    const val = (e.target as HTMLTextAreaElement).value;
    this._value = val;
    // do not redispatch input; bubble from inner editable-text already reaches panel listener
  };

  private _onFocus = () => {
    this._hideOverlay();
  };

  private _onBlur = () => {
    this._updateOverlay();
  };

  private _updateOverlay(): void {
    // Respect user preference gate
    const enabled = (getPref("enableMathRendering") as boolean) === true;
    if (!enabled || !this._value || !needsRichRendering(this._value)) {
      this._hideOverlay();
      return;
    }
    this._showOverlay();
  }

  /** ⭐ 补丁：引用详情框（点角标时用），挂在 math-textbox 内部 */
  private _ensureRefbox(): HTMLElement {
    let box = this.querySelector("#refbox") as HTMLElement | null;
    if (!box) {
      const HTML_NS = "http://www.w3.org/1999/xhtml";
      box = document.createElementNS(HTML_NS, "div") as unknown as HTMLElement;
      box.id = "refbox";
      Object.assign(box.style, CITATION_BOX_STYLE);
      box.hidden = true;
      this.appendChild(box);
    }
    return box;
  }

  private _showOverlay(): void {
    if (this._overlay) this._overlay.remove();
    const HTML_NS = "http://www.w3.org/1999/xhtml";
    const overlay = document.createElementNS(
      HTML_NS,
      "div",
    ) as unknown as HTMLElement;
    overlay.className = "math-overlay";
    overlay.innerHTML = renderRichInText(document, this._value);
    // ⭐ 补丁：点引用角标 → 就地在下面展开那条参考文献（不关叠层）
    attachCitationHandler(
      overlay,
      () => this._ensureRefbox(),
      () => getLastTranslateTask()?.itemId,
    );
    overlay.addEventListener("click", (ev: Event) => {
      // 点在引用角标上时不收叠层，交给上面的委托处理
      if ((ev.target as HTMLElement)?.closest?.(".zoteropdftranslate-cite")) {
        return;
      }
      this._hideOverlay();
      this._textbox?.focus();
    });
    this._overlay = overlay;
    this.appendChild(overlay);
    this.toggleAttribute("overlay-visible", true);
  }

  private _hideOverlay(): void {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    this.toggleAttribute("overlay-visible", false);
  }

  destroy(): void {
    this._hideOverlay();
    if (this._textbox) {
      this._textbox.removeEventListener("input", this._onInput);
      this._textbox.removeEventListener("focus", this._onFocus);
      this._textbox.removeEventListener("blur", this._onBlur);
    }
  }
}
