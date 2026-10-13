import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import {
  registerPrefsScripts,
  registerPrefsWindow,
} from "./modules/preferenceWindow";
import {
  registerReaderTabPanel,
  updateReaderTabPanels,
} from "./modules/tabpanel";
import { buildReaderPopup, updateReaderPopup } from "./modules/popup";
import { registerNotify } from "./modules/notify";
import { registerReaderInitializer } from "./modules/reader";
import { getPref, registerPrefObserver } from "./utils/prefs";
// ⭐ 补丁：退出时把翻译记忆落盘
import { persistentCache } from "./utils/persistentCache";
import {
  addTranslateAnnotationTask,
  addTranslateTask,
  addTranslateTitleTask,
  getLastTranslateTask,
  TranslateTask,
} from "./utils/task";
import { setDefaultPrefSettings } from "./modules/defaultPrefs";
import Addon from "./addon";
import { registerMenu } from "./modules/menu";
import { registerExtraColumns } from "./modules/itemTree";
import { registerShortcuts } from "./modules/shortcuts";
import { registerItemPaneInfoRows } from "./modules/infoBox";
import { registerCustomFields } from "./modules/fields";
// ⭐ 补丁：调试日志 + 构建标记（用来区分「运行时到底加载了哪个构建」）
import { BUILD_TAG, debugLog } from "./utils/debugLog";


async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  // TODO: Remove this after zotero#3387 is merged
  if (__env__ === "development") {
    // Keep in sync with the scripts/startup.mjs
    const loadDevToolWhen = `Plugin ${config.addonID} startup`;
    ztoolkit.log(loadDevToolWhen);
  }

  initLocale();

  setDefaultPrefSettings();

  registerCustomFields();

  registerReaderInitializer();

  registerShortcuts();

  registerNotify(["item"]);

  registerPrefsWindow();

  registerExtraColumns();

  registerItemPaneInfoRows();

  registerReaderTabPanel();

  registerFontPrefObservers();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // ⭐ 启动标记：让「到底加载的是哪个构建」变成一个**可查的事实**，而不是推理。
  // （2026-10-12：曾出现「磁盘上的 XPI 有 sibox、AddonManager 也报 2.4.8.36，
  //   但运行时就是不执行新代码」的情况，靠这行才定位。）
  void debugLog("boot", `hooks.onStartup done | build=${BUILD_TAG}`);
}

/**
 * ⭐ 补丁：字号 / 行高 / 字体 一改就**立刻**刷新所有显示区域。
 *
 * 原版只在「重新划词、重新渲染」时才去读这几个 pref，所以用户在设置里把字号调大后，
 * 盯着已经打开的划词弹窗看，不会有任何变化 —— 看起来就像「改了没用」。
 * 这里挂 pref 监听，改完立即重刷弹窗与阅读器面板。
 */
function registerFontPrefObservers() {
  const refreshFonts = () => {
    try {
      addon.hooks.onReaderPopupRefresh();
    } catch (e) {
      ztoolkit.log("refresh popup on font change failed", e);
    }
    try {
      updateReaderTabPanels();
    } catch (e) {
      ztoolkit.log("refresh panels on font change failed", e);
    }
  };
  ["fontSize", "lineHeight", "fontFamily"].forEach((key) =>
    registerPrefObserver(key, refreshFonts),
  );
}

async function onMainWindowLoad(win: Window): Promise<void> {
  await new Promise((resolve) => {
    if (win.document.readyState !== "complete") {
      win.document.addEventListener("readystatechange", () => {
        if (win.document.readyState === "complete") {
          resolve(void 0);
        }
      });
    }
    resolve(void 0);
  });

  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  Services.scriptloader.loadSubScript(
    `chrome://${config.addonRef}/content/scripts/customElements.js`,
    win,
  );

  (win as any).MozXULElement.insertFTLIfNeeded(
    `${config.addonRef}-mainWindow.ftl`,
  );

  registerMenu();

  win.document.addEventListener("focusout", (ev) => {
    if (ev.target !== win.document) {
      return;
    }
    addon.data.translate.concatKey = false;
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  win.document
    .querySelector(`[href="${config.addonRef}-mainWindow.ftl"]`)
    ?.remove();
}

async function onShutdown(): Promise<void> {
  // ⭐ 补丁：退出前把翻译记忆落盘（写盘是 1s 防抖的，别把最后几条丢了）
  try {
    await persistentCache.flush();
  } catch (e) {
    Zotero.debug(`[pdf-translate] flush persistent cache on shutdown: ${e}`);
  }
  ztoolkit.unregisterAll();
  Zotero.getMainWindows().forEach((win) => {
    onMainWindowUnload(win);
  });
  // Remove addon object
  addon.data.alive = false;
  // @ts-ignore - Plugin instance is not typed
  delete Zotero[config.addonInstance];
}

/**
 * This function is just an example of dispatcher for Notify events.
 * Any operations should be placed in a function to keep this function clear.
 */
function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (event === "add" && type === "item") {
    if (
      !getPref("enableAnnotationFromSyncTranslation") &&
      extraData?.skipAutoSync
    )
      return;
    const annotationItems = Zotero.Items.get(ids as number[]).filter((item) =>
      item.isAnnotation(),
    );
    if (annotationItems.length === 0) {
      return;
    }
    if (getPref("enableComment")) {
      addon.hooks.onTranslateInBatch(
        annotationItems
          .map((item) => addTranslateAnnotationTask(item.id))
          .filter((task) => task) as TranslateTask[],
        { noDisplay: true },
      );
    }
  } else if (type === "tab" && ["select", "add", "close"].includes(event)) {
    addon.data.translate.concatKey = false;
  } else {
    return;
  }
}

function onPrefsLoad(event: Event) {
  registerPrefsScripts((event.target as any).ownerGlobal);
}

function onShortcuts(type: string) {
  switch (type) {
    case "library":
      {
        addon.hooks.onTranslateInBatch(
          Zotero.getActiveZoteroPane()
            .getSelectedItems(true)
            .map((id) => addTranslateTitleTask(id, true))
            .filter((task) => task) as TranslateTask[],
          { noDisplay: true, noCache: true },
        );
      }
      break;
    case "reader":
      {
        addon.hooks.onTranslate(undefined, {
          noCheckZoteroItemLanguage: true,
          noCache: true,
        });
      }
      break;
    default:
      break;
  }
}

async function onTranslate(): Promise<void>;
async function onTranslate(
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(
  task: TranslateTask | undefined,
  options?: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"],
): Promise<void>;
async function onTranslate(...data: any) {
  let task = undefined;
  let options = {};
  if (data.length === 1) {
    if (data[0].raw) {
      task = data[0];
    } else {
      options = data[0];
    }
  } else if (data.length === 2) {
    task = data[0];
    options = data[1];
  }
  await addon.data.translate.services.runTranslationTask(task, options);
}

async function onTranslateInBatch(
  tasks: TranslateTask[],
  options: Parameters<
    Addon["data"]["translate"]["services"]["runTranslationTask"]
  >["1"] = {},
) {
  for (const task of tasks) {
    await addon.hooks.onTranslate(task, options);
    await Zotero.Promise.delay(addon.data.translate.batchTaskDelay);
  }
}

function onReaderPopupShow(
  event: _ZoteroTypes.Reader.EventParams<"renderTextSelectionPopup">,
) {
  const selection = addon.data.translate.selectedText;
  const task = getLastTranslateTask();
  if (task?.raw === selection) {
    buildReaderPopup(event);
    addon.hooks.onReaderPopupRefresh();
    return;
  }
  addTranslateTask(selection, event.reader.itemID);
  buildReaderPopup(event);
  addon.hooks.onReaderPopupRefresh();
  if (getPref("enableAuto")) {
    addon.hooks.onTranslate();
  }
}

function onReaderPopupRefresh() {
  updateReaderPopup();
}

function onReaderTabPanelRefresh() {
  updateReaderTabPanels();
}

// Add your hooks here. For element click, etc.
// Keep in mind hooks only do dispatch. Don't add code that does real jobs in hooks.
// Otherwise the code would be hard to read and maintain.

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
  onNotify,
  onPrefsLoad,
  onShortcuts,
  onTranslate,
  onTranslateInBatch,
  onReaderPopupShow,
  onReaderPopupRefresh,
  onReaderTabPanelRefresh,
};
