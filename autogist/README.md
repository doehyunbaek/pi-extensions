# pi-autogist

Pi extension that automatically backs up each persisted session JSONL file to its own secret GitHub gist using the `gh` CLI.

## Requirements

Install and authenticate GitHub CLI:

```sh
gh auth login
gh auth status
```

The authenticated account needs gist access. Session files can contain prompts, model output, tool arguments/results, local paths, and extension data, so backups are **secret gists** by default. Secret gists are unlisted, not encrypted or access-controlled like private repositories.

## Usage

Load it for one invocation:

```sh
pi -e ~/pi-extensions/autogist
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/pi-extensions/autogist"]
}
```

Then run `/reload` in an existing Pi process.

Autogist syncs after every settled agent run and when a session shuts down, including quit, reload, `/new`, `/resume`, and fork flows. It skips uploads when the session file has not changed.

Commands:

```text
/autogist          Show backup status for the current session
/autogist status   Show backup status for the current session
/autogist sync     Force a backup now
/autogist-analyze  Browse sessions and batch-sync selected files
/autogist-device   Show the configured device name
/autogist-device germany  Prefix gist files with "germany__"
/autogist-device clear    Remove the device-name prefix
```

In `/autogist-analyze`, use Up/Down to navigate, Space to select, `a` to select all visible sessions, Tab to switch between Current Folder and All, and Enter to sync the selection. Batch sync skips unchanged files and conservatively spaces GitHub writes two seconds apart. If GitHub reports a secondary content-creation limit, Autogist stops the batch immediately, persists a one-hour cooldown in `~/.pi/agent/autogist/cooldown.json`, and leaves the remaining sessions pending for a later run.

Gist filenames use `<device>__<timestamp>__<session-id>.jsonl`, for example `germany__2026-09-01T12-19-47-867Z__01a05ce9.jsonl`. The device name is stored in `~/.pi/agent/autogist/config.json`. After changing it, `/autogist sync` renames the current gist file; other session files are renamed on their next sync.

Local session-to-gist mappings are stored under `~/.pi/agent/autogist/` with mode `0600`. If a mapped gist was deleted remotely, Autogist removes the stale mapping and creates a replacement on the following sync.

## Limitations

- In-memory sessions have no JSONL file and are not backed up.
- Backups require network access and a working authenticated `gh` command.
- Gist limits apply; very large session files may fail to upload.

## License

MIT © 2026 Doehyun Baek
