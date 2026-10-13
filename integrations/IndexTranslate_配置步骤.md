# Index-Translate 接进 Zotero 翻译插件 —— 完整步骤

目标：把 B 站免费的 `https://index-translate.bilibili.com/v1` 当成插件里的一个翻译服务。
**不需要改插件代码** —— 用插件自带的「Custom GPT 3」这个空槽位。

---

## 一、这个 API 的三个关键事实（先看，少踩坑）

| 事实 | 说明 |
|---|---|
| **不用鉴权** | 密钥留空也能用；但插件会拼 `Bearer <密钥>`，留空会发 `Bearer undefined`（实测也能过，填个占位更干净） |
| **User-Agent 必须是浏览器形态** | 不带 UA（Python 默认的 `Python-urllib/3.x`）→ **HTTP 412 被 WAF 拦**。Zotero 用 Gecko 默认 UA，没问题；但你自己写脚本裸调会被拦，要加 UA |
| **关思维链的参数名是 Qwen 系的** | `chat_template_kwargs.enable_thinking = false`。（小米 MiMo 那套 `{"thinking":{"type":"disabled"}}` 在这里**无效**） |

---

## 二、方法 A：图形界面手填

### 1. 打开设置
Zotero → **编辑 → 设置** → 左侧找到翻译插件（**Translate for Zotero**）

### 2. 选服务
**翻译服务** 下拉 → 选 **Custom GPT 3**

### 3. 点「配置」，按下表填

| 界面字段 | 填什么 |
|---|---|
| **接口** | `https://index-translate.bilibili.com/v1` |
| **模型** | `Index-Translate-35B-A3B` |
| **温度** | `0` |
| **接口格式** | `OpenAI` |
| **流式输出** | **不勾**（见第五节说明） |
| **思考等级** | 默认（不用动） |
| **自定义请求** | `{"chat_template_kwargs":{"enable_thinking":false}}` |
| **提示词** | 复制第三节的全文 |

> 「接口」只填到 `/v1` 就行 —— 插件会自动补成 `/v1/chat/completions`（实测确认）。

### 4. 密钥
**留空即可**。想填就填 `index` 之类的占位字符串（它不校验）。
（密钥在「管理翻译服务密钥」里按服务名存，键名是 `customgpt3`。）

---

## 三、提示词（原样复制，别改）

```
任务：把用户消息中的${langFrom}文本翻译成${langTo}。

规则（必须全部满足）：
1. 化学式、下标、上标、单位必须用 LaTeX 行内公式 $...$，数学内部的空格写成 "\ "。
   绝不能裸写：mAh g-1、mA g-2、cm3、m2 g-1、N2、Cu2-xSe、Zn2+、10-3。
   即使源文里已经写成 Unicode 上下标（如 mAh g⁻¹、cm³、10⁻³），也必须改写成 LaTeX。
   任何情况下都不要输出 ₂ ⁻¹ ³ 这类上下标字符。
   普通叙述里的数字保持纯文本：25 °C、95%、pH 7、2 h、5 mg、Fig. 3、[1]。
2. 章节标题单独成行，并用 ** 包住整行。只给标题加粗，绝不加粗正文，也不要用 * 表示强调。
3. 引用与交叉引用原样保留：[1]、[3-5]、(Fig. 3)、Fig. 3a、Table 2、Scheme 1、Eq. (2)、SI。
4. 人名、机构名、期刊名、软件名保留原文。以下缩写保留英文：SEI、CEI、ICE、NASICON、MOF、COF、CV、EIS、DRT、GITT、BET、DFT、XPS、XRD、SEM、TEM、HRTEM、SAED、TGA、XAS、EXAFS、NMR、ICP-OES。
5. 术语用本领域标准中文译名：hard carbon 硬碳、sodium-ion battery 钠离子电池、anode 负极、cathode 正极、electrolyte 电解液、current density 电流密度、rate capability 倍率性能、Coulombic efficiency 库仑效率、reversible capacity 可逆比容量、specific surface area 比表面积、closed pore 闭孔、supercapacitor 超级电容器。
6. 保持原句结构，不总结、不解释、不增写、不省略。
7. 只输出译文。不要前言、不要说明、不要拼音、不要引号，也不要把整段包进 $ 或 $$。除第 1、2 条要求的 LaTeX 与 **标题标记** 外，不要使用其它 Markdown。

【格式示例（照这个风格做，注意单位整体进 $...$）】
源文：The capacity is 317 mAh g-1 at 20 mA g-2, with SSA of 25 m2 g-1 and pore volume 0.12 cm3 g-1.
译文：比容量为 317 $mAh\ g^{-1}$（20 $mA\ g^{-2}$），比表面积 25 $m^2\ g^{-1}$，孔容 0.12 $cm^3\ g^{-1}$。
源文：Zn2+ and N2 adsorption, see Fig. 3a [1-3].
译文：$Zn^{2+}$ 与 $N_2$ 吸附，见 Fig. 3a [1-3]。
源文：2.1 Synthesis of Cu2-xSe and Cu2-xSe-DETA I to V
译文：**2.1 $Cu_{2-x}Se$ 与 $Cu_{2-x}Se$–DETA-I 至 V 的合成**

${sourceText}
```

### ⚠️ 为什么必须留【格式示例】那一块

同一句含 5 个单位的文本，实测三种写法：

| 提示词 | 输出的单位 |
|---|---|
| 只有规则 | ❌ `720 mAh g-1`（裸写 —— 就是最初抱怨的样子） |
| 规则 + "禁止 Unicode 上下标" | ⚠️ `720 mAh g⁻¹`（视觉对，但没走 KaTeX） |
| **规则 + 示例块** | ✅ `720 $mAh\ g^{-1}$` |

**`${sourceText}` 这个占位符必须保留** —— 插件靠它把提示词切成"系统指令"和"正文"，
少了它会弹窗报错、不许保存。

---

## 四、方法 B：脚本一键写（换机器/重装时用）

```bash
cd zotero-si-figure-kit/integrations
python3 configure_indextranslate.py --dry-run   # 先看要写什么，不落盘
python3 configure_indextranslate.py             # 写入 + 自动重启 Zotero
python3 configure_indextranslate.py --slot 2    # 想用 Custom GPT 2 槽位
```

它会写这些 pref（都带 `extensions.zotero.ZoteroPDFTranslate.` 前缀）：

| pref | 值 |
|---|---|
| `customGPT3.endPoint` | `https://index-translate.bilibili.com/v1` |
| `customGPT3.model` | `Index-Translate-35B-A3B` |
| `customGPT3.apiFormat` | `openai` |
| `customGPT3.temperature` | `0` |
| `customGPT3.stream` | `false` |
| `customGPT3.customParams` | `{"chat_template_kwargs":{"enable_thinking":false}}` |
| `customGPT3.prompt` | 第三节全文（换行转成 `\n`） |
| `secretObj` 里的 `customgpt3` | `index`（占位） |

**它不会改你的活动服务**（`translateSource`）—— 那要你自己在界面上选。

---

## 五、为什么「流式输出」不勾

两条独立的原因：

1. **这个 API 会偶发返回空响应** —— 我实测连续 4 次空，随后又正常。免费公共服务，难免。
2. **插件的流式解析对极小分片有边界缺陷** ——
   我把插件自己的解析逻辑（`src/modules/services/gpt.ts` 的 `streamCallback`）摘出来，
   拿真实 SSE 响应回放：整包一次给 ✅、按 50–500 字节分片 ✅、**逐字节喂会解析成空字符串** ❌。

它本来就 0.3–0.5 秒返回，非流式体验没差别，但稳得多。

---

## 六、验证它真的在用这个服务

插件会把**服务名**写进翻译记忆。找 `<数据目录>/storage/<附件key>/translations.json`：

```bash
python3 - <<'EOF'
import json, glob
p = glob.glob('/mnt/d/<datadir>/文献/storage/*/translations.json')[0]   # 换成你刚翻的那篇
d = json.load(open(p, encoding='utf8'))
es = sorted(d['entries'].values(), key=lambda v: v.get('at', 0))
for v in es[-3:]:
    print(v.get('s'), '→', v.get('r', '')[:90])
EOF
```

看到 `customgpt3` 就是它在翻。

> ⚠️ **别只看弹窗**：当 `task.result` 为空时，弹窗显示的是**原文** ——
> 看上去像"没翻译"，其实可能是请求失败。以缓存里的 `s` 字段为准。

---

## 七、踩过的坑清单（照抄）

| # | 坑 | 处理 |
|---|---|---|
| 1 | 不带 User-Agent 调 → **412** | 脚本里加浏览器/客户端 UA |
| 2 | 关思维链的参数名照抄 MiMo → 无效 | 用 `chat_template_kwargs.enable_thinking` |
| 3 | 密钥留空 → 发 `Bearer undefined` | 随便填个 `index` |
| 4 | 流式 + 偶发空响应 → 更容易踩 | 关掉流式 |
| 5 | 只写抽象规则 → 单位裸写 | **加【格式示例】块**（关键） |
| 6 | 提示词里删掉 `${sourceText}` → 不让保存 | 保留占位符 |
| 7 | 看弹窗判断"没翻译" | 改看缓存的 `s` 字段 |

---

## 八、边界（不要当保证）

- 免费公共 API，**可能限流、可能随时下线**，不适合当唯一依赖。
- 格式遵循是"大概率"不是"保证"：长句、片段、特殊符号仍可能漏格式。
- 没有自动重试（要改插件代码）。遇到空结果，**再划一次**即可。
- 只在 Zotero 9.0.6 + Windows 上验证过。
