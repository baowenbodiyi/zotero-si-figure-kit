#!/usr/bin/env node
/**
 * Word 版支撑信息（.docx）整条链路的离线验收。
 *
 * 覆盖（每一层都对着**独立实现**的真值对拍，不是拿被测代码自证）：
 *   A. inflateRaw ←→ python zlib（raw deflate，含从 zip 抠出来的真压缩流）
 *   B. parseDocx  ←→ python zipfile + 正则
 *   C. findDocxFigure（图注→就近取图）←→ 独立 python 实现
 *   D. decodeTiff ←→ PIL（真 LZW + Predictor2 的 TIFF，对比 RGBA 的 sha256）
 *   E. lookupSiTargets 端到端（最小 Zotero 桩 + 真 .docx）
 *   F. debugLog 并发写不丢行
 *
 * 数据：kit 自带 fixture（含**真的** LZW-TIFF），不需要原作者那几篇论文。
 * 若有真数据，可用 ZPT_WORDSI_DOCX="名字=路径;名字=路径" 追加"真机"分支。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const K = require("./kit");
const { ok, skip, fixture, summary } = K;

const { inflateRaw } = K.load("inflate");
const { decodeTiff } = K.load("tiff");
const { parseDocx, findDocxFigure } = K.load("docx");
const { lookupSiTargets, parseSiRefs, siKind, findSiAttachment } = K.load("siRefs");
const { debugLog } = K.load("debugLog");

const stripAll = (s) => (s || "").replace(/\s+/g, "");
(async () => {
const sha256 = (b) => crypto.createHash("sha256").update(Buffer.from(b)).digest("hex");

/* ─────────── A. inflateRaw ←→ zlib ─────────── */
console.log("\n【A】inflateRaw ←→ python zlib");
const inflateJson = fixture("inflate.json");
if (!inflateJson) {
  skip("inflate 对拍", "缺 fixtures/inflate.json（跑 tests/gen_fixtures.py 生成）");
} else {
  const meta = JSON.parse(fs.readFileSync(inflateJson, "utf8"));
  for (const c of meta) {
    const comp = new Uint8Array(
      fs.readFileSync(path.join(K.env.fixtures, "inflate", c.name + ".in")),
    );
    const want = new Uint8Array(
      fs.readFileSync(path.join(K.env.fixtures, "inflate", c.name + ".out")),
    );
    let got = null;
    try {
      got = inflateRaw(comp, want.length);
    } catch (e) {
      ok(`inflate[${c.name}]`, false, `抛异常 ${e.message}`);
      continue;
    }
    const same =
      got.length === want.length && Buffer.compare(Buffer.from(got), Buffer.from(want)) === 0;
    ok(`inflate[${c.name}] ${c.raw}→${c.comp} 字节逐字节一致`, same,
       same ? "" : `长度 ${got.length} vs ${want.length}`);
  }
}

/* ─────────── 读 fixture 真值 ─────────── */
const docxPath = fixture("mini_si.docx");
const expPath = fixture("mini_si.expected.json");
let exp = null;
if (expPath) exp = JSON.parse(fs.readFileSync(expPath, "utf8"));

function checkDocx(label, docxFile, truth) {
  const bytes = new Uint8Array(fs.readFileSync(docxFile));
  let doc;
  try {
    doc = parseDocx(bytes);
  } catch (e) {
    ok(`parseDocx[${label}]`, false, `抛异常 ${e.message}`);
    return null;
  }
  ok(`parseDocx[${label}] 段落数 == 真值`, doc.paragraphs.length === truth.n_paras,
     `${doc.paragraphs.length} vs ${truth.n_paras}`);
  const media = [...doc.mediaPath.keys()].sort();
  ok(`parseDocx[${label}] 媒体表一致`,
     JSON.stringify(media) === JSON.stringify([...truth.media].sort()), media.join(","));

  // 段落文字（去空白后逐段比 —— 免得 tab/换行处理差异造成假失败）
  let bad = [];
  truth.paragraph_texts.forEach((t, i) => {
    const got = doc.paragraphs[i]?.text ?? "";
    if (stripAll(got) !== stripAll(t)) bad.push(`#${i}: ${JSON.stringify(got.slice(0, 40))}`);
  });
  ok(`parseDocx[${label}] 每段文字一致（${truth.n_paras} 段）`, bad.length === 0, bad.slice(0, 2).join(" | "));

  // 段落↔图 归属
  let imgBad = [];
  truth.paragraph_images.forEach((imgs, i) => {
    const got = doc.paragraphs[i]?.images ?? [];
    if (JSON.stringify(got) !== JSON.stringify(imgs)) imgBad.push(`#${i}: ${got} vs ${imgs}`);
  });
  ok(`parseDocx[${label}] 每段的图归属一致`, imgBad.length === 0, imgBad.slice(0, 2).join(" | "));
  return doc;
}

function checkFigureMapping(label, doc, truth) {
  let hit = 0;
  const miss = [];
  const caps = Object.entries(truth.captions).filter(([k]) => k.startsWith("figure"));
  for (const [key, t] of caps) {
    const [kind, num] = key.split(" ");
    const shown = `${kind[0].toUpperCase()}${kind.slice(1)} ${num.toUpperCase()}`;
    const got = findDocxFigure(doc, shown, shown);
    if (!got) { miss.push(`${shown} 没找到`); continue; }
    if (stripAll(got.caption) !== stripAll(t.caption)) { miss.push(`${shown} 图注不符`); continue; }
    if ((got.image || null) !== (t.image || null)) { miss.push(`${shown} 图=${got.image} 真值=${t.image}`); continue; }
    // ⭐ 表格也要比：Word 里的真表格没有 word/media 图片，是单独一条路
    const gt = got.table ? JSON.stringify(got.table) : null;
    const wt = t.table ? JSON.stringify(t.table) : null;
    if (gt !== wt) { miss.push(`${shown} 表格不符 got=${(gt || "null").slice(0, 40)} want=${(wt || "null").slice(0, 40)}`); continue; }
    hit++;
  }
  ok(`findDocxFigure[${label}] 图注→图 ${caps.length} 条`, hit === caps.length,
     `中 ${hit}/${caps.length}: ${miss.slice(0, 2).join(" | ")}`);
}

/* ─────────── B/C. fixture docx ─────────── */
console.log("\n【B/C】parseDocx / 图注→图（kit fixture，含真 LZW-TIFF）");
let fixtureDoc = null;
if (!docxPath || !exp) {
  skip("fixture docx 结构", "缺 fixtures/mini_si.docx 或 expected.json");
} else {
  console.log(`  fixture: ${path.basename(docxPath)}  ${fs.statSync(docxPath).size} 字节，` +
              `${exp.n_paras} 段 / ${exp.media.length} 图 / ${Object.keys(exp.captions).length} 图注`);
  fixtureDoc = checkDocx("fixture", docxPath, exp);
  if (fixtureDoc) checkFigureMapping("fixture", fixtureDoc, exp);
}

/* ─────────── 可选的"真机"分支 ─────────── */
console.log("\n【B'/C'】真 docx（可选）");
const realSpecs = K.env.wordsiDocx
  ? K.env.wordsiDocx.split(";").map((s) => s.split("=")).filter((a) => a.length === 2 && fs.existsSync(a[1]))
  : [];
if (!realSpecs.length) {
  skip("真 docx 结构", "未提供 ZPT_WORDSI_DOCX（不是失败：fixture 已覆盖同一代码路径）");
} else {
  for (const [name, p] of realSpecs) {
    // 真文件的"真值"现场用 python 算（PIL/pymupdf 可用时）
    console.log(`  ${name}: ${path.basename(p)}（真值需 tests/gen_fixtures.py 预先算，这里只验可解析性）`);
    const d = parseDocx(new Uint8Array(fs.readFileSync(p)));
    ok(`真 docx[${name}] 能解析出段落`, d.paragraphs.length > 0, `${d.paragraphs.length} 段`);
    ok(`真 docx[${name}] 能列出媒体`, d.mediaPath.size > 0, `${d.mediaPath.size} 个`);
  }
}

/* ─────────── C1b. 真 Word 表格（fixture 里那张） ─────────── */
console.log("\n【C1b】Word 里的**真表格**要能取出来");
{
  const doc3 = parseDocx(new Uint8Array(fs.readFileSync(fixture("mini_si.docx"))));
  const nTbl = doc3.paragraphs.filter((p) => p.table?.length).length;
  ok("parseDocx 认出表格块", nTbl === (exp.tables?.length ?? 0), `${nTbl} vs ${exp.tables?.length}`);
  const hit = findDocxFigure(doc3, "Table S2", "Table S2", "Tables?|Tabs?\\.?|表");
  ok("Table S2 配到的是**自己的**表格", !!hit?.table?.length, JSON.stringify(hit?.table ?? null).slice(0, 60));
  if (hit?.table?.length) {
    const flat = hit.table.map((r) => r.join("|")).join(" / ");
    ok("表格内容正确（含表头 Sample/Capacity）",
       flat.includes("Sample") && flat.includes("Capacity"), flat.slice(0, 80));
    // ⚠️ 单元格里多个段落必须保留换行 —— 否则化学方程式会粘成 "2H22NaOH"
    ok("单元格内的换行被保留（化学方程式那种）",
       hit.table.some((r) => r.some((c) => c.includes("\n"))),
       JSON.stringify(hit.table[1]?.[1] ?? null));
  }
  // ⚠️ 这条最关键：含下标的单元格**必须被判为需要富文本渲染**，
  //    否则面板用 textContent 会原样显示 "Na$_{2}$CO$_{3}$"（KaTeX 不被调用）—— 我自己踩过。
  {
    const mathCell = hit?.table?.flat().find((c) => c.includes("$"));
    if (mathCell) {
      const { needsRichRendering } = K.load("mathRenderer");
      ok("含 $...$ 的单元格会被判为需要 KaTeX 渲染",
         needsRichRendering(mathCell), JSON.stringify(mathCell.slice(0, 40)));
    }
  }
  ok("Table S1 没被 Table S2 抢走（各拿各的）",
     !(findDocxFigure(doc3, "Table S1", "Table S1", "Tables?|Tabs?\\.?|表")?.table),
     "S1 那段本来就没有表格 → 应 null");
}

/* ─────────── C2. 越位保护：没图的图注不许抢邻居的图 ─────────── */
console.log("\n【C2】越位保护（构造 fixture 时实测到的真问题）");
{
  const img = (d, lb) => (findDocxFigure(d, lb, lb) || {}).image;
  const blocked = {
    paragraphs: [
      { text: "", images: ["image1.tiff"] },
      { text: "Figure S1. Caption one.", images: [] },
      { text: "Figure S2. Caption two (no image).", images: [] },
      { text: "Figure S3. Caption three.", images: [] },
      { text: "", images: ["image2.tiff"] },
    ],
    mediaPath: new Map(), read: () => null,
  };
  ok("A: 没图的图注不抢邻居的图（Figure S2 → null）", img(blocked, "Figure S2") === null,
     String(img(blocked, "Figure S2")));
  ok("A: 上一段的图仍归自己（Figure S1 → image1.tiff）",
     img(blocked, "Figure S1") === "image1.tiff", String(img(blocked, "Figure S1")));
  ok("A: 隔一个图注的图不会被越位取走（Figure S3 → image2.tiff）",
     img(blocked, "Figure S3") === "image2.tiff", String(img(blocked, "Figure S3")));

  const gap = {
    paragraphs: [
      { text: "", images: ["image1.tiff"] },
      { text: "", images: [] },
      { text: "Figure S1. Caption one.", images: [] },
    ],
    mediaPath: new Map(), read: () => null,
  };
  ok("B: 图注与图之间夹一个空段时 ±2 仍可用（真数据里有 2 张这样排）",
     img(gap, "Figure S1") === "image1.tiff", String(img(gap, "Figure S1")));
}

/* ─────────── C3. 图注缩写写法 `Fig. S3`（实测真坑） ─────────── */
console.log("\n【C3】图注缩写 `Fig. Sx` 必须能匹配 `Figure Sx`");
{
  // 真实案例：某 SI 的图注全写成 "Fig. S3."，而正文引用被规范化为 "Figure S3"。
  // 只按字面量找 → 整篇 Figure 定位不到（113 段/19 图，Figure 全 miss，
  // 写全称的 Table S1 却能中 —— 差别就在这一个句点上）。
  const KW = { Figure: "Figures?|Figs?\\.?|图", Table: "Tables?|Tabs?\\.?|表" };
  const doc2 = {
    paragraphs: [
      { text: "", images: ["a.png"] },
      { text: "Fig. S1. XRD image of the sample.", images: [] },
      { text: "", images: ["c.png"] },
      { text: "Fig. S3. (a,b) SEM images.", images: [] },
      { text: "", images: ["e.png"] },
      { text: "Fig S5 The lattice spacing profile.", images: [] },
      { text: "", images: ["g.png"] },
      { text: "Figures S7. Cycle stability.", images: [] },
      { text: "Table S1. Elemental content ratios.", images: [] },
    ],
    mediaPath: new Map(), read: () => null,
  };
  const f = (lb) => findDocxFigure(doc2, lb, lb, KW[lb.split(" ")[0]]) || {};
  ok("`Fig. S1.` → 配到图", f("Figure S1").image === "a.png", String(f("Figure S1").image));
  ok("`Fig. S3.` → 配到图", f("Figure S3").image === "c.png", String(f("Figure S3").image));
  ok("`Fig S5`（无句点）→ 配到图", f("Figure S5").image === "e.png", String(f("Figure S5").image));
  ok("`Figures S7.`（复数）→ 配到图", f("Figure S7").image === "g.png", String(f("Figure S7").image));
  ok("`Table S1.`（全称）仍能中", f("Table S1").caption.includes("Elemental"), f("Table S1").caption);
  const noFP = { paragraphs: [{ text: "", images: [] }, { text: "Fig. S30. Other.", images: ["x.png"] }],
                 mediaPath: new Map(), read: () => null };
  ok("防误判：Figure S3 不会匹配到 `Fig. S30`",
     (findDocxFigure(noFP, "Figure S3", "Figure S3", KW.Figure) || {}).image == null);
  // 不传 kindPattern 时也要能中（docx.ts 里的兜底默认）
  ok("不传类别词变体也能中（内置兜底）",
     (findDocxFigure(doc2, "Figure S3", "Figure S3") || {}).image === "c.png");
}

/* ─────────── D. decodeTiff ←→ PIL ─────────── */
console.log("\n【D】decodeTiff ←→ PIL（RGBA sha256）");
if (!fixtureDoc || !exp.tiff) {
  skip("TIFF 解码对拍", "缺 fixture");
} else {
  for (const [media, t] of Object.entries(exp.tiff)) {
    const rel = fixtureDoc.mediaPath.get(media);
    const raw = rel ? fixtureDoc.read(rel) : null;
    if (!raw) { ok(`decodeTiff[${media}] 取字节`, false, "读不到媒体"); continue; }
    let img;
    try {
      img = decodeTiff(raw);
    } catch (e) {
      ok(`decodeTiff[${media}]`, false, `抛异常 ${e.message}`);
      continue;
    }
    ok(`decodeTiff[${media}] 尺寸 ${t.w}x${t.h}`,
       img.width === t.w && img.height === t.h, `${img.width}x${img.height}`);
    const h = sha256(img.rgba);
    ok(`decodeTiff[${media}] RGBA 与 PIL 逐字节一致（sha256）`,
       h === t.rgba_sha256, `${h.slice(0, 16)}… vs ${t.rgba_sha256.slice(0, 16)}…`);
    console.log(`     TIFF: 压缩=${t.compression} predictor=${t.predictor} ` +
                `photometric=${t.photometric} spp=${t.spp} / RGBA ${t.rgba_bytes} 字节`);
  }
}

/* ─────────── E. lookupSiTargets 端到端（最小 Zotero 桩） ─────────── */
console.log("\n【E】lookupSiTargets 端到端（真 .docx + Zotero 桩）");
if (!docxPath) {
  skip("lookupSiTargets 集成", "缺 fixture docx");
} else {
  const DOCX_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const CASES = [
    {
      label: "docx",
      contentType: DOCX_TYPE,
      tab: "storage:Mini SI - 1-s2.0-XXXX-mmc1.docx",
      refs: "Shown in Figure S1, Figure S1b, Figure S2 and Table S1.",
      want: {
        "Figure S1": { kind: "word", media: "image1.tiff", caption: true },
        "Figure S1b": { kind: "word", media: "image1.tiff", caption: true }, // 子图回退到基号
        "Figure S2": { kind: "word", media: null, caption: true },          // 只有图注、没有图
        "Table S1": { kind: "word", media: null, caption: true },
      },
    },
    {
      // 老二进制 .doc：不是 zip → 取不了图，但**不能**报成"没有对应图片"
      label: "doc",
      contentType: "application/msword",
      tab: "storage:Mini SI - supporting information.doc",
      refs: "Shown in Figure S1.",
      want: { "Figure S1": { kind: "doc", media: null, caption: false } },
    },
  ];

  let baseId = 900;
  for (const c of CASES) {
    baseId += 100;
    const ID_PARENT = baseId, ID_MAIN = baseId + 1, ID_SI = baseId + 2;
    const siTitle = `[SI] ${c.tab.replace(/^storage:/, "")}`;
    const si = {
      id: ID_SI, key: "SIKEY",
      isAttachment: () => true, isRegularItem: () => false,
      attachmentContentType: c.contentType,
      attachmentFilename: siTitle.replace(/^\[SI\] /, ""),
      attachmentPath: c.tab,
      getField: (f) => (f === "title" ? siTitle : ""),
      getTags: () => [],
      getFilePathAsync: async () => docxPath,
      parentItem: null,
    };
    const main = {
      id: ID_MAIN, key: "MAINKEY",
      isAttachment: () => true, isRegularItem: () => false,
      attachmentContentType: "application/pdf",
      attachmentFilename: "paper.pdf", attachmentPath: "storage:paper.pdf",
      getField: () => "PDF", getTags: () => [],
      getFilePathAsync: async () => docxPath,
      parentItem: null,
    };
    const parent = { id: ID_PARENT, isAttachment: () => false, isRegularItem: () => true,
                     getAttachments: () => [ID_MAIN, ID_SI] };
    main.parentItem = parent;
    si.parentItem = parent;
    globalThis.Zotero = {
      Items: { get: (id) => ({ [ID_PARENT]: parent, [ID_MAIN]: main, [ID_SI]: si })[id] || null },
    };
    globalThis.IOUtils = { read: async (p) => new Uint8Array(fs.readFileSync(p)) };

    // ⚠️ 每个用例必须用**不同 id**：getSiDocx 按附件 id 缓存，撞了就会拿到上一个用例的 docx
    ok(`findSiAttachment[${c.label}] 挑中 SI`, findSiAttachment(ID_MAIN)?.id === ID_SI,
       String(findSiAttachment(ID_MAIN)?.id));
    ok(`siKind[${c.label}]`, siKind(si) === c.want[Object.keys(c.want)[0]].kind ||
       siKind(si) === (c.label === "doc" ? "doc" : "word"), siKind(si));

    const refs = parseSiRefs(c.refs);
    const targets = await lookupSiTargets(refs, ID_MAIN);
    ok(`lookupSiTargets[${c.label}] 条数 == 引用数`, targets.length === refs.length,
       `${targets.length} vs ${refs.length}`);
    for (const t of targets) {
      const w = c.want[t.ref.label];
      if (!w) { ok(`target[${c.label}] ${t.ref.label} 出现在期望表里`, false); continue; }
      ok(`target[${c.label}] ${t.ref.label} kind=${w.kind}`, t.kind === w.kind, t.kind);
      ok(`target[${c.label}] ${t.ref.label} media=${w.media}`,
         (t.media || null) === w.media, String(t.media));
      ok(`target[${c.label}] ${t.ref.label} ${w.caption ? "有" : "无"}图注`,
         w.caption ? t.caption.length > 0 : t.caption === "", JSON.stringify(t.caption.slice(0, 40)));
    }
  }
}

/* ─────────── F. debugLog 串行化 ─────────── */
console.log("\n【F】debugLog 并发写不丢行");
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(80); // 让前面 `void debugLog(...)` 的尾巴落空（那会儿还没装桩）
  let store = "", inflight = 0, maxInflight = 0;
  const touch = async () => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await sleep(1); inflight--;
  };
  globalThis.Zotero = {
    DataDirectory: { dir: path.join(require("os").tmpdir(), "zpt-fake-data") },
    File: {
      getContentsAsync: async () => { await touch(); return store; },
      putContentsAsync: async (_p, s) => { await touch(); store = s; },
    },
  };
  const N = 40;
  await Promise.all(Array.from({ length: N }, (_, i) => debugLog("t", `line-${i}`)));
  const lines = store.trim().split("\n");
  ok(`debugLog ${N} 条并发全部落盘`, lines.length === N, `只剩 ${lines.length} 行`);
  ok("debugLog 写入不重叠（峰值并发=1）", maxInflight === 1, `峰值 ${maxInflight}`);
  ok("debugLog 保持调用顺序", lines.every((l, i) => l.endsWith(`line-${i}`)));
}

summary("Word SI 链路");
})();
