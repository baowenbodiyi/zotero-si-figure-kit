#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 Index-Translate 免费公共 API 配置成 Zotero 翻译插件里的一个服务。

为什么用 `customGPT3` 槽位而不是改代码：
    插件本来就自带三个 **OpenAI 兼容自定义服务**（customGPT1/2/3），
    支持 endPoint / model / apiFormat / prompt / temperature / stream / customParams。
    而 `customParams` 是**原样合并进请求体**的 —— 正好用来放
    `chat_template_kwargs: {enable_thinking: false}`。
    所以这件事**不需要改插件代码**，只要写对 prefs。

用法：
    python3 configure_indextranslate.py            # 写入（会重启 Zotero）
    python3 configure_indextranslate.py --dry-run  # 只打印将要写什么
    python3 configure_indextranslate.py --slot 2   # 换一个槽位（1/2/3）

⚠️ 会**关闭并重启 Zotero**：prefs.js 必须在 Zotero 退出时才能安全改写。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT_FILE = os.path.join(HERE, "indextranslate_prompt.txt")

API_BASE = "https://index-translate.bilibili.com/v1"
MODEL = "Index-Translate-35B-A3B"          # 实测 35B 的 LaTeX/标题合规最好；9B 会把单位译错
TEMPERATURE = "0"
STREAM = "true"
# 这个模型是 Qwen 系，关思维链的参数名是 chat_template_kwargs.enable_thinking
# （你自己 MiMo 那两个用的是 {"thinking":{"type":"disabled"}}，不同家不一样）
CUSTOM_PARAMS = '{"chat_template_kwargs":{"enable_thinking":false}}'


def find_profile(explicit=None):
    if explicit:
        return explicit
    env = os.environ.get("ZOTERO_PROFILE")
    if env and os.path.isfile(os.path.join(env, "prefs.js")):
        return env
    import glob
    cands = glob.glob("/mnt/c/Users/*/AppData/Roaming/Zotero/Zotero/Profiles/*.default")
    cands += [os.path.expanduser("~/.zotero/zotero/*.default")]
    cands = [c for c in cands if os.path.isfile(os.path.join(c, "prefs.js"))]
    if not cands:
        sys.exit("找不到 Zotero profile（用 --profile 指定，或设 ZOTERO_PROFILE）")
    return sorted(cands)[0]


def powershell():
    for c in ("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",):
        if os.path.exists(c):
            return c
    return None


def jsescape(s):
    """把 Python 字符串转成 prefs.js 里那种 JS 字符串字面量的内容"""
    return (s.replace("\\", "\\\\").replace('"', '\\"')
             .replace("\r\n", "\\n").replace("\n", "\\n").replace("\t", "\\t"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slot", default="3", choices=["1", "2", "3"])
    ap.add_argument("--profile", default=None)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    prof = find_profile(a.profile)
    prefjs = os.path.join(prof, "prefs.js")
    prefix = f"extensions.zotero.ZoteroPDFTranslate.customGPT{a.slot}"

    prompt = open(PROMPT_FILE, encoding="utf8").read().rstrip()
    if "${sourceText}" not in prompt:
        sys.exit("提示词模板里必须有 ${sourceText}（插件靠它切分 system / 正文）")

    values = {
        f"{prefix}.endPoint": API_BASE,
        f"{prefix}.model": MODEL,
        f"{prefix}.apiFormat": "openai",
        f"{prefix}.prompt": prompt,
        f"{prefix}.temperature": TEMPERATURE,
        f"{prefix}.stream": STREAM,
        f"{prefix}.customParams": CUSTOM_PARAMS,
        f"{prefix}.thinkingLevel": "default",
    }

    print(f"profile : {prof}")
    print(f"槽位    : customGPT{a.slot}  →  插件服务列表里显示为 'Custom GPT {a.slot}'")
    for k, v in values.items():
        show = v if len(v) <= 70 else v[:70] + f"…（共 {len(v)} 字符）"
        print(f"  {k.split('customGPT')[1]:<22} = {show!r}")

    if a.dry_run:
        print("\n--dry-run：没有写入。")
        return

    # ── 关 Zotero（prefs.js 必须在退出后才能安全改）
    ps = powershell()
    if ps:
        print("\n关闭 Zotero…")
        subprocess.run([ps, "-NoProfile", "-Command",
                        "Get-Process zotero -ErrorAction SilentlyContinue | Stop-Process -Force"],
                       capture_output=True)
        for _ in range(40):
            r = subprocess.run([ps, "-NoProfile", "-Command",
                                "@(Get-Process zotero -ErrorAction SilentlyContinue).Count"],
                               capture_output=True, text=True)
            if r.stdout.strip() in ("0", ""):
                break
            time.sleep(1)
        print("  已退出")

    # ── 改 prefs.js：先删同槽位旧行，再追加（避免重复定义）
    src = open(prefjs, encoding="utf8", errors="replace").read()
    lines = [l for l in src.splitlines()
             if not re.match(r'^user_pref\("%s\.' % re.escape(prefix), l)]
    out = "\n".join(lines).rstrip("\n") + "\n"
    for k, v in values.items():
        out += f'user_pref("{k}", "{jsescape(v)}");\n'
    tmp = prefjs + ".tmp"
    with open(tmp, "w", encoding="utf8") as f:
        f.write(out)
    os.replace(tmp, prefjs)          # prefs.js 不在 9p 上时没关系；在的话 replace 也是先删后建
    print(f"  已写入 {len(values)} 个 pref")

    # ── 起 Zotero
    exe = None
    for c in ("/mnt/c/Program Files/Zotero/zotero.exe",):
        if os.path.exists(c):
            exe = c
    if ps and exe:
        win = exe.replace("/mnt/c", "C:").replace("/", "\\")
        subprocess.run([ps, "-NoProfile", "-Command", f"Start-Process '{win}'"], capture_output=True)
        print("  已启动 Zotero")
    else:
        print("  ⚠️ 没能自动启动，请手动打开 Zotero")

    print("\n下一步：")
    print(f"  1. 插件设置里把「翻译服务」选成 Custom GPT {a.slot}")
    print("  2. 密钥栏可以留空（这个 API 不需要鉴权）")
    print("  3. 划一句试试")


if __name__ == "__main__":
    main()
