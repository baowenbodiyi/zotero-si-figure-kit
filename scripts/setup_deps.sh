#!/usr/bin/env bash
# 装 work/translate 的依赖（npm ci）+ 测试用的 parse5。
# 只有这一步需要联网；之后的补丁应用与全部离线验收都不需要。
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/work/translate"

[ -d "$SRC" ] || { echo "❌ 先跑 bash scripts/apply_patch.sh"; exit 1; }

echo "== npm ci（插件构建依赖）=="
cd "$SRC"
# ⚠️ 两个实测坑：
#  1. 上游 .npmrc 里可能有 `proxy=""` 这类空值配置，npm 会刷一串 warn（不影响结果）
#  2. **用户级 npm 配置里可能留着已经失效的代理** → npm ci 直接 network error。
#     本机实测：~/.npmrc 的 proxy 指向一个早就关掉的端口（curl/git 里的代理早停了，npm 这边没清）。
#     所以先正常试，失败再**绕过用户配置**重试。
#     不能无条件绕过 —— 别人机器上的代理可能是必需的。
npm_ci() { npm ci --no-audit --no-fund "$@" 2>&1 | grep -vE "^npm warn"; }
if ! npm_ci > /tmp/zpt-npm.log 2>&1; then
  echo "  npm ci 失败，最后几行："
  tail -3 /tmp/zpt-npm.log | sed 's/^/    /'
  echo "  改用 --userconfig /dev/null 重试（忽略用户级 npm 配置）…"
  if npm_ci --userconfig /dev/null > /tmp/zpt-npm.log 2>&1; then
    echo "  ✅ 绕过用户配置后成功（说明是那条失效代理的锅）"
  else
    tail -5 /tmp/zpt-npm.log | sed 's/^/    /'
    echo "❌ 依赖装不上。修好网络/代理后再跑一次。"; exit 1
  fi
fi
tail -2 /tmp/zpt-npm.log | sed 's/^/  /'

echo ""
echo "== 测试依赖：parse5（真 HTML5 解析器，段落间距回归必须用它）=="
mkdir -p "$HERE/tests"
cd "$HERE/tests"
if [ ! -f package.json ]; then
  printf '{"name":"zpt-kit-tests","private":true,"type":"commonjs"}\n' > package.json
fi
if [ -d node_modules/parse5 ]; then
  echo "  已有 parse5，跳过"
else
  npm install --no-audit --no-fund parse5 2>&1 | grep -vE "^npm warn" | tail -3 \
    || npm install --userconfig /dev/null --no-audit --no-fund parse5 2>&1 | grep -vE "^npm warn" | tail -3
fi
node -e "require('parse5'); console.log('  ✅ parse5 可用')"
echo ""
echo "完成。下一步： bash scripts/verify_all.sh"
