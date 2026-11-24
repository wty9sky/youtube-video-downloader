import { downloadPlans } from "./formats.js";
import { heights, idle, qualityLabel, youtubeTarget } from "./shared.js";
import { loadAutoCaptions, loadCatalog, resolveTrack, videoFormats } from "./youtube.js";

async function backend(action, fields) {
  const response = await chrome.runtime.sendMessage({ action, ...fields });
  if (!response || response.error) throw new Error(response?.error ?? "扩展后台未响应。");
  return response;
}

let state = idle;
let writes = Promise.resolve();
let activeDownload;
const working = () => ["running", "loading", "canceling"].includes(state.phase);

function publish() {
  const snapshot = structuredClone(state);
  writes = writes.catch(console.error).then(() => backend("engineState", { state: snapshot }));
  writes.catch(console.error);
  return writes;
}

const initialized = backend("engineRestore").then(({ state: previous }) => {
  state = previous;
  if (!working()) return;
  state.videos = state.videos.map(video => ["queued", "preparing", "captions", "downloading", "processing", "saving"].includes(video.phase)
    ? { ...video, phase: "error", error: "浏览器已结束下载任务，请重新勾选后重试。" } : video);
  state.phase = "error";
  state.message = "上次任务已中断。";
  return publish();
});

async function load(text) {
  const target = youtubeTarget(text);
  if (!target) throw new Error("请输入有效的 YouTube 视频或播放列表链接。");
  const { quality, includeAudio, includeAutoCaptions = false } = state;
  state = { ...idle, url: text, quality, includeAudio, includeAutoCaptions, phase: "loading", message: "正在加载视频列表…" };
  publish();
  try {
    const { title, videos } = await loadCatalog(target, count => {
      state.message = `正在加载视频列表，已读取 ${count} 条…`;
      publish();
    });
    state.title = title;
    state.videos = videos.map(video => ({ ...video, selected: video.available && target.type === "video", phase: "idle" }));
    state.phase = "ready";
    state.message = videos.some(video => video.available) ? "" : "列表里没有可下载的视频。";
  } catch (error) {
    state.phase = "error";
    state.message = error.message || "无法加载视频列表。";
  }
  await publish();
}

function safeTitle(title) {
  const name = Array.from(title.replace(/[\x00-\x1f<>:"/\\|?*]/gu, "_").replace(/^[.\s]+|[.\s]+$/gu, ""))
    .slice(0, 52).join("");
  if (/^(?:con|prn|aux|nul|(?:com|lpt)[1-9])(?:\.|$)/iu.test(name)) return "_" + name;
  return name || "视频";
}

async function saveFile(url, filename, onProgress, signal) {
  signal.throwIfAborted();
  const { id } = await backend("downloadStart", { url, filename });
  while (true) {
    const canceling = signal.aborted;
    const item = await backend(canceling ? "downloadCancel" : "downloadStatus", { id });
    if (item.state === "complete") return;
    if (canceling) signal.throwIfAborted();
    if (signal.aborted) continue;
    if (item.state === "interrupted") throw new Error(`Chrome 下载中断（${item.error || "原因未知"}）。`);
    onProgress(item.totalBytes > 0 ? item.bytesReceived / item.totalBytes : null);
    await new Promise(resolve => setTimeout(resolve, 650));
  }
}

async function downloadVideo(row, signal) {
  const { formats, captionTracks } = await videoFormats(row.id, signal);
  const plans = downloadPlans(formats, state.quality, state.includeAudio);
  if (!plans.length) throw new Error("所选清晰度和声音组合没有可下载的格式。");
  let captions;
  let captionNote = "";
  if (state.includeAutoCaptions) {
    row.phase = "captions";
    publish();
    captions = await loadAutoCaptions(captionTracks, signal);
    if (!captions) captionNote = captionTracks.length ? "无法读取 YouTube 自动字幕。" : "该视频没有可用的 YouTube 自动字幕。";
  }
  const prefix = state.title ? `${safeTitle(state.title)}/${String(row.index).padStart(3, "0")} - ` : "";
  let lastError;
  for (const plan of plans.slice(0, 8)) {
    signal.throwIfAborted();
    const { height, outputHeight, resize } = plan;
    const route = plan.route === "direct" && captions ? "caption" : plan.route;
    Object.assign(row, { height, outputHeight, route, phase: "preparing", percent: null, note: captionNote });
    publish();
    const name = `YouTube/${prefix}${safeTitle(row.title)} [${row.id}].mp4`;
    const onStatus = (phase, percent) => {
      if (signal.aborted) return;
      row.phase = phase;
      row.percent = Number.isFinite(percent) ? Math.max(0, Math.min(99, Math.floor(percent))) : null;
      publish();
    };
    try {
      const video = await resolveTrack(plan.video, signal);
      if (route === "direct") {
        onStatus("downloading", null);
        await saveFile(video.url, name, percent => onStatus("downloading", percent === null ? null : percent * 100), signal);
      } else {
        const tracks = [video];
        if (plan.audio) tracks.push(await resolveTrack(plan.audio, signal));
        const { withProcessedVideo } = await import("./mux.js");
        await withProcessedVideo(tracks, { ...plan, includeAudio: state.includeAudio, captions, signal }, onStatus, (url, resized) => {
          if (resize && !resized) {
            row.outputHeight = height;
            row.note += `浏览器无法编码为 ${qualityLabel(outputHeight)}，已使用源画质。`;
          }
          onStatus("saving", 95);
          return saveFile(url, name, percent => onStatus("saving", percent === null ? 95 : 95 + percent * 4), signal);
        });
      }
      row.phase = "done";
      row.percent = 100;
      row.hasAutoCaptions = Boolean(captions);
      return;
    } catch (error) {
      signal.throwIfAborted();
      lastError = error;
      if (error.message.includes("USER_CANCELED")) break;
    }
  }
  throw lastError;
}

async function start(selected, { signal }) {
  for (const [index, row] of selected.entries()) {
    if (signal.aborted) break;
    row.phase = "preparing";
    state.message = `正在处理第 ${index + 1} / ${selected.length} 项…`;
    publish();
    try {
      await downloadVideo(row, signal);
    } catch (error) {
      if (signal.aborted) break;
      row.phase = "error";
      row.error = error.message || "下载失败。";
    }
    publish();
  }
  const done = selected.filter(row => row.phase === "done").length;
  const failures = selected.filter(row => row.phase === "error").length;
  if (signal.aborted && done + failures < selected.length) {
    for (const row of selected) {
      if (row.phase === "done" || row.phase === "error") continue;
      Object.assign(row, { phase: "canceled", percent: null, note: "" });
    }
    state.phase = "canceled";
    state.message = done ? `下载已取消，已保存 ${done} 条视频。` : "下载已取消。";
  } else {
    state.phase = failures ? "error" : "done";
    state.message = failures ? `已完成 ${done} 条，失败 ${failures} 条。` : `已保存 ${done} 条视频。`;
  }
  activeDownload = undefined;
  await publish();
}

function applySettings(request) {
  if (heights.includes(request.quality)) state.quality = request.quality;
  if (typeof request.includeAudio === "boolean") state.includeAudio = request.includeAudio;
  if (typeof request.includeAutoCaptions === "boolean") state.includeAutoCaptions = request.includeAutoCaptions;
}

async function handle(request) {
  await initialized;
  if (request.action === "cancel") {
    if (state.phase === "running" && activeDownload) {
      state.phase = "canceling";
      state.message = "正在取消下载…";
      activeDownload.abort(new DOMException("下载已取消。", "AbortError"));
      await publish();
    }
    return { ok: true };
  }
  if (working()) throw new Error("正在处理当前任务。");
  switch (request.action) {
    case "load":
      await load(request.url);
      break;
    case "select": {
      const indexes = new Set(request.indexes);
      for (const video of state.videos) {
        if (video.available && (request.all || indexes.has(video.index))) video.selected = request.selected === true;
      }
      await publish();
      break;
    }
    case "settings":
      applySettings(request);
      await publish();
      break;
    case "start": {
      applySettings(request);
      const selected = state.videos.filter(video => video.selected && video.available);
      if (!selected.length) throw new Error("请先勾选要下载的视频。");
      for (const video of selected) {
        Object.assign(video, { phase: "queued", error: "", note: "", percent: null, route: null, height: null, outputHeight: null, hasAutoCaptions: false });
      }
      state.phase = "running";
      activeDownload = new AbortController();
      start(selected, activeDownload).catch(console.error);
      break;
    }
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (request?.target !== "engine" || sender.id !== chrome.runtime.id) return false;
  handle(request).then(reply, error => reply({ error: error.message }));
  return true;
});
