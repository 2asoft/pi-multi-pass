import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

assert.deepEqual(
  packageManifest.pi?.extensions,
  ["./extensions/multi-sub.ts"],
  "the package must load only extension factories, not helper modules",
);

console.log("package manifest checks passed");
