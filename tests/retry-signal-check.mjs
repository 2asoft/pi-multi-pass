import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");

assert.match(source, /\.on\("message_end"/);
assert.match(source, /\.on\("compaction_error"/);
assert.match(source, /return \{ retry: true \}/);
assert.doesNotMatch(source, /sendUserMessage\(/);
assert.doesNotMatch(source, /lastPrompt/);
assert.doesNotMatch(source, /suppressNextPrompt/);
assert.doesNotMatch(source, /agent_end/);
assert.doesNotMatch(source, /\/overloaded\/i/);
assert.doesNotMatch(source, /\/capacity\/i/);

console.log("retry signal checks passed");
