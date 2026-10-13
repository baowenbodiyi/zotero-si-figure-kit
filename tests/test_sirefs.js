#!/usr/bin/env node
/**
 * SI 引用解析 / 图注定位 / 附件挑选 的验收。
 *
 * 数据来源分两层，且**都会自动降级**：
 *   1. 环境变量指定的真数据（ZPT_SI_TEXT / ZPT_MAIN_TEXT / ZPT_STORAGE）
 *   2. kit 自带的 fixture（tests/fixtures/si_pages.txt、main_text.txt）
 * 都没有 → 相关小节 **SKIP 并说明**，不是失败。
 *
 * 第【1】【3】节是纯逻辑（内联句子 + 桩对象），任何机器上都能跑。
 */
"use strict";

const K = require("./kit");
const { ok, skip, summary } = K;
const { parseSiRefs, findCaptionPage, findSiAttachment, lookupSiTargets } = K.load("siRefs");

const check = ok; // 与原测试同名，语义一致

const siText = K.siText();
const mainText = K.mainText();
const siPages = siText ? siText.split("\f") : null;
const HAVE_SI = !!siPages;
const HAVE_MAIN = !!mainText;

// ---------- 独立算真值：图注在第几页（不依赖被测代码） ----------
const truth = {};
if (HAVE_SI) {
  for (let i = 0; i < siPages.length; i++) {
    for (const m of siPages[i].matchAll(
      /(?:^|\n)[ \t]*((?:Figure|Fig\.?|Table|Scheme)[ \t]*S[ \t]*\d+[a-z]?)\b/g,
    )) {
      const label = m[1]
        .replace(/[ \t]+/g, " ")
        // ⚠️ 必须用 \b：写成 /^Fig\.?/ 会把 "Figure" 也吃成 "Figureure"
        .replace(/^Fig\b\.?/, "Figure");
      if (!(label in truth)) truth[label] = i;
    }
  }
  console.log("=".repeat(72));
  console.log(`真值（从 SI 全文独立扫出的图注页码，0-based；共 ${siPages.length} 页）`);
  console.log("  " + JSON.stringify(truth));
  console.log("=".repeat(72));
}

// ---------- 1. parseSiRefs：句子级（纯逻辑） ----------
console.log("\n【1】parseSiRefs —— 引用识别（内联句子，无需真数据）");
const sentences = [
  "The energetic and adsorptive performance was compared with 15% CO2/85% N2 at 1 V (Figure 2 and Table S1).",
  "Assuming integrals as shown in Figure S1b and S1c, the ratio of moles of CO2 adsorbed to desorbed is between 1.",
  "Sequentially charging and discharging resulted in reproducible behaviour (Figure S1a).",
  "The influence of oxygen was further investigated with 3 M MgCl2 (Figure 4 and Figure S3).",
  "To reduce the energy consumption, additional experiments were performed (Figure S3c–d).",
  "The charging curve deviated from the capacitive behavior (Figure S5a).",
  "The data is extracted from Figure S6b by using different voltage hold times.",
  "See Table S4 and Fig. S2 for details.",
  "比较了 Figure S1 与 Figure S2 的结果。",
  "如图 S3 所示，表 S2 列出了参数。",
];
for (const s of sentences) {
  console.log(`  · ${JSON.stringify(parseSiRefs(s).map((r) => r.label))}  ← ${s.slice(0, 62)}…`);
}
const label = (s) => parseSiRefs(s).map((r) => r.label);
check("「Figure 2 and Table S1」只出 Table S1，不出 Figure 2",
      (() => { const r = label(sentences[0]); return r.length === 1 && r[0] === "Table S1"; })(),
      JSON.stringify(label(sentences[0])));
check("「Figure S1b and S1c」→ 只出 Figure S1b（S1c 没有类别词，不算）",
      (() => { const r = label(sentences[1]); return r.length === 1 && r[0] === "Figure S1b"; })(),
      JSON.stringify(label(sentences[1])));
check("「Figure S1a」→ Figure S1a", label(sentences[2])[0] === "Figure S1a");
check("「Figure S6b」→ Figure S6b", label(sentences[6])[0] === "Figure S6b");
check("「Table S4 and Fig. S2」→ Table S4 + Figure S2（Fig. 归一化）",
      label(sentences[7]).join("|") === "Table S4|Figure S2", JSON.stringify(label(sentences[7])));
check("中文「Figure S1 与 Figure S2」→ 两条",
      label(sentences[8]).join("|") === "Figure S1|Figure S2");
check("中文「如图 S3…表 S2」→ Figure S3 + Table S2",
      label(sentences[9]).join("|") === "Figure S3|Table S2", JSON.stringify(label(sentences[9])));
check("不含 S 的普通图号（Figure 1 / Figure 10）一条都不出",
      label("Figure 1 shows the cell and Figure 10 the spectra.").length === 0);
check("去重：重复三次只出一条",
      label("See Figure S1, Figure S1, and Figure S1.").length === 1);

// ---------- 2. findCaptionPage：图注定位（需要 SI 全文） ----------
console.log("\n【2】findCaptionPage —— 图注落在第几页");
if (!HAVE_SI) {
  skip("findCaptionPage 系列", "缺 SI 全文（设 ZPT_SI_TEXT 或提供 fixtures/si_pages.txt）");
} else {
  const labels = [
    "Figure S1", "Figure S2", "Figure S3", "Figure S4", "Figure S5",
    "Figure S6", "Figure S7", "Figure S8", "Figure S9", "Figure S10",
    "Table S1", "Table S2", "Table S3", "Table S4", "Table S5", "Table S6",
  ];
  let allOk = true;
  for (const lb of labels) {
    const hit = findCaptionPage(siPages, parseSiRefs(`${lb}.`)[0]);
    const exp = truth[lb];
    const good = hit && hit.pageIndex === exp;
    if (!good) allOk = false;
    console.log(`  ${good ? "✅" : "❌"} ${lb.padEnd(11)} → 第 ${hit ? hit.pageIndex + 1 : "?"} 页` +
                ` (真值 第 ${exp + 1} 页)  ${hit ? JSON.stringify(hit.caption.slice(0, 52)) : "无"}`);
  }
  check(`${labels.length} 条内置图注全部定位到正确的页`, allOk);

  console.log("\n  —— 子图与回退 ——");
  const s6b = parseSiRefs("Figure S6b.")[0];
  const h6b = findCaptionPage(siPages, s6b);
  check("「Figure S6b」没有独立图注 → 回退到 Figure S6 那一页",
        h6b && h6b.pageIndex === truth["Figure S6"],
        `得到第 ${h6b ? h6b.pageIndex + 1 : "?"} 页（S6 在第 ${truth["Figure S6"] + 1} 页）`);
  check("不存在的 Figure S99 → null（不乱指一页）",
        findCaptionPage(siPages, parseSiRefs("Figure S99.")[0]) === null);

  console.log("\n  —— 行内引用不得冒充图注（实测坑）——");
  check("Table S4 说明里那句行内 “extracted from Figure S6b” 没把 S6b 定到 Table S4 那页",
        findCaptionPage(siPages, s6b).pageIndex !== truth["Table S4"],
        `Table S4 在第 ${truth["Table S4"] + 1} 页，S6b 得到第 ${findCaptionPage(siPages, s6b).pageIndex + 1} 页`);
}

// ---------- 3. findSiAttachment：附件挑选（纯桩） ----------
console.log("\n【3】findSiAttachment —— 从附件里挑出 SI");
function mkItem(o) {
  return {
    id: o.id,
    isAttachment: () => true,
    isRegularItem: () => false,
    attachmentContentType: o.contentType || "application/pdf",
    attachmentPath: o.path,
    parentItem: null,
    getAttachments: () => [],
    getField: (f) => (f === "title" ? o.title : ""),
    getTags: () => o.tags || [],
    get attachmentText() { return Promise.resolve(o.text || ""); },
  };
}
const parent = { id: 100, isAttachment: () => false, isRegularItem: () => true,
                 getAttachments: () => [101, 102] };
const mainItem = mkItem({ id: 101, title: "Paper.pdf", path: "storage:Paper.pdf" });
const siItem = mkItem({
  id: 102,
  title: "[SI] Paper - supporting information.pdf",
  path: "storage:[SI] Paper - supporting information.pdf",
  tags: [{ tag: "SI" }],
  // ⚠️ 必须把 SI 全文喂给桩：getSiPages 读的是附件索引出来的全文。
  //    少了这一行，第【4】节会全部落到 "SI 里没找到"，看起来像功能坏了。
  text: HAVE_SI ? siPages.join("\f") : "",
});
mainItem.parentItem = parent;
siItem.parentItem = parent;
globalThis.Zotero = { Items: { get: (id) => ({ 100: parent, 101: mainItem, 102: siItem })[id] || null } };

check("给定主 PDF(101) → 挑出 SI(102)", findSiAttachment(101)?.id === 102,
      String(findSiAttachment(101)?.id));

const soloParent = { id: 200, isAttachment: () => false, isRegularItem: () => true,
                     getAttachments: () => [201] };
const soloMain = mkItem({ id: 201, title: "Some paper.pdf", path: "storage:Some paper.pdf" });
soloMain.parentItem = soloParent;
globalThis.Zotero.Items.get = (id) =>
  ({ 100: parent, 101: mainItem, 102: siItem, 200: soloParent, 201: soloMain })[id] || null;
check("这篇没有 SI → null（不硬塞一个附件给用户）", findSiAttachment(201) === null);

const p3 = { id: 300, isAttachment: () => false, isRegularItem: () => true,
             getAttachments: () => [301, 302, 303] };
const n1 = mkItem({ id: 301, title: "Paper.pdf", path: "storage:Paper.pdf" });
const n2 = mkItem({ id: 302, title: "graphical abstract.pdf", path: "storage:graphical abstract.pdf" });
const n3 = mkItem({ id: 303, title: "[SI] Paper - supporting information.pdf",
                    path: "storage:[SI] Paper - supporting information.pdf", tags: [{ tag: "SI" }] });
[n1, n2, n3].forEach((x) => (x.parentItem = p3));
globalThis.Zotero.Items.get = (id) => ({ 301: n1, 302: n2, 303: n3, 300: p3 })[id] || null;
check("三个候选里挑中带 [SI] 的那个", findSiAttachment(301)?.id === 303);

// ---------- 4/5. 端到端 + 图注抽取（需要 SI 全文 + 正文） ----------
(async () => {
  console.log("\n【4】lookupSiTargets —— 正文句 → SI 页码（端到端）");
  if (!HAVE_SI || !HAVE_MAIN) {
    skip("lookupSiTargets 端到端", "缺 SI 或正文全文（fixture 未提供时正常）");
    summary("SI 定位");
    return;
  }
  globalThis.Zotero.Items.get = (id) =>
    ({ 100: parent, 101: mainItem, 102: siItem })[id] || null;

  // 每个**不同图号**只取第一句，否则前几句全是同一个号，等于没抽样
  const seen = new Set();
  const real = [];
  for (const s of mainText.replace(/\n/g, " ").split(/(?<=[.!?])\s+/)) {
    if (!/(Figure|Table|Scheme)\s*S\d/.test(s)) continue;
    const key = parseSiRefs(s).map((r) => r.label).join(",");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    real.push(s);
  }
  console.log(`  （从正文取到 ${real.length} 组互不相同的 SI 引用）`);
  const expectedPage = (lb) => {
    if (lb in truth) return truth[lb];
    const base = lb.replace(/(\d+)[a-z]$/, "$1");
    return base in truth ? truth[base] : undefined;
  };
  for (const s of real) {
    const targets = await lookupSiTargets(parseSiRefs(s), 101);
    console.log(`  正文: ${s.trim().slice(0, 92)}…`);
    for (const t of targets) {
      const exp = expectedPage(t.ref.label);
      ok(`${t.ref.label} → SI 第 ${t.pageIndex === null ? "?" : t.pageIndex + 1} 页（真值 第 ${exp + 1} 页）`,
         t.pageIndex !== null && t.pageIndex === exp,
         JSON.stringify(t.caption.slice(0, 48)));
    }
  }

  console.log("\n【5】extractCaption —— 图注不能截断、不能吞表格数据");
  const allLabels = [
    "Figure S1", "Figure S2", "Figure S3", "Figure S4", "Figure S5", "Figure S6",
    "Figure S7", "Figure S8", "Figure S9", "Figure S10",
    "Table S1", "Table S2", "Table S3", "Table S4", "Table S5", "Table S6",
  ];
  let trunc = 0, tableData = 0;
  for (const lb of allLabels) {
    const hit = findCaptionPage(siPages, parseSiRefs(`${lb}.`)[0]);
    if (!hit) { ok(`${lb} 定位到图注`, false); continue; }
    const c = hit.caption;
    const isTrunc = c.endsWith("…");
    // 末尾若出现三个连续数字，基本就是吞了表格数据行
    const hasTableData = /\d+(\.\d+)?\s+\d+(\.\d+)?\s+\d+(\.\d+)?/.test(c.slice(-120));
    if (isTrunc) trunc++;
    if (hasTableData) tableData++;
    ok(`${lb} 图注未截断且不吞表格数据`, !isTrunc && !hasTableData,
       `${String(c.length).padStart(4)} 字符  …${c.slice(-50)}`);
  }
  check("没有任何图注被截断（不含省略号）", trunc === 0, `截断 ${trunc} 条`);
  check("没有任何图注吞进表格数据", tableData === 0, `可疑 ${tableData} 条`);
  check("Table S4 收尾在 '…different voltage hold times.'",
        (findCaptionPage(siPages, parseSiRefs("Table S4.")[0]).caption || "").endsWith("hold times."));
  check("Table S6（图注无句号）只取首行，不含表头 'Method Description'",
        !/Method Description/.test(findCaptionPage(siPages, parseSiRefs("Table S6.")[0]).caption || ""));

  summary("SI 定位");
})();
