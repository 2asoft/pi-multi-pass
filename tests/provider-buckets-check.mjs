import assert from "node:assert/strict";

import {
  getBlockedQuotaRetryAt,
  getFailureSuppressionUntil,
  parseSelectionBuckets,
  planQuotaFirstSelection,
  selectEligibleBuckets,
} from "../extensions/provider-selection.ts";

function runBucketParsingChecks() {
  const buckets = parseSelectionBuckets([
    { id: "plus", members: ["openai-codex-2", "openai-codex-3", "unknown"] },
    { id: "pro", members: ["openai-codex-3", "openai-codex-4"] },
    { id: "pro", members: ["openai-codex-5"] },
    { id: "empty", members: ["unknown"] },
  ], new Set([
    "openai-codex",
    "openai-codex-2",
    "openai-codex-3",
    "openai-codex-4",
    "openai-codex-5",
  ]));

  assert.deepEqual(buckets, [
    { id: "plus", members: ["openai-codex-2", "openai-codex-3"] },
    { id: "pro", members: ["openai-codex-4"] },
  ]);
  assert.deepEqual(parseSelectionBuckets(undefined, new Set(["openai-codex-2"])), []);
}

function runEligibilityChecks() {
  const buckets = [
    { id: "plus", members: ["plus-a", "plus-b"] },
    { id: "pro", members: ["pro-a", "pro-b"] },
  ];

  assert.deepEqual(
    selectEligibleBuckets(buckets, new Set(["plus-b", "pro-a"])),
    [
      { id: "plus", members: ["plus-b"] },
      { id: "pro", members: ["pro-a"] },
    ],
  );
}

function runFailureSuppressionChecks() {
  assert.equal(getBlockedQuotaRetryAt([
    { remaining: 4, resetAtSeconds: 2 },
    { remaining: 0, resetAtSeconds: 5 },
    { remaining: 50, resetAtSeconds: 10 },
  ]), 5_000);
  assert.equal(getBlockedQuotaRetryAt([{ remaining: 6, resetAtSeconds: 2 }]), undefined);
  assert.equal(getFailureSuppressionUntil(1_000, 300, 2_000), 2_000);
  assert.equal(getFailureSuppressionUntil(1_000, 300), 1_300);
  assert.equal(getFailureSuppressionUntil(1_000, 300, 900), 1_300);
}

function runQuotaSelectionChecks() {
  const buckets = [
    { id: "plus", members: ["plus-a", "plus-b"] },
    { id: "pro", members: ["pro-a", "pro-b"] },
  ];

  assert.deepEqual(planQuotaFirstSelection(buckets, new Map([
    ["plus-a", { kind: "blocked", score: 0 }],
    ["plus-b", { kind: "blocked", score: 0 }],
    ["pro-a", { kind: "ready", score: 90 }],
    ["pro-b", { kind: "ready", score: 60 }],
  ])), { kind: "selected", providerName: "pro-a" });

  assert.deepEqual(planQuotaFirstSelection(buckets, new Map([
    ["plus-a", { kind: "error", score: 0 }],
    ["plus-b", { kind: "blocked", score: 0 }],
    ["pro-a", { kind: "ready", score: 100 }],
  ])), {
    kind: "round-robin",
    bucketId: "plus",
    providerNames: ["plus-a"],
  });

  assert.deepEqual(planQuotaFirstSelection(buckets, new Map([
    ["plus-a", { kind: "ready", score: 25 }],
    ["plus-b", { kind: "ready", score: 75 }],
    ["pro-a", { kind: "ready", score: 100 }],
  ])), { kind: "selected", providerName: "plus-b" });

  assert.deepEqual(planQuotaFirstSelection(buckets, new Map([
    ["plus-a", { kind: "watch", score: 90 }],
    ["plus-b", { kind: "ready", score: 35 }],
  ])), { kind: "selected", providerName: "plus-b" });

  assert.deepEqual(planQuotaFirstSelection(buckets, new Map([
    ["plus-a", { kind: "blocked", score: 0 }],
    ["plus-b", { kind: "blocked", score: 0 }],
    ["pro-a", { kind: "blocked", score: 0 }],
    ["pro-b", { kind: "blocked", score: 0 }],
  ])), { kind: "unavailable" });

  assert.deepEqual(planQuotaFirstSelection([], new Map()), { kind: "unavailable" });
  assert.deepEqual(planQuotaFirstSelection(buckets, new Map([
    ["plus-a", { kind: "blocked", score: 0 }],
    ["pro-a", { kind: "ready", score: 100 }],
  ])), {
    kind: "round-robin",
    bucketId: "plus",
    providerNames: ["plus-b"],
  });
}

runBucketParsingChecks();
runEligibilityChecks();
runFailureSuppressionChecks();
runQuotaSelectionChecks();
console.log("provider bucket checks passed");
