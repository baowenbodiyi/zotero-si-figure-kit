/**
 * 测试公共部分：路径解析 / 断言 / SKIP / 汇总。
 *
 * ⚠️ 这里**不写死任何本机路径**。所有输入都按「环境变量 → kit 内 fixture」的顺序找，
 * 找不到就 **SKIP 并说明原因**，绝不让"换台机器"变成一片红。
 *
 * 环境变量（都有默认值）：
 *   ZPT_SRC      打过补丁的插件源码树（含 src/utils/*.ts 与 node_modules）
 *   ZPT_BUILD    esbuild 产物放哪（默认 $TMPDIR/zpt-verify）
 *   ZPT_FIXTURES fixture 目录（默认 <kit>/tests/fixtures）
 *   ZPT_STORAGE  可选：Zotero 的 storage 目录（有真数据时用它跑"真机"分支）
 *   ZPT_SI_TEXT / ZPT_MAIN_TEXT / ZPT_CACHE  可选：直接指定真数据文件
 *   ZPT_WORDSI_DOCX 可选：name=path 分号分隔，额外的真 docx
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const KIT = path.resolve(__dirname, "..");

const env = {
  src: process.env.ZPT_SRC || path.join(KIT, "work", "translate"),
  build: process.env.ZPT_BUILD || path.join(os.tmpdir(), "zpt-verify"),
  fixtures: process.env.ZPT_FIXTURES || path.join(KIT, "tests", "fixtures"),
  storage: process.env.ZPT_STORAGE || "",
  siText: process.env.ZPT_SI_TEXT || "",
  mainText: process.env.ZPT_MAIN_TEXT || "",
  cache: process.env.ZPT_CACHE || "",
  wordsiDocx: process.env.ZPT_WORDSI_DOCX || "",
};

/** 载入 esbuild 产物；缺了就给一句人话，而不是 MODULE_NOT_FOUND 堆栈 */
function load(name) {
  const p = path.join(env.build, name + ".cjs");
  if (!fs.existsSync(p)) {
    console.error(`\n❌ 找不到构建产物 ${p}\n   先跑： bash scripts/verify_all.sh\n`);
    process.exit(2);
  }
  return require(p);
}

const results = [];
function ok(name, cond, extra) {
  results.push({ name, pass: !!cond, skip: false, extra });
  if (process.env.ZPT_QUIET) return;
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? "  " + extra : ""}`);
}
function skip(name, why) {
  results.push({ name, pass: false, skip: true, extra: why });
  if (process.env.ZPT_QUIET) return;
  console.log(`  ⏭️  SKIP ${name}  （${why}）`);
}

function fixture(name) {
  const p = path.join(env.fixtures, name);
  return fs.existsSync(p) ? p : null;
}
function readFixtureText(name) {
  const p = fixture(name);
  return p ? fs.readFileSync(p, "utf8") : null;
}

/** 真 SI 全文：优先环境变量，其次 fixture */
function siText() {
  for (const p of [env.siText, fixture("si_pages.txt")]) {
    if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return null;
}
function mainText() {
  for (const p of [env.mainText, fixture("main_text.txt")]) {
    if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return null;
}
/** 真译文样本（段落间距回归） */
function translationSample() {
  if (env.cache && fs.existsSync(env.cache)) {
    try {
      const d = JSON.parse(fs.readFileSync(env.cache, "utf8"));
      let best = null;
      for (const v of Object.values(d.entries || {})) {
        const r = v && v.r;
        if (typeof r === "string" && r.split("\n\n").length >= 3) {
          if (!best || r.length > best.length) best = r;
        }
      }
      if (best) return { text: best, from: env.cache };
    } catch {
      /* 落到 fixture */
    }
  }
  const p = fixture("translation_sample.json");
  if (p) {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    return { text: d.text, from: p };
  }
  return null;
}

function summary(title) {
  const pass = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass && !r.skip);
  const skipped = results.filter((r) => r.skip);
  console.log("");
  console.log(
    `${title}：通过 ${pass} / 失败 ${failed.length} / 跳过 ${skipped.length}`,
  );
  for (const f of failed) console.log(`  ✗ ${f.name}${f.extra ? "  " + f.extra : ""}`);
  for (const s of skipped) console.log(`  ⏭️  ${s.name}  （${s.extra}）`);
  if (failed.length) process.exit(1);
  return { pass, failed: failed.length, skipped: skipped.length };
}

module.exports = { KIT, env, load, ok, skip, fixture, readFixtureText,
                   siText, mainText, translationSample, summary, results };
