import assert from "node:assert/strict";

function getBaseProvider(providerName, supportedProviders) {
  if (supportedProviders.has(providerName)) return providerName;
  const match = providerName.match(/^(.+)-(\d+)$/);
  return match && supportedProviders.has(match[1]) ? match[1] : undefined;
}

function defaultSetId(baseProvider) {
  return baseProvider.replace(/^openai-/, "").replace(/-cli$/, "");
}

function memberIndex(providerName, baseProvider) {
  if (providerName === baseProvider) return 1;
  const match = providerName.match(/^(.+)-(\d+)$/);
  if (!match || match[1] !== baseProvider) return undefined;
  return Number.parseInt(match[2], 10);
}

function nextProviderName(set) {
  const used = new Set(set.members.map((member) => memberIndex(member.providerName, set.baseProvider)).filter(Number.isInteger));
  let next = 2;
  while (used.has(next)) next += 1;
  return `${set.baseProvider}-${next}`;
}

function ensureSet(config, baseProvider) {
  const existing = config.sets.find((set) => set.baseProvider === baseProvider);
  if (existing) return existing;
  const created = {
    id: defaultSetId(baseProvider),
    baseProvider,
    members: [{ providerName: baseProvider, enabled: true }],
    autoSwitch: { enabled: true, strategy: "quota-first", cooldownMs: 300000, buckets: [] },
  };
  config.sets.push(created);
  return created;
}

function addEquivalent(config, baseProvider, label) {
  const set = ensureSet(config, baseProvider);
  const providerName = nextProviderName(set);
  set.members.push({ providerName, label, enabled: true });
  return providerName;
}

function runAddEquivalentCheck() {
  const config = { sets: [] };
  assert.equal(addEquivalent(config, "openai-codex", "work"), "openai-codex-2");
  assert.equal(addEquivalent(config, "openai-codex", "personal"), "openai-codex-3");
  assert.deepEqual(config, {
    sets: [{
      id: "codex",
      baseProvider: "openai-codex",
      members: [
        { providerName: "openai-codex", enabled: true },
        { providerName: "openai-codex-2", label: "work", enabled: true },
        { providerName: "openai-codex-3", label: "personal", enabled: true },
      ],
      autoSwitch: { enabled: true, strategy: "quota-first", cooldownMs: 300000, buckets: [] },
    }],
  });
}

function runProviderParsingCheck() {
  const supported = new Set(["openai-codex", "github-copilot"]);
  assert.equal(getBaseProvider("openai-codex-2", supported), "openai-codex");
  assert.equal(getBaseProvider("github-copilot-3", supported), "github-copilot");
  assert.equal(getBaseProvider("unknown-2", supported), undefined);
}

runAddEquivalentCheck();
runProviderParsingCheck();
console.log("equivalent set checks passed");
