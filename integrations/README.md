# 集成：Index-Translate 免费公共 API（B 站）

把 `https://index-translate.bilibili.com/v1` 这个**免费、无需鉴权**的翻译 API
接进 Zotero 翻译插件，作为一个可选服务。

**不需要改插件代码** —— 插件自带三个 OpenAI 兼容自定义服务（`customGPT1/2/3`），
用掉空缺的 `customGPT3` 即可。

---

## 1. 事实（都是实测的，不是猜的）

| 项 | 值 |
|---|---|
| Base URL | `https://index-translate.bilibili.com/v1` |
| 接口 | OpenAI 兼容 `POST /chat/completions`（也有 `GET /models`） |
| 模型 | `Index-Translate-35B-A3B`（推荐）、`Index-Translate-9B`、`Index-Translate-2B` |
| 鉴权 | **不需要**。带 `Bearer 任意值` 或不带都行 |
| 速度 | 单句 **0.3–0.5 秒** |
| `/models` 只列 35B | 但 2B/9B 实测也能调 |

### ⚠️ 三个实测坑

1. **User-Agent 不能是 Python 默认的**
   不带 UA（`Python-urllib/3.x`）→ **HTTP 412**（WAF 拦）。
   Firefox / Chrome / curl / 空串 / `Index-Translate-Client/1.0` 都 → 200。
   Zotero 用的是 Gecko 默认 UA（Firefox 形态）→ 没问题，**但别拿纯 urllib 脚本裸调**。

2. **会偶发返回空响应**
   同一请求连续打，出现过 4 次连续空（随后又正常）。
   免费公共服务，可以理解 —— 但意味着失败要重试。

3. **`enable_thinking` 要显式关掉**
   这个模型是 Qwen 系，参数名是 **`chat_template_kwargs.enable_thinking = false`**。
   （你 MiMo 那两个服务用的是 `{"thinking":{"type":"disabled"}}` —— 各家名字不一样。）

---

## 2. 怎么配的

用 `configure_indextranslate.py`（会关闭并重启 Zotero，因为要改 `prefs.js`）：

```bash
python3 configure_indextranslate.py --dry-run   # 先看要写什么
python3 configure_indextranslate.py             # 写入 + 重启
python3 configure_indextranslate.py --slot 2    # 换槽位
```

写进 `extensions.zotero.ZoteroPDFTranslate.customGPT3.*`：

| pref | 值 |
|---|---|
| `endPoint` | `https://index-translate.bilibili.com/v1` |
| `model` | `Index-Translate-35B-A3B` |
| `apiFormat` | `openai` |
| `temperature` | `0` |
| `stream` | **`false`** |
| `customParams` | `{"chat_template_kwargs":{"enable_thinking":false}}` |
| `prompt` | 见 `indextranslate_prompt.txt` |
| `secretObj.customgpt3` | `index`（占位。这个 API 不需要鉴权，但插件会拼 `Bearer <secret>`；留空会发 `Bearer undefined`） |

**然后**：插件设置里把「翻译服务」选成 **Custom GPT 3** 即可。

> 注意：`translateSource` 是**你的活动服务**。本包**不会**替你改它 ——
> 我这里演示时临时切过、之后已还原成 `customgpt1`（你的 MiMo pro）。

### 为什么 `stream=false`

插件的流式解析（`gpt.ts` 的 `streamCallback`）对**极小分片**有边界缺陷：
我把它原样的解析逻辑摘出来回放真实 SSE 响应，**逐字节喂进去会解析成空字符串**
（完整 body 一次给、或按 50–500 字节分片都正常）。
配上"偶发空响应"，流式在路上更容易踩到。
非流式在这个 API 上实测稳定，且它本来就 0.3 秒级，`stream=false` 体验没差别。

---

## 3. 提示词：为什么必须带【格式示例】块

这个模型**只靠抽象规则时，格式指令遵循很不稳定**。实测同一句含 5 个单位的文本：

| 提示词 | 结果 |
|---|---|
| 只有规则（"单位必须用 LaTeX"） | ❌ 原样输出 `720 mAh g-1`（裸写，正是用户最初抱怨的样子） |
| 规则 + "禁止 Unicode 上下标" | ⚠️ 变成 `720 mAh g⁻¹`（视觉对，但不是 LaTeX） |
| **规则 + 【格式示例】源文→译文 对照** | ✅ `720 $mAh\ g^{-1}$` |

所以 `indextranslate_prompt.txt` 里保留了三条**源文→译文**示例。
去掉它们，格式会立刻退化。

多句验证（最终提示词）：4 个用例、**0 个格式问题**（无裸单位、无 Unicode 上下标、无裸化学式）。

---

## 4. 怎么验证它真的在用这个服务

插件会把**服务名**写进翻译记忆：`<数据目录>/storage/<附件key>/translations.json`
的每条记录有一个 `s` 字段。

```bash
python3 - <<'EOF'
import json
d=json.load(open('/path/to/storage/XXXX/translations.json',encoding='utf8'))
es=sorted(d['entries'].values(), key=lambda v: v.get('at',0))
for v in es[-3:]:
    print(v['s'], '→', v['r'][:80])
EOF
```

看到 `customgpt3` 就是它在翻。**这比看屏幕可靠** ——
弹窗在 `task.result` 为空时显示的是**原文**，光看弹窗会误判成"没翻译"。

---

## 5. 已知边界

- **免费公共 API**：可能限流、可能偶发空响应，也可能随时下线。不适合当唯一依赖。
- **格式遵循是"大概率"而非"保证"**：长句、片段、特殊符号仍可能漏格式。
- 我**没有**给它加自动重试（那要改插件代码）。遇到空结果，再划一次即可。
- 只在这台机器 + Zotero 9.0.6 上验证过。
