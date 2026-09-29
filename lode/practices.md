# Practices

## Configuration

- Parse global JSON through normalization before domain code consumes it.
- Preserve manual access when excluding a provider from automatic selection.
- Do not infer selection buckets from provider names, labels, plans, or quota metadata.
- New and legacy configs without buckets have no automatic providers.

## Executable behavior

- Development dependencies target Pi 0.99.0. Use upstream virtual models for logical selection; preserve physical account IDs on responses and logical IDs in session selection.
- Run `PI_TEST_CLI=/path/to/pi-mono/packages/coding-agent/dist/cli.js npm test` to verify account failover, automatic compaction recovery, and session restore against the local stack's recovery retries and provider instances. Routing tests use local providers, never live credentials.
- List extension factory files explicitly in `package.json` under `pi.extensions`. Directory entries also load helper `.ts` files as extensions.
- Add focused checks under `tests/` for selection and retry contracts.
- Run `npm test` and `npm run typecheck` after the last executable edit.
- Keep provider-specific quota parsing separate from provider-neutral bucket ordering.

## Documentation and memory

- Update `README.md` when user-visible config, dashboard behavior, or failover semantics change.
- Update [provider selection](provider-selection/summary.md) when eligibility, bucket ordering, or suppression changes.
