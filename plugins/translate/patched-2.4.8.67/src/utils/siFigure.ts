/**
 * ⭐ 补丁：把 SI 里那张图**真的取出来**，贴到翻译框旁边的面板里。
 *
 * 需求原话：「需要支撑信息的图，就从支撑信息的文档里把那几个图搞出来，附在旁边」。
 * 第一版做成了「Figure S3 · SI 第 8 页」这种**页码链接** —— 那不是用户要的。这一版直接给图。
 *
 * 怎么取（实测定的）：
 *  - 这些 SI 的**图页恰好只有一张嵌入位图**，且图在上、图注紧贴其下
 *    （page 8: 图占 (85,99)-(530,592)，图注 y=602）。所以「取那页最大的嵌入图」= 那张图。
 *  - 表页是矢量的、没有嵌入图 → 这一版取不到图，面板保留图注 + 页码（不硬塞别的东西）。
 *
 * ⚠️⚠️⚠️ 这条链路踩了三个 realm 的坑，每个都是实测撞出来的，别再走回头路：
 *
 * 1. **pdf.js 跑在另一个 realm**。`ChromeUtils.importESModule` 的模块有**自己的 global**，
 *    那里没有 `navigator`，而 `getDocument` 会读 `navigator.platform` →
 *    `ReferenceError: navigator is not defined`。
 *    改插件的 `globalThis` **完全没用**，必须
 *    `Components.utils.getGlobalForObject(pdfjs)` 拿到模块 global 再补。
 *
 * 2. **字节不能直接跨 realm 递**。插件 sandbox 把 `Uint8Array` 交给模块 realm 的 pdf.js，
 *    对方迭代它时被 Xray 拦下：`Permission denied to access property Symbol.iterator`。
 *    必须 `Components.utils.cloneInto(bytes, moduleGlobal)`。
 *    （⚠️ 同样的代码在 Run JavaScript 沙箱里**能跑通** —— 那个沙箱权限更宽。
 *     所以「探针里成功」**不能**当作「插件里也行」，这轮就是被这一点骗过一次。）
 *
 * 3. **插件 sandbox 是纯 JS 环境**：`canvas` / `Blob` / `CompressionStream` / `btoa`
 *    全都没有（连 `globalThis.WebSocket` 都没有）。所以像素 → PNG **借 reader 窗口的
 *    canvas**（真 zlib、原始分辨率），拿 `data:` URL 喂给 `<img>`；
 *    次选是自编 stored-PNG + 降采样（会糊，只在前一条失败时用）。
 *    ⚠️ 一开始用 `file://` 写盘再引用，在 `resource://` 的 reader 文档里被同源策略拒了
 *    —— 不是 CSP，是 file-URI 的 same-origin 规则，必须走 `data:`。
 *    ⚠️ 更早一版硬用自己的 stored-PNG 全尺寸，结果 dataURL 128 万字符直接把面板撑爆，
 *    只能降采样到 560 px，所以"清晰度很差"—— 现在这条路只是兜底。
 *
 * 4. **Word 版 SI（`.docx`）走完全不同的路**（见 `utils/docx.ts` / `utils/tiff.ts`）：
 *    SI 是 Word 时没有页、pdf.js 也读不了，图在 `word/media/*.tiff` 里，
 *    解出来是 **LZW+Predictor2 的 TIFF**，浏览器不能渲染，必须先解成 RGBA 再走同一条
 *    canvas → PNG 的路。29 张真 TIFF 已对 PIL 逐字节验过。
 */
import { debugLog } from "./debugLog";
import { downscaleBox, encodePngRgba, toBase64 } from "./pngEncode";
import { decodeTiff } from "./tiff";
import { getSiDocx } from "./siRefs";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 展示宽度上限：再大也没意义，PNG 用 stored 块会跟着变大 */
const MAX_DISPLAY_W = 560;
/** 矢量页整页渲染的倍率 */
const PAGE_RENDER_SCALE = 1.7;
/** 缓存上限：只留最近用过的几篇，别让整本 PDF 常驻内存 */
const DOC_CACHE_MAX = 3;

let pdfjs: any = null;
let cacheDirReady: Promise<string | null> | null = null;

/** 每篇 SI 的 pdf.js document（Promise 形式，避免并发重复解析） */
const docCache = new Map<number, Promise<any>>();
/** `${itemId}:${pageIndex}` → file:// URL（或 null） */
const figCache = new Map<string, Promise<string | null>>();

function g(): any {
  return globalThis as any;
}

/**
 * 载入 pdf.js 并把那个 realm 需要的东西补齐。失败返回 null（整条取图链路静默降级）。
 */
function ensurePdfjs(): any {
  if (pdfjs) {
    return pdfjs;
  }
  try {
    pdfjs = g().ChromeUtils.importESModule(
      "resource://zotero/reader/pdf/build/pdf.mjs",
    );
    // 坑 1：模块 realm 里没有 navigator
    try {
      const moduleGlobal = g().Components.utils.getGlobalForObject(pdfjs);
      if (moduleGlobal && typeof moduleGlobal.navigator === "undefined") {
        moduleGlobal.navigator = {
          platform: "Win32",
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          language: "en-US",
          languages: ["en-US"],
          hardwareConcurrency: 8,
        };
        void debugLog("si", "已在 pdf.js 的 module global 上补 navigator");
      }
    } catch (e) {
      void debugLog("si", `补 module global navigator 失败: ${e}`);
    }
    try {
      pdfjs.GlobalWorkerOptions.workerSrc =
        "resource://zotero/reader/pdf/build/pdf.worker.mjs";
    } catch (e) {
      void debugLog("si", `设置 workerSrc 失败（不致命）: ${e}`);
    }
    void debugLog("si", `pdf.js 载入成功 getDocument=${typeof pdfjs.getDocument}`);
  } catch (e) {
    void debugLog("si", `pdf.js 载入失败: ${e}`);
    pdfjs = null;
  }
  return pdfjs;
}

/** 图库目录（数据目录下），确保存在 */
function ensureCacheDir(): Promise<string | null> {
  if (cacheDirReady) {
    return cacheDirReady;
  }
  cacheDirReady = (async () => {
    try {
      const base = Zotero.DataDirectory?.dir;
      if (!base) {
        return null;
      }
      const sep = String(base).includes("\\") ? "\\" : "/";
      const dir = `${String(base).replace(/[\\/]+$/, "")}${sep}si-figures`;
      await g().IOUtils.makeDirectory(dir, { ignoreExisting: true });
      void debugLog("si", `插图目录: ${dir}`);
      return dir;
    } catch (e) {
      void debugLog("si", `建插图目录失败: ${e}`);
      return null;
    }
  })();
  return cacheDirReady;
}

/** 拿一篇 SI 的 pdf.js document */
async function getDoc(item: Zotero.Item): Promise<any> {
  const hit = docCache.get(item.id);
  if (hit) {
    return hit;
  }
  const job = (async () => {
    const lib = ensurePdfjs();
    if (!lib) {
      return null;
    }
    const path = await item.getFilePathAsync();
    const raw = (await g().IOUtils.read(path)) as Uint8Array;
    void debugLog("si", `读 SI PDF: ${raw.length} 字节`);

    // 坑 2：字节要 clone 进模块 realm，否则 pdf.js 迭代它会被 Xray 拦
    let data: any = raw;
    try {
      const moduleGlobal = g().Components.utils.getGlobalForObject(lib);
      data = g().Components.utils.cloneInto(raw, moduleGlobal);
      void debugLog("si", `cloneInto 到模块 realm 成功: ${data.length} 字节`);
    } catch (e) {
      void debugLog("si", `cloneInto 失败，退回原始数组: ${e}`);
    }

    const doc = await lib.getDocument({
      data,
      isEvalSupported: false,
      useWorkerFetch: false,
      // 关掉 OffscreenCanvas：要 raw 像素（`{data, kind}`），不要跨 realm 的 ImageBitmap
      isOffscreenCanvasSupported: false,
    }).promise;
    void debugLog("si", `getDocument 成功，共 ${doc.numPages} 页`);
    return doc;
  })();
  docCache.set(item.id, job);
  while (docCache.size > DOC_CACHE_MAX) {
    const oldest = docCache.keys().next().value as number | undefined;
    if (oldest === undefined) {
      break;
    }
    docCache.delete(oldest);
  }
  return job;
}

/** 取这一页里最大的嵌入图（= 那张插图）。没有可用原始像素就返回 null。 */
async function pickEmbeddedImage(page: any, tag: string): Promise<any | null> {
  const lib = pdfjs;
  const ops = await page.getOperatorList();
  const names: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    if (ops.fnArray[i] === lib.OPS.paintImageXObject) {
      names.push(String(ops.argsArray[i][0]));
    }
  }
  void debugLog(
    "si",
    `${tag} paintImageXObject × ${names.length} [${names.join(",")}]`,
  );

  let best: any = null;
  for (const name of names) {
    let img: any = null;
    try {
      img = await new Promise((res) => page.objs.get(name, res));
    } catch (e) {
      void debugLog("si", `${tag} objs.get(${name}) 失败: ${e}`);
      continue;
    }
    if (!img) {
      void debugLog("si", `${tag} objs.get(${name}) → null`);
      continue;
    }
    let info = "";
    try {
      info =
        `${img.width}x${img.height} kind=${img.kind}` +
        ` data=${img.data ? img.data.length : String(img.data)}` +
        ` bitmap=${img.bitmap ? "yes" : "no"}`;
    } catch (e) {
      info = `读属性失败: ${e}`;
    }
    void debugLog("si", `${tag}   ${name}: ${info}`);
    // 没有原始像素就用不了（插件里没有 canvas）
    if (!img.data || !img.width || !img.height) {
      continue;
    }
    if (!best || img.width * img.height > best.width * best.height) {
      best = img;
    }
  }
  return best;
}

/** pdf.js 的原始像素 → 插件 realm 的 RGBA（逐元素拷贝，别用 set/构造器跨 realm 迭代） */
function toRgba(img: any): Uint8ClampedArray | null {
  const lib = pdfjs;
  const w = img.width;
  const h = img.height;
  const src = img.data as Uint8ClampedArray | Uint8Array | null;
  if (!src) {
    return null;
  }
  const isRgba = img.kind === lib.ImageKind.RGBA_32BPP;
  const isRgb = img.kind === lib.ImageKind.RGB_24BPP;
  if (!isRgba && !isRgb) {
    void debugLog("si", `跳过不支持的图像类型 kind=${img.kind}`);
    return null;
  }
  const n = w * h;
  const rgba = new Uint8ClampedArray(n * 4);
  if (isRgba) {
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      rgba[k] = src[k];
      rgba[k + 1] = src[k + 1];
      rgba[k + 2] = src[k + 2];
      rgba[k + 3] = src[k + 3];
    }
  } else {
    for (let i = 0; i < n; i++) {
      const k = i * 3;
      const j = i * 4;
      rgba[j] = src[k];
      rgba[j + 1] = src[k + 1];
      rgba[j + 2] = src[k + 2];
      rgba[j + 3] = 255;
    }
  }
  return rgba;
}

/** 路径 → file:// URL（数据目录里有中文，必须走 newFileURI 转义） */
function pathToFileUrl(path: string): string {
  try {
    const file = Zotero.File.pathToFile(path);
    return g().Services.io.newFileURI(file).spec;
  } catch (e) {
    void debugLog("si", `pathToFileUrl 失败: ${e}`);
    return "file:///" + path.replace(/\\/g, "/");
  }
}

/**
 * PNG 字节 → `data:image/png;base64,...`
 *
 * 为什么不直接用落盘的 `file://`：**实测加载失败**。reader 文档的源是
 * `resource://zotero/reader/reader.html`，Firefox 的 file-URI 同源策略
 * 不允许非 file 源读 `file://`（不是 CSP 的问题）。`data:` 没这个限制。
 *
 * base64 优先借主窗口的 `btoa`（**字符串**跨 realm 没问题，不会踩 Xray）；
 * 拿不到就退回自己实现的那份。
 */
function pngToDataUrl(png: Uint8Array): string {
  let b64 = "";
  try {
    const win = Zotero.getMainWindow() as unknown as {
      btoa?: (s: string) => string;
    } | null;
    if (win && typeof win.btoa === "function") {
      let bin = "";
      const CHUNK = 8192;
      for (let i = 0; i < png.length; i += CHUNK) {
        const slice = png.subarray(i, Math.min(i + CHUNK, png.length));
        bin += String.fromCharCode.apply(null, Array.from(slice));
      }
      b64 = win.btoa(bin);
    }
  } catch (e) {
    void debugLog("si", `借主窗口 btoa 失败，改用内置 base64: ${e}`);
  }
  if (!b64) {
    b64 = toBase64(png);
  }
  return `data:image/png;base64,${b64}`;
}

/**
 * ⭐ 矢量图 / 表格页：把**整页**渲染成图。
 *
 * 为什么单独一条路：表格页和部分插图是**矢量**的，没有可提取的嵌入位图
 * （实测 Table S2/S4 那几页 `paintImageXObject` 一个都没有），
 * 只能真渲染页面 —— 而渲染要 canvas。
 *
 * 这次不再踩 Xray：**用 reader 内层窗口自己的 pdf.js**（`inner.pdfjsLib`），
 * 字节 `cloneInto` 进去，canvas 也从那个窗口建 ——
 * `getDocument` / `page.render` / `getContext` 全在**同一个 realm** 里，没有任何跨域访问。
 *
 * ⚠️ `_internalReader._primaryView._iframeWindow` 是 Zotero 内部字段
 * （Zotero 自己的 reader.js 也这么用），拿不到就返回 null 走降级。
 */
/**
 * ⭐ 矢量图 / 表格页：用 **reader 窗口自己的 pdf.js** 把整页渲染成图。
 *
 * 为什么必须"整段都在 reader realm 里跑"（这轮踩的第四个 realm 坑）：
 *  - 渲染要用 `Path2D`，而 **module realm 里没有 DOM、没有 Path2D** → 模块那套 pdf.js 渲染不了；
 *  - 所以只能用 reader 窗口里的 `pdfjsLib`。但把它的对象拿回插件 realm 用会连撞两次：
 *      ① 参数对象是插件 realm 的 → pdf.js 读不到属性，报 `no \`url\` parameter provided`；
 *      ② 修了 ① 之后，`getDocument()` 返回的**类实例跨 realm 后原型方法读不到**
 *         → 报 `pdf.getPage is not a function`。
 *  - 解法：用**那个 realm 的 `Function` 构造器**造一个函数，把整段流程写进去 ——
 *    于是 `getDocument` / `getPage` / `getContext` / `render` 全在 reader realm 内完成，
 *    插件只递进一个数字、拿回一个字符串。代码字符串是我们自己写死的，不含任何用户输入。
 */
async function renderPageViaReader(
  doc: Document,
  item: Zotero.Item,
  pageIndex: number,
  tag: string,
): Promise<string | null> {
  try {
    const readers = (Zotero.Reader as any)._readers || [];
    const r =
      readers.find((x: any) => {
        try {
          return x._iframeWindow && x._iframeWindow.document === doc;
        } catch {
          return false;
        }
      }) || readers[0];
    const inner: any = r?._internalReader?._primaryView?._iframeWindow;
    const lib = inner?.pdfjsLib;
    if (!lib || typeof lib.getDocument !== "function") {
      void debugLog("si", `${tag} 拿不到 reader 内层窗口的 pdfjsLib，无法整页渲染`);
      return null;
    }

    const path = await item.getFilePathAsync();
    const raw = (await g().IOUtils.read(path)) as Uint8Array;
    // 字节也要是 reader realm 的原生对象（同 ①，否则 pdf.js 不认）
    const U8 = inner.Uint8Array;
    const data = new U8(raw.length);
    for (let i = 0; i < raw.length; i++) {
      data[i] = raw[i];
    }
    void debugLog("si", `${tag} 已在 reader realm 备好 ${raw.length} 字节`);

    const runner: any = new inner.Function(
      "lib",
      "data",
      "pageIndex",
      "scale",
      `return (async () => {
        const pdf = await lib.getDocument({
          data: data,
          isEvalSupported: false,
          useWorkerFetch: false,
        }).promise;
        const page = await pdf.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: scale });
        const cv = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
        cv.width = Math.round(viewport.width);
        cv.height = Math.round(viewport.height);
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, cv.width, cv.height);
        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
        return cv.toDataURL("image/png");
      })();`,
    );
    const url: string = await runner(lib, data, pageIndex, PAGE_RENDER_SCALE);
    void debugLog(
      "si",
      `${tag} 矢量/表格页整页渲染成功，dataURL ${url ? url.length : 0} 字符`,
    );
    return url || null;
  } catch (e) {
    void debugLog("si", `${tag} 整页渲染失败: ${e}`);
    return null;
  }
}

/**
 * ⭐ 用 **reader 窗口自己的 canvas** 编 PNG —— 这一步换来的是**真 zlib 压缩**。
 *
 * 为什么绕这一下：插件 sandbox 里没有 canvas，也没有 `CompressionStream`，
 * 自己编 PNG 只能用 deflate 的 **stored（不压缩）块**，于是体积约为「宽×高×4」，
 * 逼得我按 560px 降采样才敢塞进 data URL —— **结果就是用户说的「清晰度很差」**。
 *
 * 之前借 canvas 撞 Xray（`Permission denied ... Symbol.iterator`）是因为
 * **直接把插件 realm 的数组递过去了**。正确做法是先 `cloneInto` 到 reader 窗口那个 realm，
 * 之后 `new win.ImageData(...)` / `putImageData` / `toDataURL` 全在**同一个 realm** 里，
 * 不再有任何跨域访问。
 *
 * 收益：**不再降采样**（用原始分辨率，显示时由浏览器高质量缩放），
 * 而且体积比 stored PNG 小一个数量级 → 又清晰又小。
 */
function pixelsToPngViaWindow(
  doc: Document,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
): string | null {
  try {
    const win = doc.defaultView as any;
    if (!win || typeof win.ImageData !== "function" || !win.document) {
      void debugLog("si", "reader 窗口没有 ImageData，跳过 canvas 路径");
      return null;
    }
    // cloneInto：把像素变成 reader realm 自己的数组（跨域问题的根就在这里）
    const local = g().Components.utils.cloneInto(rgba, win);
    const cv = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas",
    );
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.putImageData(new win.ImageData(local, w, h), 0, 0);
    const url: string = cv.toDataURL("image/png");
    void debugLog(
      "si",
      `canvas 真 PNG（不降采样）：${w}x${h}，dataURL ${url.length} 字符`,
    );
    return url;
  } catch (e) {
    void debugLog("si", `走 reader 窗口 canvas 失败，退回自编 PNG: ${e}`);
    return null;
  }
}

/** 按魔数认图片类型（`<img>` 能直接吃的就直传，不能吃的才解码） */
function sniffMime(raw: Uint8Array): string | null {
  if (raw.length < 4) {
    return null;
  }
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47) {
    return "image/png";
  }
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    return "image/jpeg";
  }
  if (raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46) {
    return "image/gif";
  }
  if (raw[0] === 0x42 && raw[1] === 0x4d) {
    return "image/bmp";
  }
  if (raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46) {
    return "image/webp";
  }
  return null;
}

/**
 * Word SI：从 `.docx` 里取出指定媒体并变成 `data:` URL。
 *
 * 实测这些 SI 的图是 **TIFF**，Firefox 的 `<img>` 渲染不了 `image/tiff`，
 * 所以必须 `decodeTiff` → RGBA → 借 reader 窗口的 canvas 编成真 PNG。
 */
async function getDocxFigure(
  doc: Document,
  item: Zotero.Item,
  media: string,
  tag: string,
): Promise<string | null> {
  const t0 = Date.now();
  const parsed = await getSiDocx(item);
  if (!parsed) {
    return null;
  }
  const rel = parsed.mediaPath.get(media);
  if (!rel) {
    void debugLog("si", `${tag}: docx 里没有 ${media}`);
    return null;
  }
  const raw = parsed.read(rel);
  if (!raw) {
    void debugLog("si", `${tag}: 读不到 ${rel}`);
    return null;
  }

  const isTiff =
    (raw[0] === 0x49 && raw[1] === 0x49) || (raw[0] === 0x4d && raw[1] === 0x4d);
  if (isTiff) {
    const img = decodeTiff(raw);
    void debugLog(
      "si",
      `${tag}: TIFF 解码 ${img.width}x${img.height}（${Date.now() - t0} ms）`,
    );
    const sharp = pixelsToPngViaWindow(doc, img.rgba, img.width, img.height);
    if (sharp) {
      return sharp;
    }
    const ds = downscaleBox(img.rgba, img.width, img.height, MAX_DISPLAY_W);
    void debugLog("si", `${tag}: 退回自编 PNG ${ds.w}x${ds.h}`);
    return pngToDataUrl(encodePngRgba(ds.rgba, ds.w, ds.h));
  }

  // PNG/JPEG/GIF/BMP/WebP：`<img>` 自己能开，直传即可（不用解码，无损也不慢）
  const mime = sniffMime(raw);
  if (!mime) {
    void debugLog("si", `${tag}: 不认识的图片格式，前 8 字节 ${raw.subarray(0, 8)}`);
    return null;
  }
  void debugLog(
    "si",
    `${tag}: 已可直接显示（${mime}，${raw.length} 字节，${Date.now() - t0} ms）`,
  );
  return `data:${mime};base64,${toBase64(raw)}`;
}

/**
 * 取某个 SI 里的插图，返回可直接给 `<img src>` 的 `data:` URL；取不到返回 null。
 *
 * · PDF SI：传 `pageIndex`，`media` 留空
 * · Word SI：`pageIndex` 传 -1，`media` 传 `word/media/` 下的文件名
 * 结果按 `attId:page` / `attId:w:media` 缓存（面板每次重渲染都会问）。
 */
export function getSiFigure(
  attachmentId: number,
  pageIndex: number,
  doc: Document,
  media?: string | null,
): Promise<string | null> {
  const jobKey = media ? `${attachmentId}:w:${media}` : `${attachmentId}:${pageIndex}`;
  const hit = figCache.get(jobKey);
  if (hit) {
    return hit;
  }
  const job = (async () => {
    const tag = media ? `Word SI ${media}` : `SI 第 ${pageIndex + 1} 页`;
    let step = "开始";
    try {
      const item = Zotero.Items.get(attachmentId);
      if (!item) {
        return null;
      }
      if (media) {
        step = "docxFigure";
        return await getDocxFigure(doc, item, media, tag);
      }
      const dir = await ensureCacheDir();
      const sep = dir && dir.includes("\\") ? "\\" : "/";
      const file = dir ? `${dir}${sep}${item.key}-p${pageIndex + 1}.png` : "";

      step = "getDoc";
      const pdf = await getDoc(item);
      if (!pdf) {
        return null;
      }
      step = "getPage";
      const page = await pdf.getPage(pageIndex + 1);
      step = "pickEmbeddedImage";
      const embedded = await pickEmbeddedImage(page, tag);
      if (!embedded) {
        // 矢量图 / 表格：没有嵌入位图，改成整页渲染
        void debugLog("si", `${tag} 没有嵌入位图，尝试整页渲染`);
        return await renderPageViaReader(doc, item, pageIndex, tag);
      }
      step = "toRgba";
      const rgba = toRgba(embedded);
      if (!rgba) {
        return null;
      }
      // ── 首选：走 reader 窗口的 canvas（真 zlib 压缩、**原始分辨率**、最清晰）
      step = "canvasPng";
      const sharp = pixelsToPngViaWindow(
        doc,
        rgba,
        embedded.width,
        embedded.height,
      );
      if (sharp) {
        return sharp;
      }

      // ── 兜底：自编 stored PNG。没压缩，所以必须降采样，会糊（仅在前一条失败时用）
      step = "downscale";
      const ds = downscaleBox(
        rgba,
        embedded.width,
        embedded.height,
        MAX_DISPLAY_W,
      );
      step = "encodePng";
      const png = encodePngRgba(ds.rgba, ds.w, ds.h);
      // 顺手落盘一份：便于排查，也让用户能在数据目录里找到这些图
      if (file) {
        try {
          await g().IOUtils.write(file, png);
        } catch (e) {
          void debugLog("si", `${tag} 落盘失败（不影响显示）: ${e}`);
        }
      }
      step = "toDataUrl";
      const url = pngToDataUrl(png);
      void debugLog(
        "si",
        `${tag} 退回自编 PNG：${embedded.width}x${embedded.height} → ${ds.w}x${ds.h}，` +
          `PNG ${png.length} 字节，dataURL ${url.length} 字符`,
      );
      return url;
    } catch (e) {
      // 把**卡在哪一步**写进日志 —— 跨 realm 的坑每修一层就冒一个，没有这个很难查
      void debugLog("si", `${tag} 取图失败（步骤 ${step}）: ${e}`);
      return null;
    }
  })();
  figCache.set(jobKey, job);
  return job;
}
