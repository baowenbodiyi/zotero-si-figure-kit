#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成**可移植 fixture**：让这套补丁在任何机器上都能被离线验证，
而不需要"我本机那两篇论文的 SI"。

为什么要这个：原来的测试直接读**作者本机**的 `<数据目录>/storage/<key>/...`，
换台机器必然全挂 —— 那样交出去的就不是"能复刻"，只是"能看"。

产物（全部落在 fixtures/）：
  mini_si.docx           一个**结构真实**的小 .docx：图注+图，含**真的 LZW-TIFF**
  mini_si.expected.json  独立（zipfile+PIL）算出的真值：段落数 / 图注→图 / TIFF 的 RGBA 哈希
  si_pages.txt           真实 SI 全文（\\f 分页），给图注定位用
  main_text.txt          真实正文全文，给端到端用
  translation_sample.json 真实译文样本（段落间距回归用）
  fig_rgba.bin           合成 RGBA（PNG 编码器回归用，不依赖任何真数据）

用法（在"有真数据"的机器上重新生成时）：
  python3 gen_fixtures.py \
      --real-docx  /path/to/xxx-mmc1.docx \
      --si-text    /path/to/storage/<key>/.zotero-ft-cache \
      --main-text  /path/to/storage/<key>/.zotero-ft-cache \
      --cache      /path/to/storage/<key>/translations.json \
      --out fixtures
已存在的 fixture 不会被覆盖，除非加 --force。
"""
import argparse
import hashlib
import io
import json
import os
import re
import struct
import zipfile

from PIL import Image

# ─────────────────────────── 小 .docx 的构造

DOC_XML_HEAD = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    "<w:body>"
)

RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
    'Target="media/image1.tiff"/></Relationships>'
)

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Default Extension="tiff" ContentType="image/tiff"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    "</Types>"
)

ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/></Relationships>'
)


def para(*runs):
    """一个 <w:p>；每个 run 是一段 <w:t> 文本"""
    body = "".join(
        f'<w:r><w:t xml:space="preserve">{t}</w:t></w:r>' for t in runs
    )
    return f"<w:p>{body}</w:p>"


def para_image(rid="rId1"):
    """只有一张图的段落（图独占一段 —— 实测就是这个结构）"""
    return (
        "<w:p><w:r><w:drawing><wp:inline>"
        f'<a:graphic><a:graphicData><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        f'<pic:blipFill><a:blip r:embed="{rid}"/></pic:blipFill>'
        "</pic:pic></a:graphicData></a:graphic>"
        "</wp:inline></w:drawing></w:r></w:p>"
    )


def para_multi(*runs):
    """一个 <w:p>；runs 是多个 <w:r>（用来测 run 拼接）"""
    return para(*runs)


def run_script(text, script=None):
    """一个 <w:r>；script 给 'subscript'/'superscript' 时带 <w:vertAlign>"""
    va = f'<w:vertAlign w:val="{script}"/>' if script else ""
    return f'<w:r><w:rPr>{va}</w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>'


def table_xml(rows):
    """造一个真 Word 表格 <w:tbl>。

    ⚠️ 两个刻意的坑都放在这里（实测 Word 表格就是这样）：
      1. 某个单元格里放**多个段落** —— 化学方程式一个反应一行；
         拼成一串会变成 "2H22NaOH" 那种粘连，必须按段落保留换行。
      2. 某个单元格里放**下标 run** —— `Na2CO3` 的 `2` 是
         `<w:vertAlign w:val="subscript"/>`；只拼 <w:t> 会得到 "Na2CO3"（化学式就错了）。
    单元格可以给：
      · 字符串（按 \n 拆成多段）
      · [(文本, 上下标 or None), ...] 列表 → 一个段落里的多个 run
    """
    out = ["<w:tbl>"]
    for row in rows:
        out.append("<w:tr>")
        for cell in row:
            out.append("<w:tc>")
            if isinstance(cell, list):
                out.append("<w:p>" + "".join(run_script(t, sc) for t, sc in cell) + "</w:p>")
            else:
                for line in str(cell).split("\n"):
                    out.append(para(line))
            out.append("</w:tc>")
        out.append("</w:tr>")
    out.append("</w:tbl>")
    return "".join(out)


def build_docx(image_bytes):
    """
    刻意构造几个**实测会遇到的形态**：
      · 图独占一段，图注在紧邻的下一段（Elsevier 的常见排法）
      · 图注的 "Figure S1" 被 Word 拆成多个 run（`Figure S` + `1` + `. (a) …`）
        —— 拼错就会变成 "Figure S 1 ."，正则匹配不到
      · 一条**没有图**的图注（真 Word 表格）→ 必须只给图注、不假装有图
      · 一条**子图**引用 S1b → 要能回退到 S1 那张
    """
    parts = [
        para("Supporting Information"),
        para("Mini fixture for the SI figure pipeline (real LZW TIFF)."),
        para_image("rId1"),
        # ⚠️ 故意拆 run：测「按 run 拼接」而不是按 XML 标签截断
        para("Figure S", "1", ". (a) TEM image and (b) cycling stability of the sample. ",
             "The scale bar is 2 um."),
        para("Figure S2. Replotted galvanostatic profiles (no image in this fixture)."),
        para("Table S", "1", ": Comparison of the investigated materials with reported data."),
        # ⭐ 真 Word 表格（不是图片）：实测这类表格在 .docx 里是 <w:tbl>，
        #    里面**没有 word/media**，只找图片的话永远显示不出来
        para("Table S2. Etching reaction between carbon and NaOH."),
        table_xml([
            ["Sample", "Capacity (mAh g-1)"],
            ["HC-1200", "317\n400"],
            # 多 run + 下标：期望真值里应变成 Na$_{2}$CO$_{3}$
            [[("Na", None), ("2", "subscript"), ("CO", None), ("3", "subscript")],
             "with 0.42 cm3 g-1"],
        ]),
    ]
    doc = DOC_XML_HEAD + "".join(parts) + "</w:body></w:document>"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr("word/document.xml", doc)
        z.writestr("word/_rels/document.xml.rels", RELS_XML)
        # 图**不压缩**存进去 —— 与真实 SI 一致（实测 compress_type=0）
        zi = zipfile.ZipInfo("word/media/image1.tiff")
        zi.compress_type = zipfile.ZIP_STORED
        zi.date_time = (2024, 1, 1, 0, 0, 0)
        z.writestr(zi, image_bytes)
    return buf.getvalue()


# ─────────────────────────── 独立真值（不碰被测代码）

LABEL = r"(Figures?|Figs?\.?|Tables?|Tabs?\.?|Schemes?|Charts?)"
# 段首就是图注标签（用来判断"能不能跳过这一段去取距离 2 的图"）
CAP_START = re.compile(
    r"^\s*(?:Figures?|Figs?\.?|Tables?|Tabs?\.?|Schemes?|Charts?|Equations?|Eqs?\.?)\s*S\s*\d",
    re.I,
)


def docx_truth(path):
    """独立真值：**块模型**（段落 / 表格），与 JS 侧 parseDocx 的模型一致。

    ⚠️ 这里踩过一次：最初真值用「按 <w:p 切」的老办法，表格单元格会被切成很多散段落，
       而 JS 改成块模型后表格只算 1 个块 → 段落数对不上，测试误报。
       **真值必须和被测模型同构**，但计算过程要独立实现。
    """
    z = zipfile.ZipFile(path)
    doc = z.read("word/document.xml").decode("utf8", "replace")
    rels = z.read("word/_rels/document.xml.rels").decode("utf8", "replace")
    rid2f = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="(?:\.\./)?media/([^"]+)"', rels))

    def esc_math(x):
        return re.sub(r"([\\{}$%#&_^~])", r"\\\1", x)

    def para_text_scripts(pp):
        """一个 <w:p> → 文字，**保留上下标**（`Na2CO3` 的 2 是 <w:vertAlign>）"""
        out = ""
        for run in re.findall(r"<w:r(?:\s[^>]*)?>[\s\S]*?</w:r>", pp):
            t = "".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", run, re.S))
            for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&amp;", "&")):
                t = t.replace(a, b)
            if not t:
                continue
            va = re.search(r'<w:vertAlign\s+w:val="(subscript|superscript)"\s*/>', run)
            if va:
                mark = "_" if va.group(1) == "subscript" else "^"
                lead = re.match(r"^\s*", t).group(0)
                trail = re.search(r"\s*$", t).group(0)
                core = t.strip()
                out += f"{lead}${mark}{{{esc_math(core)}}}${trail}" if core else t
            else:
                out += t
        return re.sub(r"[ \t]+", " ", out).strip()

    def cell_lines(tc):
        lines = []
        for pp in re.findall(r"<w:p(?:\s[^>]*)?>[\s\S]*?(?=<w:p(?:\s[^>]*)?>|</w:tc>)", tc):
            t = para_text_scripts(pp)
            if t:
                lines.append(t)
        return "\n".join(lines)

    blocks = []          # ("p", text, images) | ("tbl", rows, [])
    for m in re.finditer(
        r"<w:tbl>[\s\S]*?</w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?(?=<w:tbl>|<w:p(?:\s[^>]*)?>|</w:body>)",
        doc,
    ):
        chunk = m.group(0)
        if chunk.startswith("<w:tbl>"):
            rows = []
            for tr in re.findall(r"<w:tr[\s>][\s\S]*?</w:tr>", chunk):
                cells = [cell_lines(tc)
                         for tc in re.findall(r"<w:tc(?:\s[^>]*)?>[\s\S]*?</w:tc>", tr)]
                if cells:
                    rows.append(cells)
            blocks.append(("tbl", rows, []))
        else:
            t = "".join(re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", chunk, re.S))
            for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&amp;", "&")):
                t = t.replace(a, b)
            imgs = [rid2f[x] for x in re.findall(r'r:embed="(rId\d+)"', chunk) if x in rid2f]
            blocks.append(("p", re.sub(r"\s+", " ", t).strip(), imgs))

    # 段落视图（表格算 1 个块，images 为空、table 有内容）—— 与 JS 一致
    paras = []
    for kind, payload, imgs in blocks:
        if kind == "tbl":
            paras.append({"text": re.sub(r"\s+", " ", " ".join(" ".join(r) for r in payload)).strip(),
                          "images": [], "table": payload})
        else:
            paras.append({"text": payload, "images": imgs, "table": None})

    def is_cap(t):
        return bool(re.match(r"^\s*" + LABEL + r"\s*S\s*\d", t, re.I))

    def nearby_table(i):
        """先后再前，遇到图注就停"""
        for j in range(i + 1, len(paras)):
            if is_cap(paras[j]["text"]):
                break
            if paras[j]["table"]:
                return paras[j]["table"]
        for j in range(i - 1, -1, -1):
            if is_cap(paras[j]["text"]):
                break
            if paras[j]["table"]:
                return paras[j]["table"]
        return None

    caps = {}
    for i, p in enumerate(paras):
        m = re.match(r"^\s*" + LABEL + r"\s*S\s*(\d{1,3}[a-z]?)\b", p["text"], re.I)
        if not m:
            continue
        # 图：±1 优先，距离 2 需中间段不是图注（与 JS 同规则）
        order = [i - 1, i + 1, i]
        if not (0 <= i - 1 < len(paras) and is_cap(paras[i - 1]["text"])):
            order.append(i - 2)
        if not (0 <= i + 1 < len(paras) and is_cap(paras[i + 1]["text"])):
            order.append(i + 2)
        img = None
        for j in order:
            if 0 <= j < len(paras) and paras[j]["images"]:
                img = paras[j]["images"][0]
                break
        caps.setdefault(
            f"{m.group(1)} S{m.group(2)}".lower(),
            {"index": i, "caption": p["text"], "image": img,
             "table": nearby_table(i) if img is None else None},
        )

    media = sorted(n for n in z.namelist() if n.startswith("word/media/"))
    tiffs = {}
    for n in media:
        b = z.read(n)
        im = Image.open(io.BytesIO(b))
        t = im.tag_v2
        rgba = im.convert("RGBA").tobytes()
        tiffs[os.path.basename(n)] = {
            "w": im.size[0], "h": im.size[1],
            "compression": t.get(259), "predictor": t.get(317),
            "photometric": t.get(262), "spp": t.get(277),
            "rgba_sha256": hashlib.sha256(rgba).hexdigest(),
            "rgba_bytes": len(rgba),
        }
    return {
        "blocks": [[b[0], (b[1] if b[0] == "tbl" else b[1])] for b in blocks],
        "tables": [b[1] for b in blocks if b[0] == "tbl"],
        "n_paras": len(paras),
        "media": [os.path.basename(n) for n in media],
        "captions": caps,
        "tiff": tiffs,
        "paragraph_texts": [p["text"] for p in paras],
        "paragraph_images": [p["images"] for p in paras],
    }


def write(path, data, force):
    if os.path.exists(path) and not force:
        print(f"  已存在，跳过: {os.path.basename(path)}")
        return False
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf8"))
    print(f"  写入 {os.path.basename(path)}  {len(data)} 字节")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--real-docx", help="从哪个真 .docx 里取一张真 TIFF（首次生成时需要）")
    ap.add_argument("--si-text", help="真 SI 全文（.zotero-ft-cache）")
    ap.add_argument("--main-text", help="真正文全文（.zotero-ft-cache）")
    ap.add_argument("--cache", help="Zotero 的 translations.json（取一段真译文）")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures"))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    print(f"输出目录 {a.out}")

    # ── 1. mini_si.docx：用真 TIFF（没有真源就用合成的一张，保证脚本可跑）
    mini = os.path.join(a.out, "mini_si.docx")
    if os.path.exists(mini) and not a.force:
        print("  已存在，跳过: mini_si.docx")
    else:
        if a.real_docx and os.path.exists(a.real_docx):
            z = zipfile.ZipFile(a.real_docx)
            names = sorted(
                (n for n in z.namelist() if n.startswith("word/media/")),
                key=lambda s: int(re.findall(r"\d+", s)[-1]),
            )
            tiff = z.read(names[0])
            print(f"  取真 TIFF：{names[0]}（{len(tiff)} 字节）")
        else:
            raise SystemExit("首次生成需要 --real-docx（要一张真的 LZW-TIFF）")
        write(mini, build_docx(tiff), True)

    # ── 2. mini_si.expected.json（独立真值）
    exp = os.path.join(a.out, "mini_si.expected.json")
    if not os.path.exists(exp) or a.force:
        t = docx_truth(mini)
        with open(exp, "w", encoding="utf8") as f:
            json.dump(t, f, ensure_ascii=False, indent=1)
        print(f"  写入 mini_si.expected.json：{t['n_paras']} 段 / "
              f"{len(t['media'])} 张图 / {len(t['captions'])} 条图注")
        for k, v in t["tiff"].items():
            print(f"    {k}: {v['w']}x{v['h']} 压缩={v['compression']} "
                  f"predictor={v['predictor']} RGBA sha256={v['rgba_sha256'][:16]}…")

    # ── 3. 真文本 fixture
    if a.si_text and os.path.exists(a.si_text):
        write(os.path.join(a.out, "si_pages.txt"), open(a.si_text, "rb").read(), a.force)
    else:
        print("  跳过 si_pages.txt（没给 --si-text）")
    if a.main_text and os.path.exists(a.main_text):
        write(os.path.join(a.out, "main_text.txt"), open(a.main_text, "rb").read(), a.force)
    else:
        print("  跳过 main_text.txt（没给 --main-text）")

    # ── 4. 真译文样本（段落间距回归）
    sample = os.path.join(a.out, "translation_sample.json")
    if os.path.exists(sample) and not a.force:
        print("  已存在，跳过: translation_sample.json")
    elif a.cache and os.path.exists(a.cache):
        d = json.load(open(a.cache, encoding="utf8"))
        best = None
        for v in (d.get("entries") or {}).values():
            r = v.get("r") if isinstance(v, dict) else None
            if isinstance(r, str) and r.count("\n\n") >= 3 and (best is None or len(r) > len(best)):
                best = r
        if not best:
            raise SystemExit("缓存里没找到多段译文")
        with open(sample, "w", encoding="utf8") as f:
            json.dump({"note": "真实模型译文（段落间距回归用）", "text": best},
                      f, ensure_ascii=False, indent=1)
        print(f"  写入 translation_sample.json：{len(best)} 字符 / "
              f"{best.count(chr(10) + chr(10))} 处段落分隔")
    else:
        print("  跳过 translation_sample.json（没给 --cache）")

    # ── 5. 合成 RGBA（PNG 编码器回归，无需真数据）
    rgba = os.path.join(a.out, "fig_rgba.bin")
    ref = os.path.join(a.out, "fig_ref.png")
    if not os.path.exists(rgba) or a.force:
        w, h = 320, 200
        buf = bytearray()
        for y in range(h):
            for x in range(w):
                buf += bytes(((x * 255) // (w - 1), (y * 255) // (h - 1),
                              (x + y) % 256, 255 if (x // 8 + y // 8) % 2 else 128))
        write(rgba, bytes(buf), True)
        im = Image.frombytes("RGBA", (w, h), bytes(buf))
        im.save(ref)
        write(os.path.join(a.out, "fig_rgba.meta.json"),
              json.dumps({"w": w, "h": h}, indent=1), True)
        print(f"  写入 fig_rgba.bin / fig_ref.png（{w}x{h}）")

    # ── 6. inflate 对拍数据：用 zlib 造 raw deflate，JS 解出来必须逐字节相同
    #
    # 覆盖三种块类型：高度可压（动态 Huffman）、几乎不可压（stored 块）、
    # 以及**从 zip 里直接抠出来的真压缩流**（最有说服力的一条）。
    idir = os.path.join(a.out, "inflate")
    os.makedirs(idir, exist_ok=True)
    cases = {
        "text": b"hello raw deflate " * 7,
        "runs": b"A" * 5000 + b"B" * 3000,
        "random": bytes((i * 37 + 11) % 251 for i in range(20000)),
        "empty": b"",
    }
    zmini = zipfile.ZipFile(mini)
    real_xml = zmini.read("word/document.xml")
    cases["docxml"] = real_xml
    meta = []
    for name, raw in cases.items():
        co = __import__("zlib").compressobj(9, __import__("zlib").DEFLATED, -15)
        comp = co.compress(raw) + co.flush()
        with open(os.path.join(idir, name + ".in"), "wb") as f:
            f.write(comp)
        with open(os.path.join(idir, name + ".out"), "wb") as f:
            f.write(raw)
        meta.append({"name": name, "raw": len(raw), "comp": len(comp)})
    # zip 里 Deflate 存储的条目 → 原始压缩流（真来源，顺带验证 ZIP 偏移算术）
    info = zmini.getinfo("word/document.xml")
    if info.compress_type == 8:
        with open(mini, "rb") as f:
            f.seek(info.header_offset)
            hdr = f.read(30)
            nlen, elen = struct.unpack("<HH", hdr[26:30])
            f.seek(info.header_offset + 30 + nlen + elen)
            comp = f.read(info.compress_size)
        with open(os.path.join(idir, "zipentry.in"), "wb") as f:
            f.write(comp)
        with open(os.path.join(idir, "zipentry.out"), "wb") as f:
            f.write(zmini.read("word/document.xml"))
        meta.append({"name": "zipentry", "raw": info.file_size, "comp": len(comp)})
    with open(os.path.join(a.out, "inflate.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"  写入 inflate.json：{len(meta)} 个对拍用例")

    print("\n完成。fixtures 目录：")
    for n in sorted(os.listdir(a.out)):
        print(f"  {n}  {os.path.getsize(os.path.join(a.out, n))} 字节")


if __name__ == "__main__":
    main()
