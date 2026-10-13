// scripts/windows-native/patch_extensions.mjs
//
// 读写 Zotero profile 里的 extensions.json（列出已装插件 / 改某个插件的版本号）。
//
// 为什么不用 PowerShell 的 ConvertFrom-Json / ConvertTo-Json：
//   extensions.json 是 Zotero 自己的真实文件，写坏了 Zotero 会认为插件损坏并删掉它。
//   ConvertTo-Json 默认 -Depth 2，深层字段会被截成字符串 —— 这是会真出事的坑。
//   Node 的 JSON.parse/stringify 是无损的，而且「构建插件」本来就必须有 Node。
//
// 用法：
//   node patch_extensions.mjs get <profileDir> <extId>          → 打印版本，没有则打印 '-'
//   node patch_extensions.mjs set <profileDir> <extId> <ver>    → 就地改版本，打印旧值
//   node patch_extensions.mjs list <profileDir>                 → 打印全部 id@version
import fs from "node:fs";
import path from "node:path";

const [cmd, profileDir, arg2, arg3] = process.argv.slice(2);
const FILE = path.join(profileDir ?? "", "extensions.json");

function load() {
  if (!fs.existsSync(FILE)) {
    console.error(`!! 找不到 ${FILE}`);
    process.exit(2);
  }
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    console.error(`!! ${FILE} 不是合法 JSON：${e.message}`);
    process.exit(2);
  }
}

/** 原子替换：先写临时文件再 rename，避免中途崩了留下半个文件 */
function save(data) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, FILE);
}

switch (cmd) {
  case "get": {
    const d = load();
    const hit = (d.addons ?? []).find((a) => a?.id === arg2);
    console.log(hit ? hit.version ?? "-" : "-");
    break;
  }
  case "list": {
    const d = load();
    for (const a of d.addons ?? []) console.log(`${a.id}@${a.version}`);
    break;
  }
  case "set": {
    const d = load();
    const hit = (d.addons ?? []).find((a) => a?.id === arg2);
    if (!hit) {
      console.error(`!! extensions.json 里没有 ${arg2}`);
      process.exit(3);
    }
    const old = hit.version;
    hit.version = arg3;
    hit.updateDate = Date.now();
    delete hit.updateURL; // 免得 Zotero 自己回滚到上游版本
    save(d);
    console.log(`extensions.json: ${old} -> ${arg3}`);
    break;
  }
  default:
    console.error("用法: node patch_extensions.mjs get|set|list ...");
    process.exit(1);
}
