import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");

function pickPrimeModel(models, preferredModelId) {
  if (models.length === 0) return undefined;
  if (preferredModelId) {
    const preferred = models.find((model) => model.id === preferredModelId);
    if (preferred) return preferred;
  }
  return [...models].sort((left, right) => {
    const leftCost = typeof left.cost?.input === "number" ? left.cost.input : Number.POSITIVE_INFINITY;
    const rightCost = typeof right.cost?.input === "number" ? right.cost.input : Number.POSITIVE_INFINITY;
    return leftCost - rightCost || left.id.localeCompare(right.id);
  })[0];
}

function buildPrimeContext(now = Date.now()) {
  return {
    systemPrompt: "Reply with the single character y.",
    messages: [{ role: "user", content: "y", timestamp: now }],
  };
}

function formatPrimeResult({ providerName, modelId, response, quotaSummary }) {
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    return {
      ok: false,
      message: `Prime failed for ${providerName}: ${response.errorMessage || response.stopReason}`,
    };
  }
  const input = response.usage?.input;
  const output = response.usage?.output;
  const tokenPart = typeof input === "number" && typeof output === "number"
    ? `tokens in=${input} out=${output}`
    : "request completed";
  const quotaPart = quotaSummary ? ` | ${quotaSummary}` : "";
  return {
    ok: true,
    message: `Primed ${providerName} via ${modelId}: ${tokenPart}${quotaPart}`,
  };
}

function runModelSelectionChecks() {
  const models = [
    { id: "expensive", cost: { input: 5 } },
    { id: "cheap", cost: { input: 0.2 } },
    { id: "mid", cost: { input: 1 } },
  ];
  assert.equal(pickPrimeModel(models)?.id, "cheap");
  assert.equal(pickPrimeModel(models, "mid")?.id, "mid");
  assert.equal(pickPrimeModel([], "mid"), undefined);
}

function runPrimeContextChecks() {
  const context = buildPrimeContext(123);
  assert.equal(context.systemPrompt, "Reply with the single character y.");
  assert.deepEqual(context.messages, [{ role: "user", content: "y", timestamp: 123 }]);
}

function runPrimeResultChecks() {
  assert.deepEqual(
    formatPrimeResult({
      providerName: "openai-codex-2",
      modelId: "gpt-5.6-luna",
      response: { stopReason: "stop", usage: { input: 12, output: 1 } },
      quotaSummary: "plus | 5h 99% (~5h) | ready",
    }),
    {
      ok: true,
      message: "Primed openai-codex-2 via gpt-5.6-luna: tokens in=12 out=1 | plus | 5h 99% (~5h) | ready",
    },
  );
  assert.deepEqual(
    formatPrimeResult({
      providerName: "openai-codex",
      modelId: "gpt-5.4",
      response: { stopReason: "error", errorMessage: "usage limit reached" },
    }),
    {
      ok: false,
      message: "Prime failed for openai-codex: usage limit reached",
    },
  );
}

function runSourceContractChecks() {
  assert.match(source, /case "prime":/);
  assert.match(source, /value: "prime"/);
  assert.match(source, /function pickPrimeModel/);
  assert.match(source, /function buildPrimeContext/);
  assert.match(source, /function formatPrimeResult/);
  assert.match(source, /function primeSubscription/);
  assert.match(source, /modelRegistry\.complete\(/);
  assert.match(source, /maxTokens:\s*16/);
  assert.doesNotMatch(source, /sendUserMessage\(/);
}

runModelSelectionChecks();
runPrimeContextChecks();
runPrimeResultChecks();
runSourceContractChecks();
console.log("prime subscription checks passed");
