import assert from "node:assert/strict";

function normalizeCodexUsageWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
  return {
    usedPercent: typeof window.used_percent === "number" ? window.used_percent : 0,
    windowSeconds: typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : 0,
    resetAt: typeof window.reset_at === "number" ? window.reset_at : undefined,
  };
}

function matchesUsageWindow(window, expectedSeconds) {
  if (!window) return false;
  return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function parseCodexRateLimitState(rateLimit) {
  if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) return undefined;
  const allowed = typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : undefined;
  const limitReached = typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : undefined;
  if (allowed === undefined && limitReached === undefined) return undefined;
  return { allowed, limitReached };
}

function parseCodexUsageSnapshot(data) {
  const rateLimit = data?.rate_limit || {};
  const windows = [
    normalizeCodexUsageWindow(rateLimit.primary_window),
    normalizeCodexUsageWindow(rateLimit.secondary_window),
  ].filter(Boolean);
  return {
    planType: typeof data?.plan_type === "string" ? data.plan_type : "unknown",
    email: typeof data?.email === "string" ? data.email : "",
    primary: windows[0],
    fiveHour: windows.find((window) => matchesUsageWindow(window, 5 * 60 * 60)),
    weekly: windows.find((window) => matchesUsageWindow(window, 7 * 24 * 60 * 60)),
    rateLimit: parseCodexRateLimitState(rateLimit),
  };
}

function getCodexWindowRemaining(window) {
  if (!window) return undefined;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function classifyCodexQuotaKind(snapshot) {
  const values = [getCodexWindowRemaining(snapshot.fiveHour), getCodexWindowRemaining(snapshot.weekly)]
    .filter((value) => value !== undefined);
  if (snapshot.rateLimit?.limitReached === true || snapshot.rateLimit?.allowed === false) {
    return { kind: "blocked", score: 0 };
  }
  if (values.length === 0) {
    const primaryLeft = getCodexWindowRemaining(snapshot.primary);
    if (primaryLeft !== undefined) values.push(primaryLeft);
  }
  if (values.length === 0) {
    if (snapshot.rateLimit?.allowed === true || snapshot.rateLimit?.limitReached === false) {
      return { kind: "ready", score: 100 };
    }
    return { kind: "error", score: 0 };
  }
  const bottleneck = Math.min(...values);
  if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

function subDisplayName(entry) {
  const providerNames = {
    "openai-codex": "ChatGPT Plus/Pro (Codex)",
    anthropic: "Anthropic (Claude Pro/Max)",
  };
  const providerName = `${providerNames[entry.provider] || entry.provider} #${entry.index}`;
  if (!entry.label) return providerName;
  return `${entry.label} — ${providerName}`;
}

function runWindowClassificationChecks() {
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const snapshot = parseCodexUsageSnapshot({
    plan_type: "pro",
    email: "test@example.com",
    rate_limit: {
      // Intentionally reversed from the human-friendly order.
      primary_window: {
        used_percent: 35,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt + 6 * 24 * 60 * 60,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: resetAt,
      },
    },
  });

  assert.equal(snapshot.planType, "pro");
  assert.equal(snapshot.email, "test@example.com");
  assert.equal(snapshot.fiveHour.windowSeconds, 5 * 60 * 60);
  assert.equal(snapshot.weekly.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(getCodexWindowRemaining(snapshot.fiveHour), 90);
  assert.equal(getCodexWindowRemaining(snapshot.weekly), 65);
}

function runCurrentWhamUsageSchemaChecks() {
  const snapshot = parseCodexUsageSnapshot({
    plan_type: "team",
    email: "test@example.com",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 0,
        reset_after_seconds: 0,
        reset_at: 1780467085,
      },
      secondary_window: null,
    },
  });

  assert.equal(snapshot.planType, "team");
  assert.equal(snapshot.email, "test@example.com");
  assert.equal(snapshot.primary.windowSeconds, 0);
  assert.equal(snapshot.fiveHour, undefined);
  assert.equal(snapshot.weekly, undefined);
  assert.deepEqual(snapshot.rateLimit, { allowed: true, limitReached: false });
  assert.deepEqual(classifyCodexQuotaKind(snapshot), { kind: "ready", score: 100 });
}

function runCurrentWhamBlockedSchemaChecks() {
  const snapshot = parseCodexUsageSnapshot({
    rate_limit: {
      allowed: false,
      limit_reached: true,
      primary_window: {
        used_percent: 0,
        limit_window_seconds: 0,
      },
    },
  });

  assert.deepEqual(classifyCodexQuotaKind(snapshot), { kind: "blocked", score: 0 });
}

function runSeverityChecks() {
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 40 } }).kind,
    "ready",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 75 }, weekly: { usedPercent: 20 } }).kind,
    "watch",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 88 }, weekly: { usedPercent: 15 } }).kind,
    "low",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 97 }, weekly: { usedPercent: 10 } }).kind,
    "blocked",
  );
  assert.equal(classifyCodexQuotaKind({}).kind, "error");
}

function runDisplayNameChecks() {
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 2 }),
    "ChatGPT Plus/Pro (Codex) #2",
  );
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 3, label: "Outlook" }),
    "Outlook — ChatGPT Plus/Pro (Codex) #3",
  );
}

runWindowClassificationChecks();
runCurrentWhamUsageSchemaChecks();
runCurrentWhamBlockedSchemaChecks();
runSeverityChecks();
runDisplayNameChecks();
console.log("subscription limit checks passed");
