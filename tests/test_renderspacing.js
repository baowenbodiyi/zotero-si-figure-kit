#!/usr/bin/env node
/**
 * 译文渲染的段落间距验收（对应「空太大了」那个 bug）。
 *
 * 关键点：**不靠"看代码觉得对"**，而是用**真 HTML5 解析器**解析产物、数 `<br>` 的个数。
 * 还要把**修复前**的写法复刻一份同时跑（A/B），否则测试没有牙齿。
 *
 * ⚠️ 必须用真 HTML5 解析器。`lxml` 这类 HTML4 解析器**不会**把 `</br>` 当成 `<br>`，
 *    用它验会得出"没问题"的错误结论 —— 这个坑本次已经踩过。
 *
 * 依赖：tests/node_modules/parse5（`npm i` in tests/，或 scripts/verify_all.sh 自动装）
 */
"use strict";

const fs = require("fs");
const K = require("./kit");
const { ok, skip, summary, translationSample } = K;

let parse5;
try {
  parse5 = require("parse5");
} catch {
  try {
    parse5 = require(require("path").join(K.KIT, "tests", "node_modules", "parse5"));
  } catch {
    console.error("❌ 缺 parse5（真 HTML5 解析器）。装： cd tests && npm i parse5");
    process.exit(2);
  }
}

const { renderRichInText, escapeHtml } = K.load("mathRenderer");

const mkDoc = () => ({
  createElement() {
    let text = "";
    return {
      set textContent(v) { text = String(v); },
      get textContent() { return text; },
      get innerHTML() {
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      },
    };
  },
});
const doc = mkDoc();

function countBr(html) {
  const frag = parse5.parseFragment(html);
  let n = 0;
  (function walk(node) {
    for (const c of node.childNodes || []) {
      if (c.nodeName === "br") n++;
      walk(c);
    }
  })(frag);
  return n;
}

/* 修复前的写法（复刻，用来做 A/B —— 证明这份测试能抓到 bug） */
function escapeHtmlOld(doc, text) {
  const d = doc.createElement("div");
  d.textContent = text;
  return d.innerHTML.replace(/\n/g, "<br></br>");
}

console.log("\n【0】先证明 bug 真实存在（解析器说了算）");
console.log(`  "a<br></br>b"            → ${countBr("a<br></br>b")} 个 <br>（HTML5 规范：应为 2）`);
console.log(`  旧写法渲染 \\n\\n          → ${countBr(escapeHtmlOld(doc, "\n\n"))} 个 <br>`);
console.log(`  新写法渲染 \\n\\n          → ${countBr(escapeHtml(doc, "\n\n"))} 个 <br>`);
ok("复刻的旧写法确实把 \\n\\n 渲染成 4 个 <br>（=3 个空行）",
   countBr(escapeHtmlOld(doc, "\n\n")) === 4);
ok("新写法 \\n\\n = 2 个 <br>（=1 个空行）", countBr(escapeHtml(doc, "\n\n")) === 2);

console.log("\n【1】换行语义");
for (const c of [
  { t: "a", want: 0, why: "单行" },
  { t: "a\nb", want: 1, why: "单换行" },
  { t: "a\n\nb", want: 2, why: "段落分隔 = 1 空行" },
  { t: "a\n\n\nb", want: 2, why: "多余空行被压掉" },
  { t: "a\n\n\n\n\nb", want: 2, why: "5 个换行也压成 1 空行" },
  { t: "a\n\nb\n\nc", want: 4, why: "两处段落分隔" },
]) {
  const n = countBr(escapeHtml(doc, c.t));
  ok(`${JSON.stringify(c.t)} → ${c.want} 个 <br>（${c.why}）`, n === c.want, `实际 ${n}`);
}
ok("产物里不再出现 </br>", !escapeHtml(doc, "a\n\nb").includes("</br>"));

console.log("\n【2】真实译文样本");
const sample = translationSample();
if (!sample) {
  skip("真实译文段落间距", "缺 fixture（或设 ZPT_CACHE 指向 translations.json）");
} else {
  const real = sample.text;
  const nSrc = (real.match(/\n/g) || []).length;
  const norm = real.replace(/\n{2,}/g, "\n\n");
  const nNorm = (norm.match(/\n/g) || []).length;
  const html = renderRichInText(doc, real);
  const nBr = countBr(html);
  const old = countBr(escapeHtmlOld(doc, real));
  console.log(`  来源 ${sample.from}`);
  console.log(`  ${real.length} 字符 / 原文 ${nSrc} 换行 → 规范化 ${nNorm} → 渲染 ${nBr} 个 <br>（旧写法 ${old} 个）`);
  ok("真实译文：<br> 数 == 规范化后的换行数", nBr === nNorm, `${nBr} vs ${nNorm}`);
  ok("真实译文：不再把换行翻倍", nBr < 2 * nSrc, `${nBr} vs 旧 ${2 * nSrc}`);
  ok("真实译文：没有 </br>", !html.includes("</br>"));
  ok("旧写法确实翻倍（测试有牙齿）", old === 2 * nSrc, `${old} vs ${2 * nSrc}`);
  ok("修复让 <br> 数减半", nBr * 2 === old, `新 ${nBr} / 旧 ${old}`);
  ok("真实译文：标题仍加粗", html.includes("zoteropdftranslate-heading"));
  ok("真实译文：公式仍走 KaTeX", html.includes("katex"));
  ok("真实译文：引用角标仍在", html.includes("zoteropdftranslate-cite"));
}

console.log("\n【3】组合场景（富文本 + 公式 + 引用 + 换行）");
const combo = "**实验部分**\n\n**2.1 材料。** 试剂 $H_2SO_4$ 为分析纯[21]。\n\n**2.2 表征。** 见 $N_2$ 吸附。";
const ch = renderRichInText(doc, combo);
ok("组合：2 处段落分隔 → 4 个 <br>", countBr(ch) === 4, `${countBr(ch)}`);
ok("组合：3 个标题都加粗", (ch.match(/zoteropdftranslate-heading/g) || []).length === 3);
ok("组合：KaTeX 渲染了两处公式", (ch.match(/class="katex"/g) || []).length >= 2);
ok("组合：引用 [21] 抬成上标", /data-cite="21"/.test(ch));

summary("段落间距");
