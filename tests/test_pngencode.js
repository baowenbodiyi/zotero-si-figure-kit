#!/usr/bin/env node
/**
 * PNG 编码器 / base64 / 降采样的离线验收（纯函数，不需要 Zotero，也不需要真 PDF）。
 *
 *   A. toBase64 ←→ Node Buffer.toString('base64')
 *   B. 合成 RGBA → encodePngRgba → data URL → 解回来，字节一致
 *   C. 产物交给 PIL 能打开、尺寸与像素一致（跨实现交叉验证，最关键的一条）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const K = require("./kit");
const { ok, skip, fixture, summary } = K;
const { toBase64, encodePngRgba, downscaleBox } = K.load("pngEncode");

/* ─────────── A. base64 ─────────── */
console.log("\n【A】base64 ←→ Buffer");
for (const len of [0, 1, 2, 3, 100000]) {
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = (i * 7 + 3) % 256;
  ok(`base64 len=${len}`, toBase64(new Uint8Array(buf)) === buf.toString("base64"));
}
{
  const rnd = Buffer.alloc(20000);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.random() * 256) | 0;
  ok("base64 随机 20000 字节", toBase64(new Uint8Array(rnd)) === rnd.toString("base64"));
}

/* ─────────── B. PNG 往返 ─────────── */
console.log("\n【B】encodePngRgba 往返");
const rgbaFile = fixture("fig_rgba.bin");
const metaFile = fixture("fig_rgba.meta.json");
if (!rgbaFile || !metaFile) {
  skip("PNG 编码往返", "缺 fixtures/fig_rgba.bin（跑 tests/gen_fixtures.py 生成）");
} else {
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const raw = new Uint8Array(fs.readFileSync(rgbaFile));
  ok(`fixture 尺寸对齐（${meta.w}x${meta.h}）`, raw.length === meta.w * meta.h * 4,
     `${raw.length} vs ${meta.w * meta.h * 4}`);
  const png = encodePngRgba(raw, meta.w, meta.h);
  const url = `data:image/png;base64,${toBase64(png)}`;
  const back = Buffer.from(url.split(",")[1], "base64");
  ok("data URL 往返后字节一致", Buffer.compare(Buffer.from(png), back) === 0,
     `${png.length} 字节, url ${url.length} 字符`);

  // 交给 PIL 验：能不能打开、像素是否一致
  const tmp = path.join(K.env.build, "roundtrip.png");
  fs.mkdirSync(K.env.build, { recursive: true });
  fs.writeFileSync(tmp, back);
  try {
    const out = execFileSync("python3", ["-c", `
import sys, hashlib
from PIL import Image
im = Image.open(sys.argv[1]); im.load()
print(im.size[0], im.size[1], hashlib.sha256(im.convert("RGBA").tobytes()).hexdigest())
`, tmp], { encoding: "utf8" }).trim().split(" ");
    const [w, h, sha] = out;
    const crypto = require("crypto");
    const wantSha = crypto.createHash("sha256").update(Buffer.from(raw)).digest("hex");
    ok("PIL 能打开自编 PNG", Number(w) === meta.w && Number(h) === meta.h, `${w}x${h}`);
    ok("PIL 解出的像素与输入 RGBA 一致", sha === wantSha, `${sha.slice(0, 16)}…`);
  } catch (e) {
    skip("PIL 交叉验证", "没有 python3+PIL（" + e.message.split("\n")[0] + "）");
  }

  /* ─────────── C. 降采样 ─────────── */
  console.log("\n【C】downscaleBox");
  const ds = downscaleBox(raw, meta.w, meta.h, 100);
  ok("降采样后宽度 <= 100", ds.w <= 100, `${ds.w}x${ds.h}`);
  ok("降采样后像素长度自洽", ds.rgba.length === ds.w * ds.h * 4);
  const small = encodePngRgba(ds.rgba, ds.w, ds.h);
  ok("降采样产物也能编码", small.length > 8 && small[0] === 0x89 && small[1] === 0x50,
     `${small.length} 字节`);
}

summary("PNG 编码");
