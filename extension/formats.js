// Quality labels describe the shorter dimension on portrait videos.
function resolution(format) {
  return Number.parseInt(format.quality_label, 10) || Math.min(format.width, format.height);
}

function bestAudio(formats) {
  const compatible = formats.filter(track => track.format.has_audio && !track.format.has_video);
  compatible.sort((a, b) => Number(Boolean(b.format.is_original || b.format.audio_track?.audio_is_default)) -
    Number(Boolean(a.format.is_original || a.format.audio_track?.audio_is_default)) ||
    Number(Boolean(a.format.is_drc)) - Number(Boolean(b.format.is_drc)) ||
    Number(b.container === "mp4") - Number(a.container === "mp4") ||
    (b.format.bitrate || 0) - (a.format.bitrate || 0));
  const audio = compatible[0];
  const alternate = compatible.find(track => track.client !== audio?.client);
  return [audio, alternate].filter(Boolean);
}

export function downloadPlans(formats, quality, includeAudio) {
  const plans = [];
  const audioTracks = includeAudio ? bestAudio(formats) : [];
  for (const video of formats) {
    if (!video.format.has_video) continue;
    const height = resolution(video.format);
    if (!height) continue;
    const outputHeight = quality || height;
    const resize = outputHeight !== height;
    const common = { video, height, outputHeight, resize };
    if (includeAudio && !video.format.has_audio) {
      for (const audio of audioTracks) plans.push({ ...common, audio, route: resize ? "resize" : "merge" });
    } else {
      const route = resize ? "resize"
        : video.format.has_audio && !includeAudio ? "strip"
        : video.container === "mp4" ? "direct" : "convert";
      plans.push({ ...common, route });
    }
  }
  const preference = height => !quality ? 0 : height === quality ? 0 : height > quality ? 1 : 2;
  return plans.sort((a, b) => preference(a.height) - preference(b.height) ||
    (quality && a.height >= quality ? a.height - b.height : b.height - a.height) ||
    Number(b.route === "direct") - Number(a.route === "direct") ||
    Number(b.video.container === "mp4") - Number(a.video.container === "mp4") ||
    Number(Boolean(a.audio)) - Number(Boolean(b.audio)) ||
    (b.video.format.fps || 0) - (a.video.format.fps || 0));
}
