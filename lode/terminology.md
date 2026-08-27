# Terminology

- **base provider**: Pi provider cloned to create equivalent account instances, such as `openai-codex`.
- **equivalent set**: Accounts for one base provider that can serve the same model IDs.
- **member**: One concrete provider instance in an equivalent set.
- **selection bucket**: User-named group of members at one automatic-selection priority. Array order is priority order.
- **eligible member**: Bucketed member that is enabled, authenticated, not failure-suppressed, not the failed current provider, and can serve the current model ID.
- **usable bucket**: Earliest bucket containing a quota-usable member or a member whose quota is unknown and can use strategy fallback.
- **outside all buckets**: Manual-only placement. Do not call an unbucketed member disabled because `members[].enabled` is independent.
- **failure suppression**: Runtime exclusion after quota exhaustion. A reported reset time controls its duration; `cooldownMs` is the fallback.
- **quota-first**: Select most headroom within the first usable bucket. Never compare scores across buckets.
