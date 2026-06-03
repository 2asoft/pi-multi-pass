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

Each account can be enabled or disabled for automatic switching. Disabled accounts remain available for manual switching.

## Quick start

```text
/subs           Open the subscription dashboard, including refreshed quota
/subs add       Add an equivalent account for a provider
/login          Authenticate the new account
/subs switch    Manually switch account
```

When the active account returns a rate-limit-style runtime error, multi-pass can switch to another enabled equivalent account and retry the same prompt with the same model ID.

## Commands

```text
/subs              Open the subscription dashboard
/subs add          Add an equivalent account
/subs switch       Quick manual switch
/subs login        Shortcut to login instructions
/subs logout       Shortcut to log out an account
/subs remove       Shortcut to remove an account
```

The dashboard always refreshes quota and combines status, limits, and auto-switch settings. Select a set to change its auto-switch policy or strategy. Select an account to switch, toggle auto/manual, view quota details, login/logout, or remove it.

## Auto-switch strategies

| Strategy | Behavior |
|---|---|
| `quota-first` | Query built-in quota checkers and pick the account with the most headroom. Falls back to round-robin when quota data is unavailable. |
| `round-robin` | Rotate through enabled authenticated accounts. |
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
        { "providerName": "openai-codex-2", "label": "work", "enabled": true },
        { "providerName": "openai-codex-3", "label": "personal", "enabled": false }
      ],
      "autoSwitch": {
        "enabled": true,
        "strategy": "quota-first",
        "cooldownMs": 300000
      }
    }
  ]
}
```

Fields:

- `id`: display name for the equivalent set.
- `baseProvider`: provider being cloned, such as `openai-codex`.
- `members[].providerName`: concrete provider name. Native account is the base provider; extra accounts use `baseProvider-N`.
- `members[].enabled`: whether this account may be selected automatically.
- `members[].label`: optional display label.
- `autoSwitch.enabled`: whether runtime failover is active for the set.
- `autoSwitch.strategy`: `quota-first`, `round-robin`, or `manual`.
- `autoSwitch.cooldownMs`: how long to avoid an account after it rate-limits.

No project config is used.

## Supported providers

| Provider key | Service |
|---|---|
| `anthropic` | Claude Pro/Max |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |

## Built-in limits support

The `/subs` dashboard uses provider-specific quota checkers.

Currently implemented:

- `openai-codex`: fetches ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` or `CHATGPT_BASE_URL`.
- `google-gemini-cli`: queries Google Cloud Code Assist quota.
- `google-antigravity`: queries Antigravity available-model quota.

Automatic switching still happens only after a runtime rate-limit-style error.

## License

MIT
