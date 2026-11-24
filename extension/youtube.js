import { Innertube, Platform, newQuickJSWASMModuleFromVariant, newVariant, quickJSVariant } from "./vendor/youtube.js";
import { mediaUrl, VIDEO_ID } from "./shared.js";

let quickJS;
Platform.shim.eval = async data => {
  quickJS ??= newQuickJSWASMModuleFromVariant(newVariant(quickJSVariant, {
    wasmLocation: new URL("./vendor/quickjs.wasm", import.meta.url).href,
  }));
  const module = await quickJS;
  const deadline = Date.now() + 1500;
  // The player transform runs in a fresh VM with no browser APIs or host bindings.
  return module.evalCode(`(() => {\n${data.output}\n})()`, {
    memoryLimitBytes: 24 * 1024 * 1024,
    maxStackSizeBytes: 1024 * 1024,
    shouldInterrupt: () => Date.now() > deadline,
  });
};

let catalog;
let playback;

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(25000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function createSession(retrievePlayer, signal) {
  return Innertube.create({
    generate_session_locally: false,
    fail_fast: true,
    retrieve_player: retrievePlayer,
    enable_session_cache: false,
    fetch(input, options) {
      return fetch(input, {
        ...options,
        credentials: "omit",
        signal: requestSignal(signal),
      });
    },
    lang: "zh-CN",
  });
}

function catalogSession() {
  catalog ??= createSession(false).catch(error => {
    catalog = undefined;
    throw error;
  });
  return catalog;
}

function playbackSession(signal) {
  playback ??= createSession(true, signal).catch(error => {
    playback = undefined;
    throw error;
  });
  return playback;
}

function row(index, id, title, available) {
  return { index, id, title: (title || id || "不可用的视频").slice(0, 320), available };
}

export async function loadCatalog(target, onPage) {
  const site = await catalogSession();
  if (target.type === "video") {
    const video = await site.getBasicInfo(target.id, { client: "WEB" });
    const title = video.basic_info.title;
    if (!title) throw new Error(video.playability_status?.reason || "无法读取这条视频。");
    return { title: "", videos: [row(1, target.id, title, true)] };
  }

  const videos = [];
  let page = await site.getPlaylist(target.id);
  const title = String(page.info.title || "播放列表").slice(0, 320);
  for (let pages = 0; ; pages++) {
    const start = videos.length;
    for (const item of page.items) {
      if (videos.length >= 5000) break;
      const id = item.id || item.content_id || item.endpoint?.payload?.videoId;
      const title = item.title?.toString() || item.metadata?.title?.toString() || item.accessibility_text;
      const available = VIDEO_ID.test(id ?? "") && item.is_playable !== false && !item.is_live && !item.is_upcoming;
      videos.push(row(videos.length + 1, available ? id : null, title, available));
    }
    if (!page.has_continuation || videos.length >= 5000) break;
    if (pages >= 99 || videos.length === start) throw new Error("播放列表分页中断，请重新加载。");
    onPage(videos.length);
    page = await page.getContinuation();
  }
  if (!videos.length) throw new Error("播放列表没有可显示的视频。");
  return { title, videos };
}

export async function videoFormats(id, signal) {
  signal.throwIfAborted();
  const site = await createSession(false, signal);
  const clients = ["MWEB", "IOS", "ANDROID"];
  const responses = await Promise.allSettled(clients.map(client => site.getBasicInfo(id, { client })));
  signal.throwIfAborted();
  const formats = [];
  const captionTracks = [];
  for (const [index, response] of responses.entries()) {
    if (response.status !== "fulfilled") continue;
    const video = response.value;
    if (video.basic_info.is_live || video.basic_info.is_live_content && video.playability_status?.status !== "OK") continue;
    for (const track of video.captions?.caption_tracks ?? []) {
      if (track.kind === "asr" && track.base_url) captionTracks.push(track);
    }
    const data = video.streaming_data;
    for (const format of [...(data?.formats ?? []), ...(data?.adaptive_formats ?? [])]) {
      if ((!format.url && !format.signature_cipher && !format.cipher) || format.is_type_otf ||
          format.drm_families?.length || format.drm_track_type || format.fair_play_key_uri ||
          format.target_duration_sec) continue;
      const container = /^(?:video|audio)\/(mp4|webm)(?:;|$)/u.exec(format.mime_type ?? "")?.[1];
      if (container) formats.push({ format, container, client: clients[index] });
    }
  }
  if (!formats.length) {
    const failed = responses.find(response => response.status === "rejected");
    if (responses.every(response => response.status === "rejected")) {
      throw new Error("连接 YouTube 失败，请检查网络后重试。", { cause: failed.reason });
    }
    throw new Error("YouTube 没有提供可下载的公开音视频格式。");
  }
  return { formats, captionTracks };
}

export async function loadAutoCaptions(tracks, signal) {
  const tried = new Set();
  for (const track of tracks) {
    signal.throwIfAborted();
    try {
      const url = new URL(track.base_url);
      if (url.origin !== "https://www.youtube.com" || url.pathname !== "/api/timedtext" ||
          url.username || url.password || url.searchParams.has("tlang")) continue;
      url.searchParams.set("fmt", "vtt");
      if (tried.has(url.href)) continue;
      if (tried.size === 4) break;
      tried.add(url.href);
      const response = await fetch(url, { credentials: "omit", redirect: "error", signal: requestSignal(signal) });
      if (!response.ok) continue;
      const text = (await response.text()).trim();
      if (/^WEBVTT(?:\s|$)/u.test(text) && /^\d[:\d.]+[ \t]+-->[ \t]+\d/mu.test(text)) {
        const name = track.name?.toString() || track.language_code || "YouTube 自动字幕";
        return { text: `${text}\n\n`, name };
      }
    } catch {
      signal.throwIfAborted();
    }
  }
  return null;
}

export async function resolveTrack({ format }, signal) {
  signal.throwIfAborted();
  const raw = format.url;
  const needsTransform = !raw || new URL(raw).searchParams.has("n");
  const url = mediaUrl(needsTransform ? await format.decipher((await playbackSession(signal)).session.player) : raw);
  signal.throwIfAborted();
  if (!url) throw new Error("YouTube 返回了无法使用的媒体地址。");
  return { url, bytes: format.content_length || 0 };
}
