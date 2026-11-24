import { idle, mediaUrl, STATE_KEY } from "./shared.js";

const popup = chrome.runtime.getURL("popup.html");
const engine = chrome.runtime.getURL("engine.html");
const blobPrefix = `blob:${chrome.runtime.getURL("")}`;
let creating;
let configuring;

function configureYouTubeRequests() {
  configuring ??= chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1, 2],
    // Anonymous YouTube endpoints reject extension origins. Scope this to the extension's requests.
    addRules: ["|https://www.youtube.com/youtubei/v1/", "||googlevideo.com/videoplayback"].map((urlFilter, index) => ({
      id: index + 1,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]
          .map(header => ({ header, operation: "remove" })),
      },
      condition: {
        urlFilter,
        initiatorDomains: [chrome.runtime.id],
        requestMethods: [index === 0 ? "post" : "get"],
        resourceTypes: ["xmlhttprequest"],
      },
    })),
  }).catch(error => {
    configuring = undefined;
    throw error;
  });
  return configuring;
}

async function ensureEngine() {
  await configureYouTubeRequests();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [engine] });
  if (contexts.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: "engine.html",
    reasons: ["BLOBS"],
    justification: "继续处理选中的下载，并保存由扩展合并的音视频文件。",
  }).finally(() => { creating = undefined; });
  await creating;
}

async function forward(request) {
  await ensureEngine();
  return chrome.runtime.sendMessage({ ...request, target: "engine" });
}

async function readState() {
  return { state: (await chrome.storage.session.get(STATE_KEY))[STATE_KEY] ?? idle };
}

async function bridge(request) {
  switch (request.action) {
    case "engineRestore":
      return readState();
    case "engineState":
      await chrome.storage.session.set({ [STATE_KEY]: request.state });
      return { ok: true };
    case "downloadStart": {
      const { url, filename } = request;
      const safeUrl = typeof url === "string" && (url.startsWith(blobPrefix) || mediaUrl(url));
      const safePath = typeof filename === "string" && /^YouTube\/(?:[^/]+\/)?[^/]+\.mp4$/u.test(filename)
        && !filename.includes("\\") && !filename.split("/").some(part => part === "." || part === "..");
      if (!safeUrl || !safePath) throw new Error("下载地址或文件名无效。");
      const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
      return { id };
    }
    case "downloadCancel":
    case "downloadStatus": {
      const canceling = request.action === "downloadCancel";
      if (canceling) await chrome.downloads.cancel(request.id);
      const [item] = await chrome.downloads.search({ id: request.id });
      if (!item && canceling) return { state: "interrupted" };
      if (!item) throw new Error("浏览器找不到这条下载。");
      const { state, bytesReceived, totalBytes, error } = item;
      return { state, bytesReceived, totalBytes, error };
    }
    default:
      throw new Error("未知的后台请求。");
  }
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (!request || request.target || sender.id !== chrome.runtime.id) return false;
  let result;
  if (sender.url === popup) {
    if (request.action === "status") result = readState();
    else if (["load", "select", "settings", "start", "cancel"].includes(request.action)) result = forward(request);
  } else if (sender.url === engine) {
    result = bridge(request);
  }
  if (!result) return false;
  result.then(reply, error => reply({ error: error.message }));
  return true;
});
