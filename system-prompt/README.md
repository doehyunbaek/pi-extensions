# pi-system-prompt

Pi extension that persists the effective system prompt for every agent run and adds `/system-prompt` for inspecting snapshots.

## Usage

Load it for one invocation:

```bash
pi -e ~/pi-extensions/system-prompt
```

Commands:

```text
/system-prompt          Show the latest snapshot, or the current prompt if none exists
/system-prompt saved    Same as above
/system-prompt latest   Same as above
/system-prompt current  Show the prompt reconstructed by the current runtime
```

Each `agent_start` appends a `pi-system-prompt-snapshot` custom entry to the session JSONL. A snapshot contains:

- The full effective system-prompt string
- Capture timestamp
- SHA-256 hash
- Provider and model
- Thinking level

Snapshots do not participate in LLM context.

When displayed, dynamically constructed sections use the active theme's accent color on a highlighted background. This includes appended system-prompt text, generated tool entries and guidelines, and project context. Newly captured snapshots persist the metadata needed for highlighting; older snapshots use current metadata when available.

To load the extension automatically, add the directory to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["~/pi-extensions/system-prompt"]
}
```

If pi is already running, use `/reload` after updating settings.

## Limitations

The extension cannot recover prompts for runs completed before it was installed. Such sessions begin recording snapshots with their next agent run.

`ctx.getSystemPrompt()` captures Pi's effective system-prompt string. Provider payload rewrites made later by `before_provider_request` are not included.

## License

MIT © 2026 Doehyun Baek
