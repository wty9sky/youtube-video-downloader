import { readFile } from "node:fs/promises";

const { version } = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const changelog = await readFile("CHANGELOG.md", "utf8");
const heading = new RegExp(`^##\\s+v?${version.replaceAll(".", "\\.")}\\s*$`);
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex(line => heading.test(line.trim()));
const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
const notes = start === -1
  ? ""
  : lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();

console.log(notes || `版本 ${version}。更新内容见 CHANGELOG.md。`);
