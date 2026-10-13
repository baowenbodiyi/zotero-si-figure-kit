# 交接手册（HANDBOOK）

给**下一个接手的人/AI**：读完这一份，你应该能改这份补丁而不踩已知的坑。
比 `docs/交接手册_完整版.md`（1600+ 行流水账）短，但保留了所有**会再犯的错误**。

---

## 1. 这东西干了什么（数据流）

```
用户在 Zotero 阅读器里划选一段正文
        │
        ▼
popup.ts / updateReaderPopup          每次渲染都调
        │
        ├─► 翻译服务（用户自己配的）→ task.result
        │
        └─► updateSiFloating(doc, taskId, 原文, itemId)        ← siBox.ts
                 │
                 ├─ parseSiRefs(原文)                           ← siRefs.ts
                 │    只认带 S 的编号：Figure S3 / Table S1 / 图 S2
                 │    没有 S 的 Figure 3 是正文自己的图，必须排除
                 │
                 ├─ findSiAttachment(itemId)                    ← 附件挑选（打分）
                 │    [SI] 前缀 +10 / supporting information +6 / SI 标签 +5
                 │
                 ├─ siKind(附件)  ──► "pdf" | "word" | "doc" | "other"
                 │
                 ├─[pdf ] getSiPages → attachmentText 按 \f 分页
                 │        findCaptionPage → 图注在第几页
                 │        getSiFigure → pdf.js 取嵌入位图 / 整页渲染
                 │
                 └─[word] getSiDocx → parseDocx(.docx)          ← docx.ts
                          findDocxFigure → 图注段 → 就近取图
                          getSiFigure → decodeTiff → RGBA       ← tiff.ts
                                      → reader 窗口 canvas → PNG
                 │
                 ▼
        siBox.ts 渲染独立浮窗（拖标题栏移动、右下角缩放、rect 存 pref）
        译文里不再有 SI 引用 → 自动收起
```

`inflate.ts` 是 `docx.ts` 的底层（解 ZIP 里的 deflate）；`pngEncode.ts` 是兜底 PNG 编码器。

---

## 2. 代码地图

| 文件 | 职责 | 什么时候动它 |
|---|---|---|
| `src/utils/siRefs.ts` | 引用解析、附件挑选、图注定位、（Word 的）docx 缓存 | 改"认哪些引用/怎么定位" |
| `src/utils/docx.ts` | `.docx` → 段落 + 图注→图 | 改 Word 侧的配对规则 |
| `src/utils/tiff.ts` | TIFF → RGBA（LZW/PackBits/Deflate，Predictor 1&2） | 遇到新 TIFF 变体 |
| `src/utils/inflate.ts` | 纯 JS raw DEFLATE | 基本不用动 |
| `src/utils/siFigure.ts` | 取图（PDF 与 Word 两条路）、reader realm 的坑都在这 | 改"怎么把图变出来" |
| `src/modules/siBox.ts` | 浮窗 UI：拖动/缩放/显隐/渲染/图注翻译 | 改外观与交互 |
| `src/utils/mathRenderer.ts` | 译文富文本：KaTeX + 标题加粗 + 引用角标 + **换行** | 改译文排版 |
| `src/utils/debugLog.ts` | 调试日志（含 `BUILD_TAG`） | 每次构建都要改 `BUILD_TAG` |
| `src/modules/popup.ts` | 阅读器弹窗；调 `updateSiFloating` | 改弹窗本体 |

---

## 3. ⭐ 全部实测坑（按"会不会再犯"排序）

### 3.1 realm（最贵的一类，改任何取图代码前必读）

Zotero 插件跑在 **bootstrap Sandbox** 里；pdf.js 跑在**另一个模块 realm**；
阅读器文档又是一个 **reader realm**。三者之间递对象会被 Xray 拦。

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `navigator is not defined` | pdf.js 一调用就抛 | 给 **pdf.js 那个 global** 补，不是插件自己的：`Components.utils.getGlobalForObject(pdfjs)` |
| 跨 realm 传 `Uint8Array` | `Permission denied to access property Symbol.iterator` | `cloneInto(bytes, moduleGlobal)` |
| 选项对象跨 realm | `getDocument - no 'url' parameter provided`（明明传了） | 在**目标 realm 里**创建对象，或整个渲染用 `new inner.Function(...)` 跑 |
| 类实例跨 realm | `pdf.getPage is not a function` | 同上：**整段逻辑在 reader realm 里跑** |
| canvas / `ImageData` | 插件 sandbox 里没有 canvas | 借**阅读器窗口的** canvas：`win.ImageData` + `cloneInto` |
| `file://` 图片 | 在 `resource://` 文档里被拒（**不是 CSP，是 file-URI 同源策略**） | 用 `data:` URL |

> ⚠️ **探针里能跑通 ≠ 插件里能跑通**：Run JavaScript 沙箱权限更宽。
> 曾经用探针验过就下手，结果插件里全崩。**必须在插件里验。**

### 3.2 环境 / 平台

| 坑 | 说明 |
|---|---|
| `taskkill`/`tasklist` 输出不可靠 | 明明在跑却说没跑 → 在运行中换文件，装的其实没生效。**用 PowerShell `Get-Process`** |
| `/mnt/c` 是 **9p 挂载** | ① 覆盖已存在文件会 `Errno 22` → **先 `rm` 再写**；② **有写回延迟** → 刚写完就启动 Zotero 会读到旧字节（见 3.4） |
| WSL 里没有 `zip` | 打包用 Python `zipfile` |
| 用户级 npm 可能留死代理 | `npm ci` 直接 network error。真遇到就 `--userconfig /dev/null` 重试（但别无条件绕过：别人的代理可能是必需的） |
| `.ps1` 必须 ASCII 无 BOM | 非 ASCII 注释 + 无 BOM → Windows PowerShell 按 ANSI 解析 → **`$args` 全空**，脚本静默不干活 |
| Zotero 是**单实例** | 已经在跑时再 `Start-Process` 只会在已有实例里开窗口；脚本必须先确认旧进程真的没了 |

### 3.3 数据格式（改 SI 取图必读）

| 坑 | 说明 |
|---|---|
| **`.docx` 里的图是 TIFF** | 实测 29 张全是：`压缩=LZW(5)`、`Photometric=RGB`、`8bit×4`、**`Predictor=2`**、单 strip、在 zip 里**不压缩**存储 |
| **浏览器不能渲染 TIFF** | `data:image/tiff` 是死路，必须先解成 RGBA |
| TIFF LZW 两个坑 | ① 位序 **MSB-first**（与 DEFLATE 相反）；② **early change = 1**（`nextCode == 2^bits - 1` 就加宽） |
| `<br></br>` 在 HTML5 里是**两个**换行 | `br` 的结束标签按开始标签处理。每个 `\n` 会渲染成两行 → 段落间空一大片。**只能写 `<br>`** |
| 用错 HTML 解析器会得出错误结论 | `lxml` 是 HTML4 解析器，**不**这样处理 `</br>`。验这类问题必须用真 HTML5 解析器（`parse5`） |
| 图注与图的对应 | 图独占一段、图注在紧邻段（有时反过来）。**±2 段就近**，但**距离 2 必须要求中间那段不是图注** —— 否则本身没图的图注会抢走邻居的图，显示**错误的图** |
| `Table S1` 常常是真 Word 表格 | 没有图片 → 只能翻图注，**不能假装有图** |
| `.doc` 不是 zip | 老二进制格式取不了图。要单独给准确提示，别报成"没有对应图片" |
| Word 会把 `Figure S1` 拆成多个 run | 解码时必须**按 `<w:t>` 拼接**，不能按标签截断（否则得到 `"Figure S 1 ."`） |

### 3.4 验收方法学（最容易被自己骗的一类）

| 坑 | 教训 |
|---|---|
| **「文件里有」≠「跑的是它」** | 磁盘 XPI、`AddonManager` 版本、甚至从 Zotero 内部读 jar 内容，**四条证据全说新代码在**，运行时却执行旧逻辑。唯一可靠判据：代码自己把 `BUILD_TAG` 打进日志，且只看**本次重启之后新增**的行 |
| 那条判据本身也会**假失败** | 9p 写回延迟 → 刚 cp 完就启动会读到旧字节。修法：写完**回读产物里的 `BUILD_TAG`** 核对 + 等不到就**自动重启一次再判** |
| **日志会静默丢行** | `debugLog` 原是"读整个文件→拼一行→整文件写回"，无排队。40 条并发**只落 1 条**。因为本项目所有验收都建立在日志上，这等于验收标准失效。修法：promise 链串行化 |
| 测试自己也会骗人 | 桩里两个用例用了同一个 id，而按 id 缓存 → 第二个用例拿到第一个的数据。**是测试 bug，不是产品 bug**，但差点得出错误结论 |
| "没看到效果"先怀疑观测口径 | 验"打开 SI"时只查了 `WINWORD` 进程 → 得出"没打开"的错误结论，转而去用更暴力的手段。其实这台机器 Word 文档归 **WPS** 管，功能一直是好的 |
| 断言必须对着**独立实现** | 别用被测代码算真值。TIFF 对 **PIL**、inflate 对 **zlib**、图注对**独立正则**、`<br>` 对 **parse5** |
| 测试要有牙齿 | 把**修复前**的写法复刻一份同时跑（A/B），证明这份测试抓得到那个 bug |

### 3.5 UI 自动化（只有 Windows，且要人不在电脑前）

| 坑 | 说明 |
|---|---|
| 坐标不可靠 | 用控件句柄 + `SendMessage`（`winauto` MCP）；纯坐标只用于 pdf.js 划选这类没有控件的场景 |
| **发键前必须校验焦点** | 焦点没抢到时 `Alt+F` / `Enter` 会打到**别的窗口**（实测打到过浏览器） |
| 窗口标题匹配要精确 | 用 `- Zotero` 会匹配到浏览器里带 "Zotero" 的标签页。用完整标题片段 |
| 原始鼠标点击会打到最上面的窗口 | 必须显式指定窗口句柄；`prefer=element`（UIA 路径）不注入输入、更安全，但 XUL 元素上的 `invoke` 可能**不触发** click 处理器 |
| 人正在用电脑要让路 | 有仲裁器；被拒是正常行为，别硬来 |

---

## 4. 本次交付包含的四个改动（2.4.8.56 → 2.4.8.67）

按时间顺序，每条都在 `docs/交接手册_完整版.md` §22 有完整记录：

| 版本 | 改动 | 触发原因 |
|---|---|---|
| `+wordsi` | **Word 版 SI 出图**：`siKind` 分档、`docx.ts` / `tiff.ts` / `inflate.ts`、caption→图 ±2 就近 | 用户："有些支撑信息不是 pdf，是 word" |
| `+wordsi` | **修 `debugLog` 丢行**（并发无排队） | 活体验证时关键日志凭空消失 |
| `+brfix` | **修段落间距**：`<br></br>` → `<br>`，并压缩多余空行 | 用户："空太大了" |
| `+siguard` | **修越位抢图**：距离 2 只在中间段不是图注时允许 | 造 fixture 时发现 Figure S2 抢走了 S1 的图 |

---

## 5. 想继续改？先做这三件事

1. **改 `BUILD_TAG`**（`src/utils/debugLog.ts`）。否则你无法证明运行的是哪份代码。
2. **跑 `bash scripts/verify_all.sh`**。134 项断言，几秒钟。
   加新功能就**同时加断言**，并且真值要来自独立实现。
3. **如果是"取图"相关的改动**，先读 §3.1（realm）和 §3.3（TIFF/换行/配对）。

### 已知边界 / 下一步

- **多文件 SI 只下第一个**：`plugins/si-fetcher/supplementary.js` 里是 `links[0]`。
  改动很小（循环 + 逐个 `_attachBytes`，浏览器路径 `SiCdp.fetchSi` 要一起改）。
  没当场改的原因是：要先找到一篇真有多条 `mmc` 链接的论文才能验证，
  而 ScienceDirect 现在挡 curl、只能走浏览器 —— **不做没验证过的改动**。
- **`.doc`（老二进制 Word）**：明确不支持取图，只能打开。
- **CCITT 压缩的 TIFF**：没实现（实测数据里没有），遇到会**报错而不是出错图**。
- 浮窗的拖动/缩放/自动收起只有活体验证，没有自动化断言。
