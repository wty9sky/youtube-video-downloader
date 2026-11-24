import assert from "node:assert/strict";
import test from "node:test";
import { downloadPlans } from "../extension/formats.js";
import { heights, qualityLabel, youtubeTarget } from "../extension/shared.js";

const track = (height, hasAudio, container = "mp4", client = "IOS") => ({
  client, container,
  format: { quality_label: height && `${height}p`, has_video: height > 0, has_audio: hasAudio },
});

test("uses Chrome for matching MP4 and keeps a separate-track fallback", () => {
  const combined = track(720, true);
  const separate = track(720, false);
  const audio = track(0, true);
  const plans = downloadPlans([separate, audio, combined], 720, true);
  assert.deepEqual(plans.map(plan => plan.route), ["direct", "merge"]);
  assert.equal(plans[1].audio, audio);
});

test("uses MP4 processing for WebM even when no track needs merging", () => {
  const webm = track(720, true, "webm");
  assert.equal(downloadPlans([webm], 720, true)[0].route, "convert");
});

test("chooses an audio-free direct download or strips embedded audio", () => {
  const combined = track(1080, true);
  const silent = track(1080, false);
  assert.equal(downloadPlans([combined, silent], 1080, false)[0].route, "direct");
  assert.equal(downloadPlans([combined], 1080, false)[0].route, "strip");
});

test("uses the best lower-resolution source when the requested resolution is unavailable", () => {
  const plans = downloadPlans([track(720, true), track(1080, true)], 2160, true);
  assert.deepEqual(plans.map(plan => [plan.height, plan.outputHeight, plan.route]), [
    [1080, 2160, "resize"], [720, 2160, "resize"],
  ]);
});

test("uses a higher source for exact lower output when available", () => {
  const plans = downloadPlans([track(1440, true), track(720, true)], 1080, true);
  assert.equal(plans[0].height, 1440);
  assert.equal(plans[0].outputHeight, 1080);
});

test("labels 1440p and 2160p as 2K and 4K", () => {
  assert.deepEqual(heights.slice(1, 4).map(qualityLabel), ["4K", "2K", "1080p"]);
});

test("uses the playlist when the current watch URL also specifies one", () => {
  assert.deepEqual(youtubeTarget("https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLExample"), {
    type: "playlist", id: "PLExample",
  });
  assert.equal(youtubeTarget("https://youtube.com.example/watch?v=jNQXAC9IVRw"), null);
});
