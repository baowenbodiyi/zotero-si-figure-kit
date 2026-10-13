#!/usr/bin/env python3
"""
校验「pristine + 覆盖层」与「pristine + 补丁」逐字节相同。

为什么要这个：kit 为了让 Windows 原生用户（没有 patch(1)）也能复刻，
把补丁结果预先摊成了 `plugins/translate/patched-<ver>/` 覆盖层。
覆盖层和补丁是**两处表达同一件事**，就可能漂移 —— 这个脚本把它们钉死。

退出码：
  0  一致（或有差异但用了 --allow-missing-patch）
  1  不一致（漂移了，必须修）
  3  本机没有 patch(1)，无法比对（跳过，不是失败）
用法：
  python3 scripts/lib/check_overlay.py <pristine_dir> <patch_file> <overlay_dir>
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

# 比对时跳过这些：它们本来就不参与补丁，跳过只是省时间
SKIP_NAMES = {"package-lock.json", "tsconfig.tsbuildinfo", ".npmrc"}
SKIP_DIRS = {"node_modules", "build", ".cache", ".git"}
# 复制重建树时只该剔掉构建产物 —— typings/ 是源码，绝不能删
PRUNE_DIRS = {"node_modules", "build", ".cache", ".git"}


def walk(root):
    out = {}
    for r, ds, fs in os.walk(root):
        ds[:] = [d for d in ds if d not in SKIP_DIRS]
        for x in fs:
            if x in SKIP_NAMES or x.endswith((".orig", ".rej", ".tsbuildinfo")):
                continue
            p = os.path.join(r, x)
            with open(p, "rb") as f:
                out[os.path.relpath(p, root)] = hashlib.sha256(f.read()).hexdigest()
    return out


def build_overlay_tree(pristine, overlay, dest):
    shutil.copytree(pristine, dest, symlinks=True)
    for d in PRUNE_DIRS:
        shutil.rmtree(os.path.join(dest, d), ignore_errors=True)
    # 覆盖层：把 patched/ 下的文件原样盖上去
    for r, _, fs in os.walk(overlay):
        for x in fs:
            s = os.path.join(r, x)
            rel = os.path.relpath(s, overlay)
            t = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(t), exist_ok=True)
            shutil.copy2(s, t)


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    pristine, patch, overlay = sys.argv[1:4]
    # 转绝对路径：下面 subprocess 会切 cwd，相对路径会失效
    pristine, patch, overlay = (os.path.abspath(p) for p in (pristine, patch, overlay))
    for label, p in (("pristine", pristine), ("patch", patch), ("overlay", overlay)):
        if not os.path.exists(p):
            print(f"  ❌ 找不到 {label}: {p}")
            return 1

    if not shutil.which("patch"):
        print("  ⏭  本机没有 patch(1) —— 跳过「覆盖层 == 补丁结果」比对")
        print("     （这不是失败：覆盖层本身就是给没有 patch 的机器用的）")
        return 3

    tmp = tempfile.mkdtemp(prefix="zpt-overlay-")
    try:
        recon = os.path.join(tmp, "recon")
        build_overlay_tree(pristine, overlay, recon)

        scratch = os.path.join(tmp, "scratch")
        shutil.copytree(pristine, scratch, symlinks=True)
        for d in PRUNE_DIRS:
            shutil.rmtree(os.path.join(scratch, d), ignore_errors=True)
        r = subprocess.run(["patch", "-p1", "--no-backup-if-mismatch", "-i", patch],
                           cwd=scratch, capture_output=True)
        if r.returncode != 0:
            print("  ❌ patch 应用失败：")
            print("     " + r.stdout.decode("utf-8", "replace").strip()[:600])
            print("     " + r.stderr.decode("utf-8", "replace").strip()[:600])
            return 1

        a, b = walk(recon), walk(scratch)
        only_a = sorted(set(a) - set(b))
        only_b = sorted(set(b) - set(a))
        diff = sorted(k for k in set(a) & set(b) if a[k] != b[k])
        print(f"  覆盖层重建 = {len(a)} 文件 | 补丁结果 = {len(b)} 文件")
        for label, lst in (("只在覆盖层", only_a), ("只在补丁结果", only_b), ("内容不同", diff)):
            if lst:
                print(f"  ❌ {label} ({len(lst)}): {lst[:12]}")
        if only_a or only_b or diff:
            print("  ❌ 覆盖层与补丁已经漂移 —— 改动请同时更新两者")
            return 1
        print("  ✅ 覆盖层 == 补丁结果（逐字节）")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
