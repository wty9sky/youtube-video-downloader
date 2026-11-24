export const STATE_KEY = "browserDownload";
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,128}$/u;
const youtubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "www.youtu.be"]);
export const heights = [0, 2160, 1440, 1080, 720, 480, 360, 240, 144];

export function qualityLabel(height) {
  if (height === 2160) return "4K";
  if (height === 1440) return "2K";
  return height ? `${height}p` : "原始画质";
}

export function youtubeTarget(text) {
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !youtubeHosts.has(url.hostname)) return null;
    const list = url.searchParams.get("list");
    if (PLAYLIST_ID.test(list ?? "")) return { type: "playlist", id: list };
    const parts = url.pathname.split("/").filter(Boolean);
    const id = url.hostname.endsWith("youtu.be")
      ? parts[0]
      : parts[0] === "watch" ? url.searchParams.get("v") : ["shorts", "live"].includes(parts[0]) ? parts[1] : null;
    if (id && VIDEO_ID.test(id)) return { type: "video", id };
  } catch {
    // An incomplete URL or an unrelated tab can leave the input empty.
  }
  return null;
}

export function mediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.port && !url.username && !url.password &&
        (url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"))) {
      return url.href;
    }
  } catch {
    // Refuse unexpected or missing streaming URLs.
  }
  return null;
}

export const idle = {
  phase: "idle",
  message: "输入链接后加载视频列表。",
  url: "",
  title: "",
  videos: [],
  quality: 0,
  includeAudio: true,
  includeAutoCaptions: false,
};
