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
/subs add       Add an equivalent account for a provider
/login          Authenticate the new account
/subs auto      Choose which accounts may be used automatically
/subs limits    Inspect account headroom
/subs switch    Manually switch account
```

When the active account returns a rate-limit-style runtime error, multi-pass can switch to another enabled equivalent account and retry the same prompt with the same model ID.

## Commands

```text
/subs              Open menu
/subs add          Add an equivalent account
/subs login        Show login instructions for an account
/subs logout       Log out an account
/subs list         List equivalent subscription sets
/subs status       Show detailed auth and auto-switch status
/subs limits       Check built-in quota/usage support
/subs switch       Manually switch to another equivalent account
/subs auto         Configure automatic switching
/subs remove       Remove an equivalent account
```

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

`/subs limits` uses provider-specific quota checkers.

Currently implemented:

- `openai-codex`: fetches ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` or `CHATGPT_BASE_URL`.
- `google-gemini-cli`: queries Google Cloud Code Assist quota.
- `google-antigravity`: queries Antigravity available-model quota.

`/subs limits` is an on-demand snapshot. Automatic switching still happens only after a runtime rate-limit-style error.

## License

MIT
