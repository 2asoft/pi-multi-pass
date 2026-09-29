# Provider selection

## Responsibility

Provider selection routes virtual models to concrete accounts and handles quota failover. It does not classify account plans, choose model IDs, or affect manual switching.

## Configuration contract

`autoSwitch.buckets` is an ordered array of `{ id, members }` objects. Users assign and order buckets explicitly. Set IDs form logical provider names after lowercase slug normalization. Config normalization keeps the first set when names collide.

- `autoSwitch.enabled` and the `manual` strategy disable both initial logical-provider selection and failover.
- A provider may appear in at most one bucket.
- Any member may remain outside every bucket; it is then manual-only.
- Missing buckets mean no provider participates automatically. Legacy members are not migrated into a default bucket.
- Normalization removes unknown members, repeated assignments, repeated bucket IDs, and empty buckets.
- `members[].enabled` can suspend an assigned member without removing its placement.

## Virtual model routing

Each set registers virtual models under `multi-pass-<set-id>` using the base provider's built-in catalog IDs, limits, inputs, and thinking levels. Pi retains the virtual selection and dispatches physical requests through `registerVirtualModel`. There is no fake provider, credential, or local error stream.

The router stores the chosen account in Pi's branch routing state and keeps it across turns while eligible. Retry requests prefer the failed account unless quota suppression excludes it. Direct requests, including compaction, follow the latest successful physical response when eligible; they have no branch routing state. If selection cannot produce a target, the router throws before any provider request.

`message_end` identifies the failed physical account from its assistant message. For automatic compaction, the runtime remembers the physical target of the latest direct route because `compaction_error` carries no model. Quota recovery suppresses the failed account and asks Pi to retry through the router. Manual compaction does not emit this recovery hook. A concrete selection retains the existing account-switch behavior.

## Selection flow

1. Exclude members that are disabled, unauthenticated, failure-suppressed, equal to the failed provider, or unable to serve the current model ID. The logical provider is not a member, so initial selection excludes no concrete member.
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
- `tests/provider-buckets-check.mjs`: logical provider naming, strict ordering, blocked-bucket advancement, and unknown-quota fallback.
- `tests/logical-provider-check.mjs` and `tests/fixtures/selector-provider.ts`: actual Pi RPC routing, stable virtual selection, local failures, and overload behavior; `PI_TEST_CLI` additionally exercises local account recovery, compaction recovery, and session restore without model API calls.
- `README.md`: operator-facing configuration and behavior.
