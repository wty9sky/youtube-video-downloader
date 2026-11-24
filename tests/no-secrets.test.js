import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ignoredDirectories = new Set([".git", "node_modules", "dist"]);
const binaryExtension = /\.(wasm|png|jpe?g|gif|ico|zip)$/i;
const googleApiKey = /AIza[0-9A-Za-z_-]{20,}/;

async function* sourceFiles(directory = ".") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) yield* sourceFiles(path);
    } else if (entry.isFile() && !binaryExtension.test(entry.name)) {
      yield path;
    }
  }
}

test("sources and generated vendor files contain no Google API key", async () => {
  const matches = [];
  for await (const path of sourceFiles()) {
    let contents;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (googleApiKey.test(contents)) matches.push(path);
  }
  assert.deepEqual(matches, []);
});
