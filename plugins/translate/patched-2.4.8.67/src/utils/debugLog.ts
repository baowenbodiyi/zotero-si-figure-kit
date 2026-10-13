/**
 * ⭐ 补丁：一个极简的调试日志。
 *
 * 为什么需要：插件跑在 Zotero 进程里，`Zotero.debug` 的输出要开「调试输出」才看得到，
 * 排查「缓存到底存了什么 / 查没查到」这类问题时非常费劲。
 * 这里把关键事件往 **Zotero 数据目录** 下的 `zpt-debug.log` 追加一行，随时能读。
 *
 * 上限 60KB 自动截断，不会无限增长。
 */
const LOG_NAME = "zpt-debug.log";
const MAX_BYTES = 60000;
const KEEP_BYTES = 40000;

/**
 * ⭐ 构建标记：每次构建都要改这个字符串。
 *
 * 为什么需要它：2026-10-12 遇到「磁盘上的 XPI 里明明有新代码、
 * `AddonManager` 也报新版本号，但运行时跑的还是旧逻辑」的情况 ——
 * 光看版本号和文件内容都证明不了**运行的是哪份代码**。
 * 带上这一行，日志自己会说出答案。
 */
export const BUILD_TAG = "2.4.8.67+nodrag";

/**
 * ⚠️ 写入必须**串行化**。
 *
 * 这里原先是「读整个文件 → 拼一行 → 整个文件写回」，没有任何排队。
 * 几条日志在同一毫秒里并发时，后来者读到的是**同一份旧内容**，
 * 写回就把先来的那行覆盖掉了 —— 2026-10-12 实测：Word SI 那两条关键日志
 * （「解析 Word SI…」「Figure S3 → Word SI 配到图 image3.tiff」）凭空消失，
 * 而画面上的图明明是取到了。**丢的恰好是排查时最需要的那几行**。
 * 用一个 promise 链把它们排成一队，时间戳在调用时就取（顺序不失真）。
 */
let queue: Promise<void> = Promise.resolve();

async function writeLine(line: string): Promise<void> {
  try {
    // 写到 Zotero 数据目录 —— 插件本来就在那里放兜底缓存，一定可写
    const base = Zotero.DataDirectory?.dir;
    if (!base) return;
    const sep = String(base).includes("\\") ? "\\" : "/";
    const path = `${String(base).replace(/[\\/]+$/, "")}${sep}${LOG_NAME}`;
    let prev = "";
    try {
      prev = String((await Zotero.File.getContentsAsync(path)) || "");
    } catch {
      // 文件不存在（首次）：先落一个空文件，把异常和「读失败」区分开
      prev = "";
    }
    if (prev.length > MAX_BYTES) {
      prev = prev.slice(-KEEP_BYTES);
    }
    await Zotero.File.putContentsAsync(path, `${prev}${line}`);
  } catch {
    /* 日志本身绝不允许影响功能 */
  }
}

export function debugLog(tag: string, message: string): Promise<void> {
  const line = `${new Date().toISOString()} [${tag}] ${message}\n`;
  queue = queue.then(() => writeLine(line));
  return queue;
}
