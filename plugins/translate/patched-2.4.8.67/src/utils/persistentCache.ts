/**
 * Persistent translation memory (a.k.a. 翻译记忆 / 持久化缓存).
 *
 * 与插件自带的内存缓存不同：
 *  - 自带缓存存在 `addon.data.translate.queue`，是**运行时状态**，Zotero 一重启就没了；
 *  - 这里把译文**写到文献附件所在目录**下的 `translations.json`，
 *    于是译文跟着 PDF 走——重启、换机器、同步、备份都还在，同一段文字不再重复请求 API。
 *
 * 文件格式：
 *   { "v": 1, "entries": { "<key>": { r: 译文, s: 服务, f: 源语言, t: 目标语言, at: 时间戳 } } }
 *
 * 未挂附件的条目（例如只翻标题）退化为 Zotero 数据目录下的一个总文件。
 */
import { getPref } from "./prefs";

export type CacheEntry = {
  r: string;
  s: string;
  f: string;
  t: string;
  at: number;
  /**
   * ⭐ 补丁：这条记忆对应的**源文**（句子级记忆才写）。
   *
   * 有它才能支持「选中的是半句 → 返回包含它的那一整句译文」：
   * 只有译文没法做包含匹配。为控制体积，**只给句子级条目录 q**，整段条目留空。
   */
  q?: string;
};

type CacheFile = { v: number; entries: Record<string, CacheEntry> };

const FILE_NAME = "translations.json";
const FALLBACK_FILE_NAME = "zotero-pdf-translate-cache.json";
const MAX_ENTRIES_PER_FILE = 5000;
/** 太长的文本（如整页 OCR 结果）不进缓存，避免文件膨胀 */
const MAX_RAW_LENGTH = 4000;
const FLUSH_DELAY_MS = 1000;

/** FNV-1a 32bit。取两个不同种子拼成 64bit 级别的键，降低碰撞概率。 */
function fnv1a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function hex8(n: number): string {
  return n.toString(16).padStart(8, "0");
}

/** 与平台无关地取父目录，并保持原有分隔符风格（Windows 必须保持反斜杠）。 */
function dirNameOf(filePath: string): string {
  const sep = filePath.includes("\\") ? "\\" : "/";
  const idx = filePath.lastIndexOf(sep);
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}${name}`;
}

class PersistentCache {
  /** 已加载的缓存文件：路径 → 内容 */
  private files = new Map<string, CacheFile>();
  /** 待写盘的路径 */
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 简单统计，便于排查 */
  public stats = { hits: 0, misses: 0, writes: 0, errors: 0 };

  public async get(
    path: string,
    key: string,
  ): Promise<CacheEntry | undefined> {
    const file = await this.load(path);
    const hit = file.entries[key];
    if (hit) {
      this.stats.hits++;
    } else {
      this.stats.misses++;
    }
    return hit;
  }

  public async set(
    path: string,
    key: string,
    entry: CacheEntry,
  ): Promise<void> {
    const file = await this.load(path);
    file.entries[key] = entry;
    this.dirty.add(path);
    this.scheduleFlush();
  }

  /** ⭐ 补丁：取出某个缓存文件里的全部条目（句子级包含匹配要用） */
  public async all(path: string): Promise<CacheEntry[]> {
    const file = await this.load(path);
    return Object.values(file.entries);
  }

  private async load(path: string): Promise<CacheFile> {
    const cached = this.files.get(path);
    if (cached) {
      return cached;
    }
    let file: CacheFile = { v: 1, entries: {} };
    try {
      const text = (await Zotero.File.getContentsAsync(path)) as
        | string
        | false;
      if (text) {
        const parsed = JSON.parse(text) as CacheFile;
        if (parsed && parsed.v === 1 && parsed.entries) {
          file = parsed;
        }
      }
    } catch {
      // 文件不存在是正常情况（首次翻译）
    }
    this.files.set(path, file);
    return file;
  }

  private scheduleFlush(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  public async flush(): Promise<void> {
    for (const path of Array.from(this.dirty)) {
      const file = this.files.get(path);
      if (!file) {
        this.dirty.delete(path);
        continue;
      }
      try {
        const keys = Object.keys(file.entries);
        if (keys.length > MAX_ENTRIES_PER_FILE) {
          // 超限时按时间淘汰最旧的
          keys.sort((a, b) => file.entries[a].at - file.entries[b].at);
          for (const k of keys.slice(0, keys.length - MAX_ENTRIES_PER_FILE)) {
            delete file.entries[k];
          }
        }
        await Zotero.File.putContentsAsync(path, JSON.stringify(file));
        this.dirty.delete(path);
        this.stats.writes++;
      } catch (e) {
        this.stats.errors++;
        Zotero.debug(`[pdf-translate] failed to persist cache: ${e}`);
      }
    }
  }

  /** 只清内存里的副本，用于测试/排查 */
  public reset(): void {
    this.files.clear();
    this.dirty.clear();
  }
}

export const persistentCache = new PersistentCache();

/** 求出这条任务应当把译文写进哪个文件。返回 null 表示无处可写（不缓存）。 */
export async function resolveCachePath(
  itemId: number | undefined,
): Promise<string | null> {
  if (!itemId) {
    return fallbackCachePath();
  }
  const item = Zotero.Items.get(itemId);
  if (!item) {
    return fallbackCachePath();
  }
  let attachment: Zotero.Item | null = null;
  if (item.isAttachment()) {
    attachment = item;
  } else {
    for (const id of item.getAttachments()) {
      const child = Zotero.Items.get(id);
      if (child && child.attachmentContentType === "application/pdf") {
        attachment = child;
        break;
      }
    }
  }
  if (!attachment) {
    return fallbackCachePath();
  }
  try {
    const filePath = (await attachment.getFilePathAsync()) as string | null;
    if (!filePath) {
      return fallbackCachePath();
    }
    return joinPath(dirNameOf(filePath), FILE_NAME);
  } catch {
    return fallbackCachePath();
  }
}

function fallbackCachePath(): string | null {
  const dir = Zotero.DataDirectory?.dir;
  if (!dir) {
    return null;
  }
  return joinPath(dir, FALLBACK_FILE_NAME);
}

/** 是否值得缓存：开关打开 + 有文本 + 文本不过长 */
export function isCacheable(raw: string | undefined): boolean {
  if (!(getPref("enablePersistentCache") as boolean)) {
    return false;
  }
  if (!raw) {
    return false;
  }
  return raw.length > 0 && raw.length <= MAX_RAW_LENGTH;
}

/**
 * ⭐ 补丁：翻译「配方」指纹。
 *
 * 为什么必须有：缓存键原本只看 `服务|源语言|目标语言|原文`，
 * 于是**改了提示词之后，旧译文照样命中缓存**——用户看到的现象就是
 * 「我把提示词改成要求输出 LaTeX 了，角标还是没变」，其实是根本没重新翻译。
 *
 * 把决定输出形态的那几个 pref 一起揉进键里：任何一项变了，旧记忆自动失效，
 * 下次划词会重新请求 API。
 */
const RECIPE_PREF_KEYS = [
  "prompt",
  "systemPrompt",
  "model",
  "temperature",
  "customParams",
  "endPoint",
  "thinkingLevel",
  "maxTokens",
  "stream",
  "topP",
];

/**
 * @param extra 额外的失效因子。**任务级提示词（`task.promptOverride`）必须从这儿进来** ——
 *   否则改了图注专用提示词，缓存键不变，会一直命中旧译文
 *   （和当初「改了全局提示词却还是旧译文」是同一个坑）。
 */
export function serviceRecipe(service: string, extra?: string): string {
  // ⚠️ 服务 id 与 pref 前缀的大小写不一定一致：
  // `task.service` 是 `customgpt1`，而 pref 前缀是 `customGPT1`
  // （gpt.ts 里 `id.replace("gpt", "GPT")`）。两种都试一遍，取到哪个算哪个。
  const prefixes = [service];
  for (const variant of [
    service.replace("gpt", "GPT"),
    service.replace("GPT", "gpt"),
  ]) {
    if (!prefixes.includes(variant)) {
      prefixes.push(variant);
    }
  }

  const parts: string[] = [];
  for (const key of RECIPE_PREF_KEYS) {
    for (const prefix of prefixes) {
      let value: unknown;
      try {
        value = getPref(`${prefix}.${key}`);
      } catch (e) {
        value = undefined;
      }
      if (value !== undefined && value !== null && value !== "") {
        parts.push(`${prefix}.${key}=${String(value)}`);
      }
    }
  }
  if (extra) {
    parts.push(`override=${extra}`);
  }
  if (!parts.length) {
    return "0";
  }
  return hex8(fnv1a(parts.join("\u0001"), 0x9e3779b9));
}

/** 缓存键：同一服务 + 同一对语言 + 同一份配方 + 同一段原文 → 同一条记忆 */
export function cacheKeyFor(task: {
  raw: string;
  service: string;
  langfrom?: string;
  langto?: string;
  promptOverride?: string;
}): string {
  const from = task.langfrom || "";
  const to = task.langto || "";
  const recipe = serviceRecipe(task.service, task.promptOverride);
  const a = hex8(
    fnv1a(`${task.service}|${from}|${to}|${recipe}|${task.raw}`, 0x811c9dc5),
  );
  const b = hex8(
    fnv1a(`${task.raw}|${recipe}|${to}|${from}|${task.service}`, 0x01000193),
  );
  return `${task.raw.length.toString(36)}-${a}${b}`;
}
