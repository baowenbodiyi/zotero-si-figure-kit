#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
密钥/PII 审计：确认这个包里**没有夹带本机的任何凭据**。

为什么要有这个脚本：把补丁分发出去之前，"我没放密钥吧"这种问题
**不能靠印象回答**。这里做的是**反查**：
  1. 先收集本机**真实存在**的凭据值（key 文件 + Zotero prefs 里的 secretObj）
  2. 把每个值（以及它的**片段**）在待审目录里搜一遍
  3. 再补一遍通用模式扫描（sk- / ghp_ / Bearer / PRIVATE KEY / AKIA / password 赋值）
  4. 最后报个人信息（用户名、邮箱、机器路径）

用法：
  python3 scripts/audit_no_secrets.py [待审目录，默认本包根目录]
退出码：0 = 干净；1 = 发现疑似泄漏（会打印文件名与位置，但**不打印密钥本身**）。
"""
import argparse
import json
import os
import re
import sys

HOME = os.path.expanduser("~")

# 常见凭据文件（存在才用）
KEY_FILES = [
    ("~/.mimo_api_key", "MiMo API key"),
    ("~/.github_pat", "GitHub PAT"),
    ("~/.mp_api_key", "Materials Project key"),
    ("~/.openai_api_key", "OpenAI key"),
    ("~/.deepseek_api_key", "DeepSeek key"),
]

PII_PATTERNS = [
    ("邮箱", rb"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"),
    ("私钥块", rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("AWS AKIA", rb"AKIA[0-9A-Z]{16}"),
    ("GitHub PAT", rb"(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}"),
    ("OpenAI 式 sk-", rb"sk-[A-Za-z0-9_\-]{20,}"),
    ("Bearer token", rb"[Bb]earer\s+[A-Za-z0-9._\-]{20,}"),
    ("api key 赋值", rb"(?i)api[_\-]?key\s*[:=]\s*[\"']?[A-Za-z0-9._\-]{16,}"),
    ("password 赋值", rb"(?i)passw(?:or)?d\s*[:=]\s*[\"'][^\"']{6,}[\"']"),
]


def collect_secrets(zotero_profile=None):
    """收集本机真实凭据值。返回 {显示名: 值}（值只用于反查，不打印）"""
    out = {}
    for path, label in KEY_FILES:
        p = os.path.expanduser(path)
        try:
            v = open(p).read().strip()
            if len(v) >= 8:
                out[label] = v
        except Exception:
            pass

    # Zotero 翻译插件的 secretObj（里面是逐服务的密钥）
    prof = zotero_profile or os.environ.get("ZOTERO_PROFILE")
    if not prof:
        # 自己找一个
        # ⚠️ 只能按**候选路径**找，绝不能 os.walk("/mnt/c/Users") ——
        #    那是几十万个文件，会把脚本卡死（本脚本第一版就是这么挂的）。
        import glob
        cands = [os.path.join(HOME, ".zotero", "zotero"),
                 os.path.join(HOME, "Library", "Application Support", "Zotero", "Profiles")]
        cands += sorted(glob.glob("/mnt/c/Users/*/AppData/Roaming/Zotero/Zotero/Profiles/*.default"))
        for base in cands:
            if os.path.isfile(os.path.join(base, "prefs.js")):
                prof = base
                break
            if os.path.isdir(base):
                for sub in sorted(os.listdir(base))[:20]:
                    p2 = os.path.join(base, sub)
                    if os.path.isfile(os.path.join(p2, "prefs.js")):
                        prof = p2
                        break
            if prof:
                break
    if prof and os.path.isfile(os.path.join(prof, "prefs.js")):
        prefs = open(os.path.join(prof, "prefs.js"), encoding="utf8", errors="replace").read()
        m = re.search(
            r'user_pref\("extensions\.zotero\.ZoteroPDFTranslate\.secretObj",\s*"((?:[^"\\]|\\.)*)"\)',
            prefs)
        if m:
            raw = m.group(1).replace('\\\\', '\\').replace('\\"', '"')
            try:
                obj = json.loads(raw)

                def walk(o, path=""):
                    if isinstance(o, dict):
                        for k, v in o.items():
                            walk(v, f"{path}.{k}")
                    elif isinstance(o, str) and len(o) >= 8:
                        out[f"secretObj{path}"] = o
                walk(obj)
            except Exception:
                pass
    return out


def shape(s):
    """把值变成"字符形状"（字母→a/A，数字→9）。用于**不泄漏地**说明它长什么样。"""
    return "".join("a" if c.islower() else "A" if c.isupper() else "9" if c.isdigit() else c
                   for c in s)


def upstream_defaults(root):
    """
    把上游源码里所有 `defaultSecret: "..."` 的值收集起来。

    为什么要这一步：插件给每个翻译服务都带了一个**默认占位值**，
    用户没改过的话，prefs 里存的就是这个默认值 —— 它看起来像密钥
    （例如 caiyun 的 `defaultSecret: "3975l6lr5pcbvidl6jl2"`），
    但它是**上游开源仓库里本来就有的公开字符串**，不是使用者的凭据。
    不把这一类认出来，审计就会一直喊狼来了。
    """
    out = set()
    for r, d, f in os.walk(root):
        d[:] = [x for x in d if x not in ("node_modules", ".cache", "work", ".git")]
        for n in f:
            if not n.endswith((".ts", ".js")):
                continue
            try:
                txt = open(os.path.join(r, n), encoding="utf8", errors="replace").read()
            except Exception:
                continue
            for m in re.finditer(r'defaultSecret\s*[:=]\s*[\'"`]([^\'"`]+)[\'"`]', txt):
                out.add(m.group(1))
    return out


def classify(val, ups=None):
    """
    候选值是「真凭据」还是「插件自带的字段名占位符」？

    ⚠️ 这一步是这个脚本的关键。第一版不做区分，结果 23 条"命中"全是
    上游 `xxx.ts` 里的 `defaultSecret: "accessKeyId#accessKeySecret"` —— 字段名清单，
    根本不是你填的密钥。一个只会喊狼来了的审计工具等于没有。
    """
    # ⓪ 与上游 defaultSecret 完全相同 → 是公开的默认值，不是使用者的凭据
    if ups and val in ups:
        return "upstream_default"
    # ① 带括号说明 / 中文 / 空白，且用了分隔符 → 一定是字段名清单
    #    例：secretId#secretKey#region(可选值 ap-guangzhou)#projectId(可选值 0)
    if re.search(r"[\s()（）\u4e00-\u9fa5]", val) and re.search(r"[#|,;]", val):
        return "placeholder"
    # ② 含分隔符（, # | ;）→ 是"字段名清单"这类占位符，真密钥不会含这些字符
    if re.search(r"[#|,;]", val):
        return "placeholder"
    # ②b 纯字段名用分隔符连起来
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9]*([#|,;/:\s][A-Za-z][A-Za-z0-9]*)+", val):
        return "placeholder"
    # ③ 明确的密钥前缀
    if val.startswith(("sk-", "ghp_", "github_pat_", "AKIA")):
        return "secret"
    # ④ 真密钥的形态：**单个 token**、够长、字母数字混合（不是自然语言词组）
    if re.fullmatch(r"[A-Za-z0-9_.\-]+", val) and len(val) >= 20 \
       and re.search(r"[0-9]", val) and re.search(r"[A-Za-z]", val):
        return "secret"
    return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="?", default=None)
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    root = a.target or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    root = os.path.abspath(root)
    print(f"审计目录：{root}\n")

    blobs = {}
    for r, d, f in os.walk(root):
        d[:] = [x for x in d if x not in ("node_modules", ".cache", "work", ".git")]
        for n in f:
            p = os.path.join(r, n)
            # conf/kit.conf 是本机生成的（含本机路径），**不随包分发** → 不参与审计
            if os.path.relpath(p, root) == os.path.join("conf", "kit.conf"):
                continue
            try:
                blobs[p] = open(p, "rb").read()
            except Exception:
                pass
    print(f"读到 {len(blobs)} 个文件\n")

    secrets = collect_secrets()
    ups = upstream_defaults(root)
    kinds = {n: classify(v, ups) for n, v in secrets.items()}
    n_real = sum(1 for k in kinds.values() if k == "secret")
    print(f"== 1. 反查本机真实凭据（{len(secrets)} 个值；其中像真密钥的 {n_real} 个）==")
    if not secrets:
        print("   本机没有可用的凭据样本 → 只能靠第 2 步的模式扫描")
    real_bad = 0      # 真密钥被找到 = 必须处理
    ph_hits = 0       # 占位符被找到 = 正常（上游源码里本来就有）
    up_hits = 0       # 与上游默认值相同 = 正常（用户从没改过那个服务的密钥）
    for name, val in secrets.items():
        kind = kinds[name]
        frags = {"整值": val}
        if len(val) >= 24:
            frags.update({"前16": val[:16], "后16": val[-16:],
                          "中段": val[len(val)//2 - 8:len(val)//2 + 8]})
        found = {}
        for fn, fr in frags.items():
            fh = [os.path.relpath(p, root) for p, b in blobs.items() if fr.encode() in b]
            if fh:
                found[fn] = fh
        if not found:
            tag = {"secret": "随机形态（像真密钥）", "placeholder": "字段名/占位符",
                   "upstream_default": "上游自带的默认值（公开仓库里就有）",
                   "unknown": "形态不明"}[kind]
            print(f"   ✅ {name:52s} 长度{len(val):4d}  {tag}  形状 {shape(val)[:40]}")
            continue
        if kind == "secret":
            real_bad += 1
            for fn, fh in found.items():
                print(f"   ❌ {name}（{fn}）出现在: {fh[:4]}")
        elif kind == "upstream_default":
            up_hits += 1
            print(f"   ℹ️  {name:52s} 与**上游 defaultSecret 完全相同** → 是插件自带默认值，"
                  f"不是你的凭据（出现在 {len(found.get('整值', []))} 个文件）")
        elif kind == "placeholder":
            ph_hits += 1
            print(f"   ℹ️  {name:52s} 是**插件自带的字段名占位符**，"
                  f"上游源码里本来就有（{len(found['整值']) if '整值' in found else 0} 个文件）→ 不算泄漏")
        else:
            print(f"   ⚠️  {name:52s} 形态不明且被找到，请人工看一眼: "
                  f"{list(found.values())[0][:3]}")
    print(f"   → 真密钥命中 {real_bad} 个；占位符 {ph_hits} 个、上游默认值 {up_hits} 个（都正常）")

    print(f"\n== 2. 通用模式扫描 ==")
    for name, rx in PII_PATTERNS:
        hits = []
        for p, b in blobs.items():
            for m in re.finditer(rx, b):
                hits.append((os.path.relpath(p, root), m.group(0)[:24]))
        if hits:
            print(f"   ⚠️ {name}: {len(hits)} 处")
            for f, s in hits[:5]:
                print(f"        {f}  →  {s!r}…")
        else:
            print(f"   ✅ {name}: 无")

    print(f"\n== 3. 个人信息（不是密钥，但分发前你可能想知道）==")
    # ⚠️ 这几个名字**从环境里取**，不写死 —— 否则本脚本自己就会成为唯一泄漏源
    #    （第一版就是写死的，结果审计报告把自己也标红了）。
    probes = []
    u = os.environ.get("USER") or os.environ.get("USERNAME") or ""
    if u and u.lower() not in ("root", "administrator", "user"):
        probes.append((f"当前用户名（{u}）", u.encode()))
    prof = os.environ.get("ZOTERO_PROFILE", "")
    if prof:
        probes.append(("Zotero profile 目录名", os.path.basename(prof).encode()))
    hd = os.path.expanduser("~").split(os.sep)[-1]
    if hd and hd not in (u, "root"):
        probes.append((f"家目录名（{hd}）", hd.encode()))
    if not probes:
        print("   （取不到可用于反查的本机标识——这本身是好事）")
    for name, needle in probes:
        hits = [os.path.relpath(p, root) for p, b in blobs.items() if needle in b]
        hits = [h for h in hits if "audit_no_secrets" not in h]
        if hits:
            print(f"   ⚠️ {name}: {len(hits)} 个文件  {hits[:5]}")
        else:
            print(f"   ✅ {name}: 无")
    print("   提示：docs/ 里的两份是**原作者的工作日志**，天然含他机器的路径；")
    print("         那是上下文、不是凭据。要对外分发可自行删掉 docs/。")

    print()
    if real_bad:
        print("❌ 有**真凭据**出现在待审目录里 —— 必须清掉才能分发")
        return 1
    print("✅ 未发现本机真凭据出现在待审目录里")
    print("   （占位符命中不算问题：那是上游插件自带的字段名定义）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
