# dsh-quick-commands

Reusable prompt shortcuts for the DeepSeek Harness composer.

A lightning button sits in the composer tool row. It opens a panel that lists
your quick commands (pinned first); clicking one **appends** it to the input.
You can add the current draft as a command, edit, delete, pin/unpin, drag to
reorder (within the pinned / plain regions), and import/export a JSON file.
Typing `/` at the start of the input opens an inline filter over the same list
(↑↓ to select, Enter to insert, Esc to dismiss).

## Shared store

Commands are persisted to the **same file** the sibling "Pchat 助手"
(codex-desktop) app uses, so an edit in either app shows up in the other:

```
<appData>/codex-desktop/codex/quick_commands.json
```

The path is resolved through codex-desktop's own `data-location.json` pointer,
so if you relocate that app's data directory, the sharing follows. Set
`DSH_QUICK_COMMANDS_FILE` (absolute path) to override. File shape:

```json
{ "version": 1, "commands": [{ "id": "qc_…", "text": "…", "pinned": true }] }
```

Every mutation re-reads the file, applies the change, and writes atomically
(temp + rename) on a serial queue, so the two apps never clobber each other's
table wholesale.

## Layout

- `src/index.mjs` — Host half: the store + an HTTP route at `/dsh-quick-commands`.
- `src/quick-commands-core.mjs` — pure domain logic (seed / pin / reorder / import).
- `src/shared-path.mjs` — resolves the shared file via the data-location pointer.
- `src/client.tsx` — Browser half: the composer button, panel, and `/` filter.

## License

MIT
