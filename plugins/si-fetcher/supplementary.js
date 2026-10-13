/**
 * supplementary.js —— 取 Supporting Information 并挂到条目下（改造版）
 *
 * 与上游 `Israfil-Hossen/zotero-supplementary-downloader` v1.3.0 的差别：
 *
 *  1. **默认走用户浏览器**（`si-cdp.js`）：出版社普遍上 Cloudflare，
 *     Zotero 自己的 HTTP 客户端一律 403；借浏览器会话才能过。
 *     浏览器路径失败时**回退**到原来的直连抓页面（开放出版社仍可用）。
 *  2. **附件名以 `[SI]` 开头**，并打 `SI` 标签 —— 便于和正文区分，
 *     也便于「点译文里的 Figure S18 跳到 SI 那一页」那类功能靠名字认出来。
 *  3. 取到的字节直接落临时文件再 `importFromFile`，**不依赖浏览器下载目录**。
 *
 * 保留上游的东西：右键菜单、批量、可选的外部文件夹归档、彩色标签。
 */

SupplementaryDownloader = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  addedElementIDs: [],
  /** 浏览器路径要不要用；关掉就退回纯直连 */
  USE_BROWSER: true,

  init: function (a) {
    if (this.initialized) return;
    this.id = a.id;
    this.version = a.version;
    this.rootURI = a.rootURI;
    this.initialized = true;
    // 方便排查与自动化：菜单之外也能调用（Run JavaScript 里 Zotero.SupplementaryDownloader）
    try {
      Zotero.SupplementaryDownloader = this;
    } catch (e) {}
    Zotero.debug("[SupplDL] Initialized v" + a.version);
  },

  addToWindow: function (win) {
    var doc = win.document;

    var mi = doc.createXULElement("menuitem");
    mi.id = "suppl-dl-menuitem";
    mi.setAttribute("label", "获取 Supporting Information（走浏览器）");
    mi.addEventListener("command", function () {
      SupplementaryDownloader.downloadForSelected();
    });
    var menu = doc.getElementById("zotero-itemmenu");
    if (menu) menu.appendChild(mi);
    this.addedElementIDs.push(mi.id);

    var toolsMenu = doc.getElementById("menu_ToolsPopup");
    if (toolsMenu) {
      var sep = doc.createXULElement("menuseparator");
      sep.id = "suppl-dl-separator";
      toolsMenu.appendChild(sep);
      this.addedElementIDs.push(sep.id);

      var folderMi = doc.createXULElement("menuitem");
      folderMi.id = "suppl-dl-set-folder";
      folderMi.setAttribute("label", "设置 SI 归档文件夹…");
      folderMi.addEventListener("command", function () {
        SupplementaryDownloader.chooseFolder(win);
      });
      toolsMenu.appendChild(folderMi);
      this.addedElementIDs.push(folderMi.id);
    }
    Zotero.debug("[SupplDL] 菜单已挂载");
  },

  addToAllWindows: function () {
    var wins = Zotero.getMainWindows();
    for (var i = 0; i < wins.length; i++) {
      if (!wins[i].ZoteroPane) continue;
      this.addToWindow(wins[i]);
    }
  },

  removeFromWindow: function (win) {
    var doc = win.document;
    for (var i = 0; i < this.addedElementIDs.length; i++) {
      var el = doc.getElementById(this.addedElementIDs[i]);
      if (el) el.remove();
    }
  },

  removeFromAllWindows: function () {
    var wins = Zotero.getMainWindows();
    for (var i = 0; i < wins.length; i++) {
      this.removeFromWindow(wins[i]);
    }
  },

  /* ------------------------------------------------------------------ */

  downloadForSelected: async function () {
    var zp = Zotero.getActiveZoteroPane();
    var items = zp.getSelectedItems();
    if (!items || !items.length) {
      this._toast("没有选中条目");
      return;
    }
    var total = 0;
    var failures = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.isAttachment() || item.isNote()) continue;
      try {
        total += await this._processItem(item);
      } catch (e) {
        failures.push(String(item.getField("title")).slice(0, 30) + "：" + e.message);
        Zotero.debug("[SupplDL] 失败: " + e);
      }
    }
    if (failures.length) {
      this._toast("失败 " + failures.length + " 条\n" + failures.join("\n"), 8000);
    } else {
      this._toast(
        total > 0 ? "完成，拿到 " + total + " 个 SI 文件" : "没找到 Supplementary Information",
      );
    }
  },

  _toast: function (text, ms) {
    try {
      var pw = new Zotero.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline("Supporting Information");
      pw.addDescription(text);
      pw.show();
      pw.startCloseTimer(ms || 4000);
    } catch (e) {
      Zotero.debug("[SupplDL] toast 失败: " + e);
    }
  },

  /** 条目 → 论文页面 URL */
  _resolveURL: function (item) {
    var url = String(item.getField("url") || "").trim();
    if (url) return url;
    var doi = String(item.getField("DOI") || "").trim();
    if (doi) return "https://doi.org/" + encodeURI(doi);
    return "";
  },

  _processItem: async function (item) {
    var url = this._resolveURL(item);
    if (!url) {
      throw new Error("没有 URL 或 DOI 字段");
    }
    Zotero.debug("[SupplDL] 处理: " + url);

    // ① 优先走浏览器（唯一能过 Cloudflare 的路）
    if (this.USE_BROWSER && typeof SiCdp !== "undefined") {
      try {
        var got = await SiCdp.fetchSi(url, function (msg) {
          Zotero.debug("[SupplDL] " + msg);
        });
        Zotero.debug("[SupplDL] 浏览器取到 " + got.bytes.length + " 字节");
        await this._attachBytes(item, got.bytes, got.filename);
        return 1;
      } catch (e) {
        Zotero.debug("[SupplDL] 浏览器路径失败，回退直连: " + e.message);
      }
    }

    // ② 回退：直连抓页面（开放出版社能过）
    return await this._processDirect(item, url);
  },

  /** 老路子：Zotero.HTTP 直接抓页面 + 正则找链接 */
  _processDirect: async function (item, url) {
    var r = await Zotero.HTTP.request("GET", url, {
      timeout: 30000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      successCodes: false,
    });
    if (!r || r.status >= 400) {
      throw new Error(
        "直连被拒 HTTP " + (r ? r.status : "无响应") + "（多半是反爬，需要走浏览器）",
      );
    }
    var links = this._extractLinks(r.responseText || "");
    if (!links.length) {
      throw new Error("直连页面里没找到 SI 链接");
    }
    var dl = await Zotero.HTTP.request("GET", links[0].url, {
      responseType: "arraybuffer",
      timeout: 60000,
      successCodes: false,
    });
    if (!dl || dl.status >= 400) {
      throw new Error("下载被拒 HTTP " + (dl ? dl.status : "无响应"));
    }
    await this._attachBytes(item, new Uint8Array(dl.response), links[0].filename);
    return 1;
  },

  _extractLinks: function (html) {
    var out = [];
    var seen = {};
    var re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var href = m[1];
      var text = m[2]
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!/^https?:/i.test(href)) continue;
      if (href.indexOf("#") !== -1 || /goto=/.test(href)) continue;
      // ⚠️ 同 si-cdp：Elsevier 的 SI 是 mmc\d 命名，链接里没有 suppl/supporting
      var looksSupp =
        /suppl|supporting|supplement/i.test(href) ||
        /suppl|supporting|supplement|appendix/i.test(text) ||
        /\/mmc\d/i.test(href) ||
        /-mmc\d/i.test(href);
      var looksFile =
        /\.(pdf|docx?|xlsx?|zip)(\?|$)/i.test(href) ||
        /\/pdf\//i.test(href) ||
        /article-supplement/i.test(href);
      if (!looksSupp || !looksFile) continue;
      if (seen[href]) continue;
      seen[href] = 1;
      var filename = "";
      try {
        filename = decodeURIComponent(
          new URL(href).pathname.split("/").filter(Boolean).pop() || "",
        );
      } catch (e) {}
      if (!/\.(pdf|docx?|xlsx?|zip)$/i.test(filename)) {
        filename = (filename || "supplementary") + ".pdf";
      }
      out.push({ url: href, filename: filename });
    }
    return out;
  },

  /** 字节 → 临时文件 → 挂成该条目的子附件 */
  _attachBytes: async function (item, bytes, filename) {
    var tmpDir = Zotero.getTempDirectory().path;
    var safeName = String(filename || "supplementary.pdf").replace(/[\\/:*?"<>|]/g, "_");
    var tmpFile =
      typeof PathUtils !== "undefined" && PathUtils.join
        ? PathUtils.join(tmpDir, safeName)
        : tmpDir + "/" + safeName;

    await IOUtils.write(tmpFile, bytes);

    var title = "[SI] " + safeName;
    var mime = this._getMime(safeName);
    var attachment = await Zotero.Attachments.importFromFile({
      file: tmpFile,
      parentItemID: item.id,
      title: title,
      contentType: mime,
    });
    try {
      attachment.addTag("SI", 0);
      await attachment.saveTx();
    } catch (e) {}
    await this._ensureColoredTag(item.libraryID);
    await this._copyToFolder(item, attachment, safeName);
    try {
      await IOUtils.remove(tmpFile);
    } catch (e) {}
    Zotero.debug("[SupplDL] 已挂上: " + title);
  },

  _ensureColoredTag: async function (libraryID) {
    try {
      var tagID = Zotero.Tags.getID("SI", libraryID);
      if (tagID) {
        Zotero.Tags.setColor(libraryID, "SI", "#c0392b", 0);
      } else {
        Zotero.Tags.create(libraryID, "SI", { color: "#c0392b" });
      }
    } catch (e) {
      Zotero.debug("[SupplDL] 标签着色失败: " + e);
    }
  },

  chooseFolder: async function () {
    var win = Zotero.getMainWindow();
    var fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(win.browsingContext, "选择 SI 归档文件夹", Ci.nsIFilePicker.modeGetFolder);
    var rv = await new Promise(function (res) {
      fp.open(res);
    });
    if (rv === Ci.nsIFilePicker.returnOK && fp.file) {
      Zotero.Prefs.set("extensions.suppl-dl.folder", fp.file.path, true);
      this._toast("归档文件夹已设为：\n" + fp.file.path, 5000);
    }
  },

  _getSupplFolder: function () {
    try {
      return Zotero.Prefs.get("extensions.suppl-dl.folder", true);
    } catch (e) {
      return null;
    }
  },

  _copyToFolder: async function (item, attachment, filename) {
    var destDir = this._getSupplFolder();
    if (!destDir) return;
    try {
      var creators = item.getCreators();
      var year = item.getField("year") || "Unknown";
      var firstAuthor = "Unknown";
      if (creators && creators.length) {
        firstAuthor = creators[0].lastName || creators[0].name || "Unknown";
      }
      var sub = (firstAuthor + " " + year).replace(/[<>:"/\\|?*]/g, "_");
      var join =
        typeof PathUtils !== "undefined" && PathUtils.join
          ? PathUtils.join
          : function (a, b) {
              return a + "/" + b;
            };
      var subPath = join(destDir, sub);
      var exists = false;
      try {
        exists = await IOUtils.exists(subPath);
      } catch (e) {}
      if (!exists) await IOUtils.makeDirectory(subPath, { createAncestors: true });
      var src = attachment.getFilePath();
      if (!src) return;
      await IOUtils.write(join(subPath, filename), await IOUtils.read(src));
    } catch (e) {
      Zotero.debug("[SupplDL] 归档失败: " + e);
    }
  },

  _getMime: function (filename) {
    var ext = (String(filename).split(".").pop() || "").toLowerCase();
    var map = {
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip",
    };
    return map[ext] || "application/octet-stream";
  },
};
