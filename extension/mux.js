import {
  ALL_FORMATS, BlobSource, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, TextSubtitleSource, canEncodeVideo,
} from "./vendor/media.js";
import { mediaUrl } from "./shared.js";

const CHUNK_SIZE = 8 * 1024 * 1024;
let temporaryRoot;

async function openTemporaryRoot() {
  const origin = await navigator.storage.getDirectory();
  const root = await origin.getDirectoryHandle("youtube-media-buffer", { create: true });
  for await (const name of root.keys()) await root.removeEntry(name, { recursive: true });
  return root;
}

async function fetchTrack(track, handle, onBytes, controller, signal) {
  let timeout;
  function renewTimeout() {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new Error("媒体下载超时。")), 45000);
  }

  const writer = (await handle.createWritable()).getWriter();
  let loaded = 0;
  let total = track.bytes;
  try {
    do {
      renewTimeout();
      const endByte = Math.min(loaded + CHUNK_SIZE, total || Infinity) - 1;
      const result = await fetch(track.url, {
        credentials: "omit",
        headers: { Range: `bytes=${loaded}-${endByte}` },
        signal,
      });
      if (!result.ok || !result.body || !mediaUrl(result.url)) {
        throw new Error(`媒体服务器返回 HTTP ${result.status}。`);
      }
      if (!/^(?:video\/|audio\/|application\/octet-stream)/iu.test(result.headers.get("content-type") ?? "")) {
        throw new Error("媒体服务器没有返回音视频数据。");
      }
      const length = Number(result.headers.get("content-length"));
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(result.headers.get("content-range") ?? "");
      if (result.status === 206) {
        if (!range || Number(range[1]) !== loaded || Number(range[2]) >= Number(range[3])) {
          throw new Error("媒体分段范围无效。");
        }
        total = Number(range[3]);
      } else if (loaded) {
        throw new Error("媒体服务器忽略了分段请求。");
      } else {
        total = length || total;
      }

      const previous = loaded;
      const reader = result.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          renewTimeout();
          await writer.write(value);
          loaded += value.byteLength;
          onBytes(loaded, total);
        }
      } finally {
        reader.releaseLock();
      }
      const expected = range ? Number(range[2]) + 1 : (total || loaded);
      if (loaded === previous || loaded !== expected) throw new Error("媒体数据下载不完整。");
    } while (loaded < total);
    signal.throwIfAborted();
    await writer.close();
    onBytes(loaded, loaded);
    return handle.getFile();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function resizeOptions(track, height) {
  const [width, sourceHeight] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
  const scale = height / Math.min(width, sourceHeight);
  const even = value => Math.max(2, Math.round(value * scale / 2) * 2);
  const size = { width: even(width), height: even(sourceHeight) };
  const codec = await canEncodeVideo("avc", size) ? "avc" : undefined;
  return { ...size, codec, fit: "contain", forceTranscode: true };
}

async function combine(videoFile, audioFile, outputHandle, includeAudio, captions, height, onProgress, signal) {
  signal.throwIfAborted();
  const videoInput = new Input({ source: new BlobSource(videoFile), formats: ALL_FORMATS });
  const audioInput = audioFile ? new Input({ source: new BlobSource(audioFile), formats: ALL_FORMATS }) : null;
  let output;
  let tasks = [];
  const conversions = [];
  let stopping;
  function stop() {
    stopping ??= Promise.allSettled([
      ...conversions.map(item => item.cancel()),
      output?.cancel(),
    ]);
    return stopping;
  }
  try {
    const videoTrack = await videoInput.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("下载的数据缺少视频轨道。");
    const video = height ? await resizeOptions(videoTrack, height) : {};
    signal.throwIfAborted();
    const format = new Mp4OutputFormat({ fastStart: false });
    output = new Output({ format, target: new StreamTarget(await outputHandle.createWritable(), { chunked: true }) });
    const options = { output, tracks: "primary", composable: true, showWarnings: false };
    const picture = await Conversion.init({
      ...options, input: videoInput, video, audio: { discard: !includeAudio || Boolean(audioInput) },
    });
    conversions.push(picture);
    signal.throwIfAborted();
    if (!picture.utilizedTracks.some(track => track.isVideoTrack())) {
      throw new Error(height ? "浏览器无法编码所选分辨率。" : "浏览器无法将这个视频封装为 MP4。");
    }
    if (audioInput) {
      conversions.push(await Conversion.init({ ...options, input: audioInput, video: { discard: true } }));
    }
    if (includeAudio && !conversions.some(item => item.utilizedTracks.some(track => track.isAudioTrack()))) {
      throw new Error("浏览器无法保留这条视频的声音。");
    }
    const subtitles = captions ? new TextSubtitleSource("webvtt") : null;
    if (subtitles) output.addSubtitleTrack(subtitles, { name: captions.name });
    picture.onProgress = onProgress;
    signal.throwIfAborted();
    await output.start();
    signal.throwIfAborted();
    signal.addEventListener("abort", stop, { once: true });
    if (subtitles) {
      await subtitles.add(captions.text);
      subtitles.close();
      signal.throwIfAborted();
    }
    tasks = conversions.map(item => item.execute());
    await Promise.all(tasks);
    signal.throwIfAborted();
    signal.removeEventListener("abort", stop);
    await output.finalize();
  } catch (error) {
    await stop();
    await Promise.allSettled(tasks);
    throw error;
  } finally {
    signal.removeEventListener("abort", stop);
    videoInput.dispose();
    audioInput?.dispose();
  }
}

export async function withProcessedVideo(tracks, options, onStatus, save) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  temporaryRoot ??= openTemporaryRoot().catch(error => {
    temporaryRoot = undefined;
    throw error;
  });
  const root = await temporaryRoot;
  const jobId = crypto.randomUUID();
  const folder = await root.getDirectoryHandle(jobId, { create: true });
  const sizes = tracks.map(track => ({ loaded: 0, total: track.bytes }));
  let lastReport = 0;
  function report(phase, percent) {
    if (Date.now() - lastReport < 400) return;
    lastReport = Date.now();
    onStatus(phase, percent);
  }
  try {
    signal.throwIfAborted();
    const files = await Promise.allSettled(tracks.map(async (track, index) => {
      try {
        const handle = await folder.getFileHandle(`input-${index}`, { create: true });
        return await fetchTrack(track, handle, (loaded, total) => {
          sizes[index] = { loaded, total };
          const received = sizes.reduce((sum, size) => sum + size.loaded, 0);
          const expected = sizes.reduce((sum, size) => sum + size.total, 0);
          report("downloading", sizes.every(size => size.total) ? 72 * received / expected : null);
        }, controller, signal);
      } catch (error) {
        controller.abort(error);
        throw error;
      }
    }));
    const failure = files.find(file => file.status === "rejected");
    if (failure) throw failure.reason;
    signal.throwIfAborted();
    onStatus("processing", 73);
    const output = await folder.getFileHandle("output.mp4", { create: true });
    const [video, audio] = files.map(file => file.value);
    const progress = fraction => report("processing", 73 + fraction * 21);
    const { includeAudio, captions, resize, height, outputHeight } = options;
    let resized = resize;
    try {
      await combine(video, audio, output, includeAudio, captions, resize ? outputHeight : 0, progress, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!resize || outputHeight <= height) throw error;
      resized = false;
      await combine(video, audio, output, includeAudio, captions, 0, progress, signal);
    }
    const file = await output.getFile();
    signal.throwIfAborted();
    const objectUrl = URL.createObjectURL(file.slice(0, file.size, "video/mp4"));
    try {
      await save(objectUrl, resized);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } finally {
    await root.removeEntry(jobId, { recursive: true }).catch(console.error);
  }
}
