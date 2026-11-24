import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const { version } = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const output = resolve("dist", `youtube-video-downloader-v${version}.zip`);
await mkdir("dist", { recursive: true });
const staging = await mkdtemp(resolve("dist", ".package-"));
const contents = join(staging, "contents");
const archive = join(staging, "extension.zip");
try {
  await cp("extension", contents, { recursive: true });
  for (const filename of ["README.md", "CHANGELOG.md"]) {
    await copyFile(filename, join(contents, filename));
  }
  execFileSync("zip", ["-q", "-r", archive, ".", "-x", "*.DS_Store"], { cwd: contents });
  await rename(archive, output);
} finally {
  await rm(staging, { recursive: true, force: true });
}
console.log(output);
