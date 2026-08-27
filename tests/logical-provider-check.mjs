import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
runFailClosedCheck();
console.log("logical provider checks passed");
