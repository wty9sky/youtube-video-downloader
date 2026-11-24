import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const vendor = "extension/vendor";
await mkdir(vendor, { recursive: true });

const stripYouTubeApiKey = {
  name: "strip-youtube-api-key",
  setup(build) {
    build.onLoad({ filter: /[\\/]utils[\\/]Constants\.js$/ }, async ({ path }) => {
      const contents = (await readFile(path, "utf8"))
        .replace(/API_KEY:\s*['"]AIza[0-9A-Za-z_-]+['"]/g, 'API_KEY: ""');
      return { contents, loader: "js" };
    });
  },
};

const entries = {
  youtube: `export { Innertube, Platform, Parser } from "youtubei.js/web";
    export { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
    export { default as quickJSVariant } from "@jitl/quickjs-wasmfile-release-sync";`,
  media: `export { ALL_FORMATS, BlobSource, canEncodeVideo, Conversion,
    Input, Mp4OutputFormat, Output, StreamTarget, TextSubtitleSource } from "mediabunny";`,
};
for (const [name, contents] of Object.entries(entries)) {
  await build({
    stdin: { contents, resolveDir: process.cwd(), sourcefile: name + ".js" },
    plugins: [stripYouTubeApiKey],
    outfile: `${vendor}/${name}.js`,
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    target: "chrome116",
  });
}
await copyFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"), `${vendor}/quickjs.wasm`);

const packages = [
  "youtubei.js", "fflate", "meriyah", "@bufbuild/protobuf", "mediabunny",
  "quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "@jitl/quickjs-ffi-types",
];
const notices = [];
for (const name of packages) {
  const root = resolve("node_modules", name);
  const files = await readdir(root);
  for (const file of files.filter(file => /^(license|copying|notice)/i.test(file))) {
    notices.push(`### ${name} / ${file}\n\n${await readFile(resolve(root, file), "utf8")}`);
  }
}
notices.push(`### @bufbuild/protobuf\n\n${await readFile("scripts/licenses/protobuf-es.txt", "utf8")}`);
notices.push("Mediabunny 1.66.3 source: https://github.com/Vanilagy/mediabunny/tree/v1.66.3");
await writeFile(`${vendor}/LICENSES.txt`, notices.join("\n\n"));
