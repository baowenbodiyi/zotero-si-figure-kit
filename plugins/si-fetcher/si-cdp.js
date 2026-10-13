/**
 * si-cdp.js —— 通过本机浏览器的 CDP 取论文的 Supporting Information
 *
 * 为什么需要这一层：出版社（ACS / Elsevier / Wiley …）普遍上 Cloudflare，
 * Zotero 自己的 HTTP 客户端没有浏览器会话，请求一律 403。
 * 而**用户日常在用的浏览器**能过验证 —— 于是借它的会话去取。
 *
 * 实测（2026-10-12，Edge 155 + ACS JACS 那篇）：
 *   pubs.acs.org 直连 → 403
 *   走浏览器        → 页面正常、抓到 SI 链接、5,723,617 字节 PDF 完整取回
 *
 * ⚠️ 三个必须知道的实测结论（都是踩过的坑）：
 *  1. **插件沙箱里没有 `WebSocket`**（`globalThis.WebSocket === undefined`），
 *     但 `Zotero.getMainWindow().WebSocket` 是有的 —— 必须用后者。
 *  2. Edge 必须带 `--remote-allow-origins=*` 启动。
 *     浏览器上下文的 WS 会发 `Origin` 头，Chrome 111+ 的 CDP 会直接回 **403**；
 *     实测：不带 Origin → `101`，带 Origin → `403`，加了 allow-origins → `101`。
 *  3. **不能只等 `document.title`**：ACS 的 SI 链接是后渲染的，
 *     标题早就正常了但链接还没出现。必须**轮询等链接**。
 */

var SiCdp = {
  PORT: 9222,
  PROFILE: "C:\\EdgeDebug",
  EDGE: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  /** 等 SI 链接出现的最长时间（含过 Cloudflare 的时间） */
  WAIT_LINKS_MS: 45000,
  /** 取字节时分块传回的块大小（base64 字符数） */
  CHUNK: 3000000,

  _sleep: function (ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  },

  _baseUrl: function () {
    return "http://127.0.0.1:" + this.PORT;
  },

  _log: function (msg) {
    try {
      Zotero.debug("[SiCdp] " + msg);
    } catch (e) {}
  },

  /** CDP 是否活着；返回 version 对象或 null */
  probe: async function () {
    try {
      var r = await Zotero.HTTP.request(
        "GET",
        this._baseUrl() + "/json/version",
        { responseType: "json", timeout: 4000, successCodes: false },
      );
      return r && r.response && r.response.Browser ? r.response : null;
    } catch (e) {
      return null;
    }
  },

  /** 起一个带调试端口的 Edge（独立 profile，不动用户日常浏览器） */
  launch: async function () {
    this._log("启动调试 Edge …");
    try {
      await Zotero.Utilities.Internal.exec(this.EDGE, [
        "--remote-debugging-port=" + this.PORT,
        "--remote-allow-origins=*",
        "--user-data-dir=" + this.PROFILE,
        "--no-first-run",
        "--no-default-browser-check",
      ]);
    } catch (e) {
      this._log("exec 启动失败: " + e);
    }
    // 等端口起来
    for (var i = 0; i < 20; i++) {
      await this._sleep(1000);
      if (await this.probe()) {
        this._log("调试 Edge 已就绪");
        return true;
      }
    }
    return false;
  },

  /** 关掉 EdgeDebug profile 的 Edge 进程（只动这一个 profile） */
  killProfileEdge: async function () {
    try {
      await Zotero.Utilities.Internal.exec("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*EdgeDebug*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ]);
      await this._sleep(2500);
    } catch (e) {
      this._log("清理 EdgeDebug 失败: " + e);
    }
  },

  /* ------------------------------------------------------------------ *
   * 极简 CDP 客户端
   * ------------------------------------------------------------------ */
  _connect: async function (wsUrl) {
    var WS = Zotero.getMainWindow().WebSocket;
    if (typeof WS !== "function") {
      throw new Error("拿不到 WebSocket 构造器");
    }
    var ws = new WS(wsUrl);
    var client = { ws: ws, nextId: 1, waiters: new Map(), sessions: {} };

    await new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("WebSocket 连接超时"));
      }, 8000);
      ws.onopen = function () {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = function () {
        clearTimeout(timer);
        reject(new Error("WebSocket 连接被拒（多半是 Edge 没带 --remote-allow-origins=*）"));
      };
    });

    ws.onmessage = function (ev) {
      var msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch (e) {
        return;
      }
      if (msg.id && client.waiters.has(msg.id)) {
        var w = client.waiters.get(msg.id);
        client.waiters.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    };

    client.send = function (method, params, sessionId) {
      var id = client.nextId++;
      var payload = { id: id, method: method, params: params || {} };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
      return new Promise(function (resolve, reject) {
        client.waiters.set(id, { resolve: resolve, reject: reject });
        setTimeout(function () {
          if (client.waiters.has(id)) {
            client.waiters.delete(id);
            reject(new Error("CDP 超时: " + method));
          }
        }, 60000);
      });
    };
    return client;
  },

  /** 页面里收集 SI 候选链接（导航链接和锚点都排掉） */
  _findSiExpr: function () {
    return (
      "(() => {" +
      "  const cands = new Set();" +
      "  document.querySelectorAll('a').forEach(a => {" +
      "    const h = a.href || '';" +
      "    if (!/^https?:/i.test(h)) return;" +
      "    if (h.includes('#') || /goto=/.test(h)) return;" +
      "    const t = (a.textContent || '').trim();" +
      // ⚠️ Elsevier 的 SI 链接里**既没有 suppl 也没有 supporting**：
      //   href = https://ars.els-cdn.com/content/image/1-s2.0-XXXX-mmc1.docx
      //   text = "Download: Download Word document (1MB)"
      // 只认 suppl 的写法会把它的 SI 全部漏掉（实测就是这样）。
      // 补上 Elsevier 的 mmc\d 命名，以及 supplement/appendix 这类文案。
      "    const looksSupp = /suppl|supporting|supplement/i.test(h) || /suppl|supporting|supplement|appendix/i.test(t) || /\\/mmc\\d/i.test(h) || /-mmc\\d/i.test(h);" +
      "    const looksFile = /\\.(pdf|docx?|xlsx?|zip)(\\?|$)/i.test(h) || /\\/pdf\\//i.test(h) || /article-supplement/i.test(h);" +
      "    if (looksSupp && looksFile) cands.add(h);" +
      "  });" +
      "  return [...cands].join('\\n');" +
      "})()"
    );
  },

  /**
   * 主流程：借浏览器打开论文页 → 找 SI 链接 → 把字节取回来
   * @returns {Promise<{bytes: Uint8Array, filename: string, siUrl: string, pageTitle: string}>}
   */
  fetchSi: async function (paperUrl, onProgress) {
    var say = function (m) {
      if (onProgress) onProgress(m);
    };

    var ver = await this.probe();
    if (!ver) {
      say("调试 Edge 没在跑，正在启动…");
      var ok = await this.launch();
      if (!ok) throw new Error("调试 Edge 起不来");
      ver = await this.probe();
    }
    if (!ver) throw new Error("连不上 CDP");

    var client;
    try {
      client = await this._connect(ver.webSocketDebuggerUrl);
    } catch (e) {
      // 最常见：Edge 是老参数起的，没带 --remote-allow-origins=*
      say("浏览器调试端口参数过旧，重启调试 Edge…");
      await this.killProfileEdge();
      var ok2 = await this.launch();
      if (!ok2) throw e;
      var ver2 = await this.probe();
      client = await this._connect(ver2.webSocketDebuggerUrl);
    }

    var targetId;
    try {
      var t = await client.send("Target.createTarget", { url: "about:blank" });
      targetId = t.targetId;
      var a = await client.send("Target.attachToTarget", {
        targetId: targetId,
        flatten: true,
      });
      var sid = a.sessionId;
      await client.send("Page.enable", {}, sid);
      await client.send("Runtime.enable", {}, sid);

      var ev = async function (expr, awaitPromise) {
        var r = await client.send(
          "Runtime.evaluate",
          {
            expression: expr,
            returnByValue: true,
            awaitPromise: awaitPromise !== false,
          },
          sid,
        );
        return r.result ? r.result.value : undefined;
      };

      say("正在打开论文页面（可能需要过 Cloudflare）…");
      await client.send("Page.navigate", { url: paperUrl }, sid);

      // ⚠️ 只等标题是不够的：链接是后渲染的，必须轮询链接本身
      var siUrl = "";
      var pageTitle = "";
      var deadline = Date.now() + this.WAIT_LINKS_MS;
      while (Date.now() < deadline) {
        await this._sleep(2000);
        pageTitle = String(await ev("document.title", false) || "");
        var links = String(await ev(this._findSiExpr(), false) || "");
        var first = links.split("\n").filter(Boolean)[0];
        if (first) {
          siUrl = first;
          break;
        }
        say("等 SI 链接… 当前页面：" + pageTitle.slice(0, 40));
      }
      if (!siUrl) throw new Error("页面里没找到 SI 链接（标题：" + pageTitle + "）");

      say("找到 SI，正在取字节…");
      var bytes = null;

      // ① 先试**直连**：插件自己的 HTTP 客户端没有 CORS 限制。
      //
      // 为什么必须加这一步：Elsevier 的 SI 放在 `ars.els-cdn.com`，
      // 实测**不带任何凭据**就能拿到（HTTP 200 + 完整字节数）；
      // 但从 sciencedirect.com 页面里 `fetch` 那个域名会被 **CORS 拦死** ——
      // `TypeError: Failed to fetch`。于是「明明免费可下」的文件拿不到。
      try {
        var direct = await Zotero.HTTP.request("GET", siUrl, {
          responseType: "arraybuffer",
          timeout: 180000,
          successCodes: false,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });
        if (
          direct &&
          direct.status >= 200 &&
          direct.status < 400 &&
          direct.response &&
          direct.response.byteLength
        ) {
          bytes = new Uint8Array(direct.response);
          say("直连取到 " + bytes.length + " 字节");
        } else {
          say(
            "直连被拒 HTTP " +
              (direct ? direct.status : "无响应") +
              "，改用页面会话",
          );
        }
      } catch (e) {
        say("直连失败（" + e.message + "），改用页面会话");
      }

      // ② 回退：页面内 fetch —— 能带上登录态，
      //    对 ACS 这类「非浏览器请求一律 403」的站点仍然走这条。
      if (!bytes) {
        var byteLen = await ev(
          "(async () => {" +
            "  const r = await fetch(" + JSON.stringify(siUrl) + ", {credentials:'include'});" +
            "  if (!r.ok) return 'HTTP ' + r.status;" +
            "  const b = new Uint8Array(await r.arrayBuffer());" +
            "  let s=''; const CH=0x8000;" +
            "  for (let i=0;i<b.length;i+=CH) s += String.fromCharCode.apply(null, b.subarray(i,i+CH));" +
            "  window.__si_b64 = btoa(s); window.__si_len = b.length;" +
            "  return b.length;" +
          "})()",
        );
        if (typeof byteLen !== "number") {
          throw new Error("直连和页面内取 SI 都失败：" + byteLen);
        }

        var total = await ev("window.__si_b64.length", false);
        var b64 = "";
        for (var off = 0; off < total; off += this.CHUNK) {
          var part = await ev(
            "window.__si_b64.slice(" + off + "," + Math.min(off + this.CHUNK, total) + ")",
            false,
          );
          b64 += part;
          say("取回 " + Math.round((b64.length / total) * 100) + "%");
        }
        await ev("window.__si_b64 = null", false);
        bytes = this._b64ToBytes(b64);
      }

      var filename = this._guessFilename(siUrl, pageTitle);
      return {
        bytes: bytes,
        filename: filename,
        siUrl: siUrl,
        pageTitle: pageTitle,
      };
    } finally {
      try {
        if (targetId) await client.send("Target.closeTarget", { targetId: targetId });
      } catch (e) {}
      try {
        client.ws.close();
      } catch (e) {}
    }
  },

  /** 自带的 base64 解码（沙箱里没有 atob，也不想去依赖主窗口） */
  _b64ToBytes: function (b64) {
    var TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var lookup = new Int16Array(256).fill(-1);
    for (var i = 0; i < TABLE.length; i++) lookup[TABLE.charCodeAt(i)] = i;
    var clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
    var outLen = Math.floor((clean.length * 3) / 4);
    var out = new Uint8Array(outLen);
    var p = 0;
    for (var j = 0; j < clean.length; j += 4) {
      var c0 = lookup[clean.charCodeAt(j)];
      var c1 = lookup[clean.charCodeAt(j + 1)];
      var c2 = lookup[clean.charCodeAt(j + 2)];
      var c3 = lookup[clean.charCodeAt(j + 3)];
      if (p < outLen) out[p++] = (c0 << 2) | (c1 >> 4);
      if (p < outLen && c2 >= 0) out[p++] = ((c1 & 15) << 4) | (c2 >> 2);
      if (p < outLen && c3 >= 0) out[p++] = ((c2 & 3) << 6) | c3;
    }
    return out.subarray(0, p);
  },

  /** 从 SI URL / 页面标题起个能认出来的文件名 */
  _guessFilename: function (siUrl, pageTitle) {
    var name = "";
    try {
      var last = new URL(siUrl).pathname.split("/").filter(Boolean).pop() || "";
      if (last && last.indexOf(".") !== -1) name = decodeURIComponent(last);
    } catch (e) {}
    if (!name) {
      name = "supporting-information.pdf";
    }
    if (!/\.(pdf|docx?|xlsx?|zip)$/i.test(name)) name += ".pdf";
    // 标题里带非法字符，截短
    var short = String(pageTitle || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .split("|")[0]
      .trim()
      .slice(0, 60);
    return (short ? short + " - " : "") + name;
  },
};
