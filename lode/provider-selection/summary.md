# Provider selection

## Responsibility

Provider selection chooses an automatic failover target from an equivalent set after the current provider returns a quota-exhaustion error. It does not classify account plans, choose model IDs, or affect manual switching.

## Configuration contract

`autoSwitch.buckets` is an ordered array of `{ id, members }` objects. Users assign and order buckets explicitly.

- A provider may appear in at most one bucket.
- Any member may remain outside every bucket; it is then manual-only.
- Missing buckets mean no provider participates automatically. Legacy members are not migrated into a default bucket.
- Normalization removes unknown members, repeated assignments, repeated bucket IDs, and empty buckets.
- `members[].enabled` can suspend an assigned member without removing its placement.

## Selection flow

1. Exclude members that are disabled, unauthenticated, failure-suppressed, equal to the failed provider, or unable to serve the current model ID.
2. Preserve configured bucket order and member order.
3. For `round-robin`, select within the first bucket containing an eligible member.
4. For `quota-first`, select the highest-ranked quota-usable member in the first usable bucket.
5. If quota data is unavailable in an earlier bucket, round-robin among its unknown members instead of advancing.
6. If every eligible member in a bucket is known blocked, advance to the next bucket.
7. If no bucket is usable, do not switch.

Quota scores are comparable only within a bucket. For example, when all Plus members in the first bucket are blocked, selection advances to the Pro bucket. A Pro member's larger quota cannot outrank a usable Plus member.

## Failure suppression

After quota exhaustion, the failed provider is unavailable until the quota checker's reset time when one is reported. Otherwise it is unavailable for `autoSwitch.cooldownMs`. Suppression is runtime state and is cleared by process restart.

## Anchors

- `extensions/provider-selection.ts`: config normalization and provider-neutral quota-first bucket planning.
- `extensions/multi-sub.ts`: eligibility, quota checks, round-robin state, dashboard management, and retry integration.
- `tests/provider-buckets-check.mjs`: strict ordering, blocked-bucket advancement, and unknown-quota fallback.
- `README.md`: operator-facing configuration and behavior.
