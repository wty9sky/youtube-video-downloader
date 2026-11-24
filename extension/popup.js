import { heights, idle, qualityLabel, STATE_KEY, youtubeTarget } from "./shared.js";

const form = document.querySelector("#load");
const input = document.querySelector("#url");
const loadButton = document.querySelector("#load-button");
const startButton = document.querySelector("#start-button");
const cancelButton = document.querySelector("#cancel-button");
const status = document.querySelector("#status");
const message = document.querySelector("#message");
const count = document.querySelector("#count");
const queueTitle = document.querySelector("#queue-title");
const list = document.querySelector("#videos");
const rowTemplate = document.querySelector("#video-row");
const listControls = document.querySelector("#list-controls");
const downloadControls = document.querySelector("#download-controls");
const selectAll = document.querySelector("#select-all");
const selectedCount = document.querySelector("#selected-count");
const quality = document.querySelector("#quality");
const includeAudio = document.querySelector("#include-audio");
const includeAutoCaptions = document.querySelector("#include-auto-captions");

const labels = {
  idle: "",
  queued: "等待下载",
  preparing: "准备中",
  captions: "读取字幕中",
  downloading: "下载中",
  processing: "正在处理",
  saving: "正在保存",
  done: "已完成",
  canceled: "已取消",
  error: "失败",
};
const routeLabels = { direct: "直接下载", merge: "内置合并", strip: "去除声音", convert: "转为 MP4", resize: "调整分辨率", caption: "合并字幕" };
const rows = new Map();
let state = idle;
let activeRow;
let pending = false;
let receivedUpdate = false;

for (const height of heights) {
  quality.add(new Option(height ? qualityLabel(height) : "最佳原画", String(height)));
}

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function renderVideos(videos, busy) {
  const follow = !activeRow || (
    activeRow.offsetTop < list.scrollTop + list.clientHeight &&
    activeRow.offsetTop + activeRow.offsetHeight > list.scrollTop
  );
  const indexes = new Set();
  let nextActiveRow;
  const added = document.createDocumentFragment();
  for (const video of videos) {
    const { index, title, phase, selected, available, percent, height, outputHeight, route } = video;
    indexes.add(index);
    let row = rows.get(index);
    if (!row) {
      const element = rowTemplate.content.firstElementChild.cloneNode(true);
      const [label, badge, bar, error] = element.children;
      const [check, number, name] = label.children;
      check.dataset.index = index;
      number.textContent = String(index).padStart(2, "0");
      row = { element, check, name, badge, bar, error };
      rows.set(index, row);
      added.append(element);
    }
    if (["preparing", "captions", "downloading", "processing", "saving"].includes(phase)) nextActiveRow = row.element;
    row.check.checked = selected;
    row.check.disabled = busy || !available;
    setText(row.name, title);
    row.element.dataset.phase = phase;
    const progress = Number.isFinite(percent);
    const active = phase === "downloading" || phase === "processing" || phase === "saving";
    const resolution = height && (outputHeight && outputHeight !== height
      ? `${qualityLabel(height)} → ${qualityLabel(outputHeight)}` : qualityLabel(height));
    const operation = video.hasAutoCaptions ? "已嵌入自动字幕" : routeLabels[route];
    const description = available
      ? [labels[phase], resolution, operation, active && progress && `${percent}%`].filter(Boolean).join(" · ")
      : "不可下载";
    setText(row.badge, description);
    row.bar.hidden = !active && phase !== "done";
    if (!row.bar.hidden) {
      row.bar.setAttribute("aria-label", `${title} 下载进度`);
      if (progress) row.bar.value = percent;
      else row.bar.removeAttribute("value");
    }
    row.error.hidden = !video.error && !video.note;
    row.error.classList.toggle("note", !video.error && Boolean(video.note));
    setText(row.error, video.error || video.note || "");
  }
  for (const [index, row] of rows) {
    if (indexes.has(index)) continue;
    row.element.remove();
    rows.delete(index);
  }
  list.append(added);
  list.hidden = !videos.length;
  if (follow && nextActiveRow && nextActiveRow !== activeRow) {
    const top = nextActiveRow.offsetTop;
    const bottom = top + nextActiveRow.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }
  activeRow = nextActiveRow;
}

function render(next = state) {
  const previousUrl = state.url;
  state = next;
  if (state.url && (!input.value || previousUrl !== state.url)) input.value = state.url;
  const canceling = state.phase === "canceling";
  const downloading = state.phase === "running" || canceling;
  const busy = pending || state.phase === "loading" || downloading;
  const { videos } = state;
  const selectable = videos.filter(video => video.available).length;
  const selected = videos.filter(video => video.selected).length;
  const completed = videos.filter(video => video.phase === "done").length;
  status.dataset.phase = state.phase;
  setText(message, state.message);
  queueTitle.hidden = !state.title;
  setText(queueTitle, state.title);
  count.hidden = !videos.length;
  setText(count, `${videos.length} 条视频${completed ? ` · 已完成 ${completed} 条` : ""}`);
  listControls.hidden = !videos.length;
  downloadControls.hidden = !videos.length;
  setText(selectedCount, `已选 ${selected} / ${selectable}`);
  selectAll.checked = selectable > 0 && selected === selectable;
  selectAll.indeterminate = selected > 0 && selected < selectable;
  selectAll.disabled = busy || !selectable;
  quality.value = String(state.quality);
  includeAudio.checked = state.includeAudio;
  includeAutoCaptions.checked = state.includeAutoCaptions === true;
  quality.disabled = busy;
  includeAudio.disabled = busy;
  includeAutoCaptions.disabled = busy;
  loadButton.disabled = busy;
  startButton.disabled = busy || !selected;
  startButton.hidden = downloading;
  cancelButton.hidden = !downloading;
  cancelButton.disabled = pending || canceling;
  setText(cancelButton, canceling ? "正在取消…" : "取消下载");
  input.readOnly = busy;
  setText(startButton, selected ? `下载所选（${selected}）` : "下载所选");
  renderVideos(videos, busy);
}

function showError(error) {
  status.dataset.phase = "error";
  setText(message, error.message ?? String(error));
}

async function send(action, fields) {
  const response = await chrome.runtime.sendMessage({ action, ...fields });
  if (!response || response.error) throw new Error(response?.error ?? "扩展后台未响应。");
  return response;
}

async function run(action, fields) {
  pending = true;
  render();
  try {
    await send(action, fields);
    pending = false;
    render();
  } catch (error) {
    pending = false;
    render();
    showError(error);
  }
}

form.addEventListener("submit", event => {
  event.preventDefault();
  const url = input.value.trim();
  if (!youtubeTarget(url)) {
    showError("请输入有效的 YouTube 视频或播放列表链接。");
    return;
  }
  run("load", { url });
});

list.addEventListener("change", event => {
  const checkbox = event.target;
  if (checkbox.matches(".video-check")) {
    send("select", { indexes: [Number(checkbox.dataset.index)], selected: checkbox.checked }).catch(showError);
  }
});

selectAll.addEventListener("change", () =>
  send("select", { all: true, selected: selectAll.checked }).catch(showError));

const settings = () => ({
  quality: Number(quality.value),
  includeAudio: includeAudio.checked,
  includeAutoCaptions: includeAutoCaptions.checked,
});
for (const control of [quality, includeAudio, includeAutoCaptions]) {
  control.addEventListener("change", () => send("settings", settings()).catch(showError));
}
startButton.addEventListener("click", () => run("start", settings()));
cancelButton.addEventListener("click", () => run("cancel"));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[STATE_KEY]?.newValue) {
    receivedUpdate = true;
    render(changes[STATE_KEY].newValue);
  }
});

send("status").then(result => {
  if (!receivedUpdate) render(result.state);
}).catch(showError);

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (!input.value && youtubeTarget(tab?.url)) input.value = tab.url;
}).catch(console.error);
