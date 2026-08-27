import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pi = join(root, "node_modules", ".bin", "pi");

function withAgentConfig(config, run) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-"));
  try {
    writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify(config));
    return run(agentDir);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function setConfig({ id, baseProvider, providerName }) {
  return {
    sets: [{
      id,
      baseProvider,
      members: [{ providerName, enabled: true }],
      autoSwitch: {
        enabled: true,
        strategy: "round-robin",
        cooldownMs: 300000,
        buckets: [{ id: "primary", members: [providerName] }],
      },
    }],
  };
}

function runInitialSelectionCheck() {
  const result = withAgentConfig(
    setConfig({ id: "anthropic", baseProvider: "anthropic", providerName: "anthropic" }),
    (agentDir) => spawnSync(pi, [
      "--no-extensions",
      "-e", root,
      "--offline",
      "--model", "multi-pass-anthropic/claude-sonnet-4-6",
      "--mode", "rpc",
      "--no-session",
    ], {
      cwd: root,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "unused-test-key",
        PI_CODING_AGENT_DIR: agentDir,
      },
      input: `${JSON.stringify({ id: "state", type: "get_state" })}\n`,
      encoding: "utf8",
    }),
  );

  assert.equal(result.status, 0, result.stderr);
  const response = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((event) => event.id === "state");
  assert.equal(response?.data?.model?.provider, "anthropic");
  assert.equal(response?.data?.model?.id, "claude-sonnet-4-6");
}

async function runInSessionSelectionCheck() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-"));
  writeFileSync(
    join(agentDir, "multi-pass.json"),
    JSON.stringify(setConfig({ id: "anthropic", baseProvider: "anthropic", providerName: "anthropic" })),
  );
  const child = spawn(pi, [
    "--no-extensions",
    "-e", root,
    "--offline",
    "--model", "anthropic/claude-sonnet-4-6",
    "--mode", "rpc",
    "--no-session",
  ], {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "unused-test-key",
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${stderr}`)), 10000);
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.id === "set") {
            assert.equal(event.success, true);
            assert.equal(event.command, "set_model");
            assert.equal(event.data?.provider, "multi-pass-anthropic");
            child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "test" })}\n`);
          } else if (event.type === "extension_ui_request" && event.statusText === "anthropic via anthropic") {
            child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
          } else if (event.id === "state") {
            clearTimeout(timeout);
            resolve(event);
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`RPC exited ${code}: ${stderr}`)));
      child.stdin.write(`${JSON.stringify({
        id: "set",
        type: "set_model",
        provider: "multi-pass-anthropic",
        modelId: "claude-sonnet-4-6",
      })}\n`);
    });

    assert.equal(response?.data?.model?.provider, "anthropic");
    assert.equal(response?.data?.model?.id, "claude-sonnet-4-6");
  } finally {
    lines.close();
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function runFailClosedCheck() {
  const result = withAgentConfig(
    setConfig({ id: "codex", baseProvider: "openai-codex", providerName: "openai-codex" }),
    (agentDir) => spawnSync(pi, [
      "--no-extensions",
      "-e", root,
      "--offline",
      "--model", "multi-pass-codex/gpt-5.6-sol",
      "-p", "This request must fail locally.",
    ], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      encoding: "utf8",
    }),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Multi-pass could not route multi-pass-codex\/gpt-5\.6-sol/);
  assert.equal(result.stdout, "");
}

runInitialSelectionCheck();
await runInSessionSelectionCheck();
runFailClosedCheck();
console.log("logical provider checks passed");
