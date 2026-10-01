# MultiCodex

Forked from [kim0/pi-multicodex](https://github.com/kim0/pi-multicodex).

## Commands

- `/multicodex-login` — add a ChatGPT Codex account.
- `/multicodex-usage` — force-refresh every account's limits and reset times; select an account, then choose to use it or redeem an available usage-limit reset.
- `/multicodex-analyze` — show the local per-account request heatmap.
- `/multicodex-sync` — explicitly pull/merge/push accounts using the optional Gist configuration.
- `/multicodex-sync status` — show pending/retry/conflict state and last successful upload.

## Optional Gist sync

On Linux or macOS, install `git` and the GitHub CLI (`gh`), authenticate once with `gh auth login --scopes gist`, then run `/multicodex-sync` on every device using the **same GitHub account**. Each sync discovers the shared **secret Gist** by the authenticated account's numeric GitHub ID. If none exists, it creates one tagged `MultiCodex account sync (github:USER_ID)`. GitHub Git authentication is configured automatically and the selected Gist ID is saved in `~/.pi/agent/multicodex.json` before uploading accounts. No manual Gist creation or copying IDs between devices is needed.

The saved field is a cache of the discovered shared Gist, not a manual override:

```json
"gistSync": { "gistId": "YOUR_GIST_ID" }
```

After setup, an expired or soon-to-expire local access token first triggers a read-only remote credential pull under the local token-refresh lock. The account is reloaded, and OAuth refresh is skipped if the pulled token is still fresh. If the remote access token is also expiring, OAuth refresh uses the merged refresh token. Credential conflicts or pull failures stop OAuth rotation rather than risking a stale refresh token; retry or run `/multicodex-sync`. Fresh local tokens do not trigger a pull. Pulls use the saved Gist ID and never push local credentials.

Pending work is detected durably by comparing shared credentials with the last acknowledged snapshot, ignoring account ordering and `lastUsed`. After setup, startup recovers pending uploads, and login or OAuth refresh schedules a background reconciliation. Saves during an upload remain pending for a follow-up pass. This does not delay token responses or hold the token-refresh lock during Git operations.

Failures preserve local credentials and retry with exponential backoff and jitter (roughly 2 seconds initially, capped around 5 minutes). Retry metadata, sanitized error categories, and last success are stored locally in `gistSyncStatus` and survive restart. Credential conflicts pause automatic retries until deliberate reconciliation and `/multicodex-sync`. The footer shows disabled/synced/pending/syncing/retrying/conflict; `/multicodex-sync status` provides details. Synced means matching the last acknowledged snapshot, not a continuous guarantee about other devices. Local state is checked every 30 seconds to notice saves by other Pi processes; this is not remote polling. Shutdown stops timers; pending work resumes next startup.

Automatic sync requires a saved `gistSync.gistId`; it never enables syncing implicitly for accounts that have not opted in. Automatic reconciliation uses that saved ID; manual sync performs discovery using `gh`. No GitHub token is stored in MultiCodex configuration. The remote `multicodex.json` contains only account identities and credentials; `lastUsed`, active/manual selection, configuration, usage logs, and sync bookkeeping remain local. Existing remote `lastUsed` values are removed on the next successful upload (old Git revisions remain). To disable automatic sync, remove `gistSync` and stop running the command. An already-started network operation cannot be undone. Removing `gistSync` does not create a separate copy: the next manual sync rediscovers the shared Gist and re-enables background reconciliation.

Legacy Gists described as `MultiCodex account sync` are recognized for the same GitHub owner. If duplicates exist, all devices select the oldest by creation time (then ID), even if a different ID was previously saved. Nothing is deleted or silently copied from discarded duplicates. Different credentials on the chosen Gist still produce a conflict requiring deliberate reconciliation.

**Security:** OAuth access and refresh tokens are uploaded in plaintext. Secret Gists are unlisted, not encrypted or private; anyone with the URL can read them. Git history retains old credentials even after deletion. Only enable this if that risk is acceptable.

### Concurrency and recovery

- Discovery/creation is protected by the local sync lock, and the selected ID is persisted before accounts are uploaded. If saving the ID fails, the error includes the selected Gist ID. GitHub has no atomic create-if-absent operation for Gists: simultaneous first-time creators may produce duplicates, but re-listing after creation and discovery on every manual sync makes devices converge deterministically. A timeout or crash may leave an empty Gist; future syncs discover it. Remote deletion or switching GitHub accounts changes the selected Gist.
- Isolated checkouts and non-forced Git pushes reject concurrent remote updates. Retry the command after rejection.
- Three-way merging preserves independent account additions and local changes made while syncing. Divergent credentials for the same account fail explicitly, rather than selecting potentially invalid rotating refresh tokens by expiry. First sync with differing credentials also conflicts; reconcile or re-login deliberately.
- Local storage is merged under a short exclusive lock and replaced atomically with owner-only permissions. A second local sync fails busy; simultaneous calls in one manager share the same operation. Failed syncs never advance their local baseline.
- Storage, sync, and OAuth refresh use native descriptor-held `flock(2)` locks on Linux and macOS through Koffi; no `flock` command-line utility is required. The OS releases ownership on process exit, including crashes and `SIGKILL`; a paused process retains ownership. The persistent files are `multicodex.json.flock`, `multicodex.json.gist-sync.flock`, and `multicodex-refresh-locks/token-refresh.flock`. **Never delete these files**, even when they appear old: file existence is not lock ownership, and unlinking can break mutual exclusion. Native locking errors and unsupported platforms fail closed rather than running unlocked.
- **Migration:** quit every Pi process before starting this version. Do not use `/reload` to mix old directory-lock code and new advisory-lock code across processes. Legacy `.lock` directories are ignored by this version; after all old processes have exited, they may be removed once. New `.flock` files require no crash cleanup.
- Sync does **not** provide a cross-machine OAuth refresh lock. Avoid simultaneously refreshing the same account on multiple machines: Git can detect credential conflicts but cannot undo a token rotation already performed by the OAuth server. A remote push may succeed before local application fails; retry/reconcile without force-pushing.

`/multicodex-usage` uses the same ChatGPT backend endpoints as the OpenAI Codex CLI: `GET /wham/usage`, `GET /wham/rate-limit-reset-credits`, and, after confirmation, `POST /wham/rate-limit-reset-credits/consume` with an idempotency key.
