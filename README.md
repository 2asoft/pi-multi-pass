# pi-multi-pass

Multi-subscription extension for [pi](https://github.com/earendil-works/pi-coding-agent). Add equivalent OAuth accounts for the same provider and let pi switch between them automatically when the current account hits a rate limit.

## Install

```bash
pi install git:github.com/2asoft/pi-multi-pass
```

## Core idea

A subscription set contains equivalent accounts for one provider, for example ChatGPT Codex:

```text
codex
  openai-codex      native account
  openai-codex-2    work account
  openai-codex-3    personal account
```

Automatic switching uses ordered, user-managed selection buckets. Accounts outside every bucket remain available for manual switching but are never selected automatically. Accounts inside a bucket can also be temporarily disabled without changing their bucket assignment.

## Quick start

```text
/subs           Open the subscription dashboard, including refreshed quota
/subs add       Add an equivalent account for a provider
/login          Authenticate the new account
/subs switch    Manually switch account
/subs prime     Send a minimal request so the quota timer starts
```

When the active account returns a quota-exhaustion runtime error, multi-pass can switch to another enabled equivalent account and ask pi to retry the same turn with the same model ID. Server overload, capacity, and other non-quota errors do not switch accounts. The failed assistant error stays in session history, but the user prompt is not duplicated in model context.

## Commands

```text
/subs              Open the subscription dashboard
/subs add          Add an equivalent account
/subs switch       Quick manual switch
/subs prime        Send a minimal request to start the quota timer
/subs login        Shortcut to login instructions
/subs logout       Shortcut to log out an account
/subs remove       Shortcut to remove an account
```

The dashboard always refreshes quota and combines status, limits, bucket placement, and auto-switch settings. Select a set to change its policy, strategy, or bucket order. Select an account to switch, assign a bucket, enable or disable selection within its bucket, prime the subscription, view quota details, login/logout, or remove it.

## Prime subscription

Some providers only start a rolling quota window after the first real model request. Use `/subs prime` or the dashboard **prime subscription** action to send the smallest practical completion for a logged-in account. multi-pass keeps the current session model unchanged, prefers the current model id when that account can serve it, otherwise picks the cheapest available model, and refreshes quota details afterward when a checker exists.

## Auto-switch strategies

| Strategy | Behavior |
|---|---|
| `quota-first` | Use the first usable bucket, then query built-in quota checkers and pick the account with the most headroom within that bucket. Falls back to round-robin within the same bucket when quota data is unavailable. |
| `round-robin` | Use the first bucket with an eligible account, then rotate within that bucket. |
| `manual` | Do not pick automatic targets. Manual `/subs switch` still works. |

## Config

Config is global and stored at `~/.pi/agent/multi-pass.json`.

```json
{
  "sets": [
    {
      "id": "codex",
      "baseProvider": "openai-codex",
      "members": [
        { "providerName": "openai-codex", "enabled": true },
        { "providerName": "openai-codex-2", "label": "plus-work", "enabled": true },
        { "providerName": "openai-codex-3", "label": "plus-personal", "enabled": true },
        { "providerName": "openai-codex-4", "label": "pro-work", "enabled": true },
        { "providerName": "openai-codex-5", "label": "pro-personal", "enabled": true }
      ],
      "autoSwitch": {
        "enabled": true,
        "strategy": "quota-first",
        "cooldownMs": 300000,
        "buckets": [
          {
            "id": "plus",
            "members": ["openai-codex-2", "openai-codex-3"]
          },
          {
            "id": "pro",
            "members": ["openai-codex-4", "openai-codex-5"]
          }
        ]
      }
    }
  ]
}
```

Fields:

- `id`: display name for the equivalent set.
- `baseProvider`: provider being cloned, such as `openai-codex`.
- `members[].providerName`: concrete provider name. Native account is the base provider; extra accounts use `baseProvider-N`.
- `members[].enabled`: whether this account may be selected while it is assigned to a bucket.
- `members[].label`: optional display label.
- `autoSwitch.enabled`: whether runtime failover is active for the set.
- `autoSwitch.strategy`: `quota-first`, `round-robin`, or `manual`.
- `autoSwitch.cooldownMs`: fallback suppression time after an account rate-limits and no quota reset time is available.
- `autoSwitch.buckets`: selection buckets in highest-to-lowest priority order.
- `autoSwitch.buckets[].id`: user-managed bucket name.
- `autoSwitch.buckets[].members`: providers assigned to the bucket. A provider may occur in at most one bucket.

A provider outside every bucket is manual-only, regardless of `members[].enabled`. New accounts and configs without `autoSwitch.buckets` start with no automatic providers. Use the dashboard to add, reorder, rename, or remove buckets and to assign providers. Unknown provider references, duplicate assignments, duplicate bucket names, and empty buckets are removed when the config is normalized.

When an account returns a quota error, multi-pass suppresses it until the reported quota reset time. It uses `cooldownMs` only when reset data is unavailable. Eligible providers are enabled, authenticated, non-suppressed, and able to serve the current model. With `quota-first`, known-blocked providers are unavailable, while missing quota data triggers round-robin fallback within the same bucket. The selector advances only when the earlier bucket has no quota-usable or unknown-quota provider. Quota scores are never compared across buckets.

No project config is used.

## Supported providers

| Provider key | Service |
|---|---|
| `anthropic` | Claude Pro/Max |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |

## Built-in limits support

The `/subs` dashboard uses provider-specific quota checkers.

Currently implemented:

- `openai-codex`: fetches ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` or `CHATGPT_BASE_URL`.

Automatic switching happens only after a runtime quota-exhaustion error, not server overload, capacity, or other non-quota errors. On pi versions that support `message_end` retry requests, automatic switching uses true retry instead of replaying the prompt.

## License

MIT
