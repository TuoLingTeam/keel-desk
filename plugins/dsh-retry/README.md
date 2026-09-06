# dsh-retry

A single **General-settings** row that sets the global model-request retry count
for the DeepSeek Harness.

When a model request fails (e.g. a connection error), the harness retries it. The
built-in default is only a couple of attempts; this plugin lets you raise that to
**99999 (≈ retry forever)** by default, and change the number in Settings → General.

## How it works

- **Host** (`src/index.mjs`): stores the value at `<DSH_HOME>/dsh-retry.json`
  (`{ "maxRetries": 99999 }`) and serves it at `/dsh-retry` (GET / POST).
- **Client** (`src/client.tsx`): a number field in the General settings section,
  autosaving on blur / Enter (blank or non-integer values are rejected).
- The core `llm-retry` executor reads the **same file** live and applies the value
  to every provider's normal-mode retry policy, so one field controls retries
  app-wide. `0` disables retries.

## License

MIT
