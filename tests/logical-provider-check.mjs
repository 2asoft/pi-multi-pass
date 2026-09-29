import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pi = process.env.PI_TEST_CLI || join(root, "node_modules", ".bin", "pi");
const logicalProvider = "multi-pass-anthropic";
const modelId = "claude-sonnet-4-6";

async function withSession({ error, errors, autoCompact = false, enabled = true, buckets, cooldownMs = 300000, model = logicalProvider, sessionPath } = {}, run) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-"));
  writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
    sets: [{
      id: "anthropic",
      baseProvider: "anthropic",
      members: ["anthropic", "anthropic-2"].map((providerName) => ({ providerName, enabled: true })),
      autoSwitch: {
        enabled, strategy: "round-robin", cooldownMs,
        buckets: buckets ?? [
          { id: "primary", members: ["anthropic"] },
          { id: "fallback", members: ["anthropic-2"] },
        ],
      },
    }],
  }));
  // "quota exhausted" requires the local extension retry signal. Overload stays terminal here.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    retry: { enabled: error === "quota exhausted" || autoCompact, baseDelayMs: 1, maxDelayMs: 1, maxRetries: 2 },
    compaction: { enabled: autoCompact, keepRecentTokens: 1 },
  }));
  const child = spawn(pi, [
    "--no-extensions", "-e", root,
    "-e", join(root, "tests/fixtures/selector-provider.ts"),
    "--offline", "--mode", "rpc",
    ...(sessionPath ? ["--session", sessionPath] : ["--model", `${model}/${modelId}`, "--session-dir", join(agentDir, "sessions")]),
  ], {
    cwd: root,
    env: {
      ...process.env, PI_CODING_AGENT_DIR: agentDir,
      MULTI_PASS_TEST_ERRORS: JSON.stringify(errors ?? (error ? { 1: error } : {})),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const events = [];
  const waiters = new Set();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    for (const waiter of waiters) waiter();
  });
  let commandId = 0;
  function waitFor(predicate, start = 0) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`RPC timeout: ${stderr}\n${JSON.stringify(events.slice(start))}`));
      }, 15000);
      function check() {
        const found = events.slice(start).find(predicate);
        if (found) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        }
      }
      waiters.add(check);
      check();
    });
  }
  async function command(type, data = {}) {
    const id = String(++commandId);
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    return waitFor((event) => event.id === id);
  }
  async function prompt() {
    const start = events.length;
    const response = await command("prompt", { message: "test" });
    assert.equal(response.success, true, JSON.stringify(response));
    await waitFor((event) => event.type === "agent_settled", start);
    return events.slice(start).filter((event) => event.type === "message_end" && event.message.role === "assistant")
      .map((event) => event.message);
  }
  try {
    await run({ command, prompt, events });
  } finally {
    lines.close();
    if (child.exitCode === null) child.kill();
    await exit;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

await withSession({}, async ({ command, prompt }) => {
  const initial = await command("get_state");
  assert.equal(initial.data.model.provider, logicalProvider);
  assert.equal(initial.data.model.api, "pi-virtual");
  for (let turn = 0; turn < 2; turn++) {
    const messages = await prompt();
    assert.equal(messages.at(-1).provider, "anthropic");
    assert.equal(messages.at(-1).model, modelId);
    assert.equal(messages.at(-1).stopReason, "stop");
    assert.equal((await command("get_state")).data.model.provider, logicalProvider);
  }
});

await withSession({ model: "anthropic" }, async ({ command, prompt }) => {
  assert.equal((await prompt()).at(-1).provider, "anthropic");
  assert.equal((await command("get_state")).data.model.provider, "anthropic");
  assert.equal((await command("set_model", { provider: logicalProvider, modelId })).success, true);
  assert.equal((await prompt()).at(-1).provider, "anthropic");
  assert.equal((await command("get_state")).data.model.provider, logicalProvider);
});

for (const options of [{ enabled: false }, { buckets: [] }]) {
  await withSession(options, async ({ command, prompt }) => {
    const messages = await prompt();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].stopReason, "error");
    assert.match(messages[0].errorMessage, /Multi-pass could not route/);
    assert.equal(messages[0].provider, logicalProvider);
    assert.equal((await command("get_state")).data.model.provider, logicalProvider);
  });
}

await withSession({ error: "server overloaded" }, async ({ command, prompt }) => {
  const messages = await prompt();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].provider, "anthropic");
  assert.equal(messages[0].stopReason, "error");
  assert.equal((await command("get_state")).data.model.provider, logicalProvider);
});

// Recovery retries and independent provider instances are local Pi stack features.
if (process.env.PI_TEST_CLI) {
  for (const [model, cooldownMs] of [[logicalProvider, 300000], [logicalProvider, 0], ["anthropic", 300000]]) {
    await withSession({ error: "quota exhausted", model, cooldownMs }, async ({ command, prompt }) => {
      const messages = await prompt();
      assert.deepEqual(messages.map((message) => message.provider), ["anthropic", "anthropic-2"]);
      assert.equal(messages.at(-1).stopReason, "stop");
      assert.equal((await command("get_state")).data.model.provider,
        model === logicalProvider ? logicalProvider : "anthropic-2");
      assert.equal((await prompt()).at(-1).provider, "anthropic-2");
      if (model === logicalProvider) {
        const sessionPath = (await command("get_state")).data.sessionFile;
        assert.ok(sessionPath);
        // A fresh host has no quota suppression or round-robin cursor; routing state must restore the account.
        await withSession({ sessionPath }, async ({ command, prompt }) => {
          assert.equal((await command("get_state")).data.model.provider, logicalProvider);
          assert.equal((await prompt()).at(-1).provider, "anthropic-2");
        });
      }
    });
  }
  await withSession({
    autoCompact: true,
    errors: { 3: "prompt is too long", 4: "quota exhausted" },
  }, async ({ command, prompt, events }) => {
    await prompt();
    await prompt();
    const messages = await prompt();
    assert.equal(messages.at(-1).provider, "anthropic-2");
    assert.equal(messages.at(-1).stopReason, "stop");
    const compacted = events.find((event) => event.type === "compaction_end");
    assert.match(compacted?.result?.summary ?? "", /response from anthropic-2/);
    assert.equal((await command("get_state")).data.model.provider, logicalProvider);
    assert.equal((await prompt()).at(-1).provider, "anthropic-2");
  });
}

console.log(`virtual model checks passed${process.env.PI_TEST_CLI ? " (local recovery stack)" : ""}`);
