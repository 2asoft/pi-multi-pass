# pi-multi-pass

pi-multi-pass is a Pi extension that registers equivalent OAuth accounts as provider instances and switches among them after runtime quota exhaustion.

## Boundaries and flow

- `extensions/multi-sub.ts` owns config parsing, provider registration, quota checks, dashboard workflows, and Pi event integration.
- `extensions/provider-selection.ts` owns ordered bucket parsing and quota-first bucket decisions.
- Global config is stored at `~/.pi/agent/multi-pass.json`. The project has no project-local runtime config.
- The extension reacts to quota-exhaustion errors from `message_end` and `compaction_error`, switches to an equivalent provider serving the same model ID, and requests a true retry.
- Manual switching and account management use `/subs`.

## Governing constraints

- Automatic selection is explicit. Only providers assigned to an ordered selection bucket participate.
- Provider instances within one equivalent set must derive from the same base provider.
- Automatic failover preserves the current model ID.
- Server overload and capacity errors do not trigger subscription failover.

See [provider selection](provider-selection/summary.md) for ordering and availability rules.
