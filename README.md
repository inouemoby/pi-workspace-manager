# pi-workspace-manager

Unified plugin management and update for [pi coding agent](https://github.com/earendil-works/pi-mono).

## Install

```bash
pi install git:github.com/inouemoby/pi-workspace-manager
```

## What It Does

On first session start, automatically:

1. Scans global `~/.pi/agent/extensions/`, `skills/`, `themes/` directories
2. Registers all found resources into `~/.pi/agent/settings.json` `packages`
3. Creates `.ignore` files to prevent double-loading via auto-discover
4. Scans all workspace `.pi/` directories and registers local resources
5. Removes invalid plugin registrations (files that no longer exist)
6. Exposes a guarded `pi_compact` tool so the model can compact history and resume an unfinished task when context usage exceeds a configurable threshold (95% by default)
7. Provides `/wm-settings` to manage Reload, Compact, and Codex system retries
8. Promotes any OpenAI Codex assistant error to Pi's native retry path; repeated image-request failures retain the image-stripping fallback
9. Forces direct Google Gemini API requests to use the Flex inference tier

This ensures every installed plugin is tracked and manageable through the `/plugins` panel. Direct `google` provider requests using the `google-generative-ai` API are sent with Flex inference when the selected model is on Google's published Flex-supported list; unsupported models, Antigravity, and other providers are not modified.

## Commands

| Command | Description |
|---------|-------------|
| `/plugins` | Plugin management panel — view and toggle plugins across all workspaces |
| `/wm-settings` | Searchable settings list for Reload, Compact, and Codex system retries |
| `/update` | Update pi to the latest version, with real-time progress output |

### `/wm-settings`

Opens a single searchable settings list, following pi's native settings interaction. Type to filter settings; toggles change directly, while numeric settings open a selectable submenu instead of cycling values with repeated Enter presses.

- **Reload** — enable or disable `pi_reload`; recovery runs only after the matching original session is restored and uses a hidden extension message instead of a normal user message
- **Compact** — enable/disable `pi_compact`, set its context threshold, and manage transient-failure retries
- **Codex system retry** — promote any `openai-codex` assistant error to Pi's native retry path and set the extension retry cap

Pi handles retry scheduling, backoff, cancellation, and its global retry limit. After three matching image-request failures during one agent run with image-bearing history, the next retry omits historical images from the outbound context; the persisted transcript is never rewritten.

Changes are persisted under `pi-workspace-manager` in `~/.pi/agent/settings.json` and applied to the active tool list immediately. This setting controls the model-callable `pi_reload`; pi's built-in user `/reload` command remains available.

Defaults:

```json
{
  "reload": { "enabled": true },
  "compact": {
    "enabled": true,
    "thresholdPercent": 95,
    "retryOnFailure": true,
    "maxRetries": 2,
    "retryDelayMs": 2000
  },
  "codexRetry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

`compact.maxRetries` counts additional attempts after the initial compaction. `codexRetry.maxRetries` gates how many Codex assistant errors this extension promotes; Pi's global `retry.maxRetries` remains an additional upper bound. Cancellation and exhausted retry budgets still stop retries.

### `/update`

Runs `pi update` asynchronously. Progress is shown in real-time so the UI does not freeze. After completion, run `/reload` to apply the new version.

## `/plugins` — Plugin Manager

Unified TUI panel showing all plugins (extensions, skills, themes) from all workspaces.

Each plugin has three mutually exclusive states:

| State | Meaning |
|-------|---------|
| 🌐 Global | Registered in global settings, available in all workspaces |
| 📁 Workspace | Registered in current workspace settings only |
| ✗ Remove | Not loaded (soft-deleted via `_disabledPackages`) |
| `[MISS]` | Source files not found on disk |

### Controls

| Key | Action |
|-----|--------|
| ↑↓ | Navigate |
| 1 | Set to Global |
| 2 | Set to Workspace |
| 3 | Set to Remove |
| Enter | Save changes |
| Esc | Cancel |

### State transition rules

| Action | Current workspace | Other workspaces |
|--------|------------------|-----------------|
| Global | Add to global packages | Remove from all workspace packages |
| Workspace | Add to current workspace, remove from global | No change |
| Remove | Remove from its current scope (global or workspace) | No change |

## Tools

### `workspace_sessions`

LLM-callable tool for searching sessions across all workspaces. Useful when the user wants to find a previous conversation or switch projects.

### `pi_compact`

Allows the model to trigger pi's native context compaction when all of these conditions hold:

- The current task is unfinished
- Context usage is strictly above the configured threshold (95% by default)
- The model supplies a concise description of the remaining work and immediate next step

The tool checks its enabled state and context percentage itself and refuses premature calls, calls with unavailable usage, or calls while another compaction is running. Configured transient failures are retried before the tool gives up. After successful compaction it automatically sends a user message instructing pi to continue the unfinished task from the compacted context.

`pi_compact` runs sequentially, starts `ctx.compact()` immediately, and terminates its current tool turn. It does not wait for Pi's automatic threshold compaction. Pi aborts the interrupted agent operation as manual compaction begins; the tool queues the task continuation only from the compaction completion callback, after the compressed session is ready.

## Design Notes

- Uses `.ignore` (not `.gitignore`) to block auto-discover — pi reads `.gitignore`, `.ignore`, and `.fdignore`
- `.ignore` files are created automatically on first startup after registration
- Soft-deletes via `_disabledPackages` field (pi ignores this field)
- Duplicate registration is prevented — only resources not already in `packages` are added
- `/update` runs asynchronously via `spawn` — no UI freeze
- Requires manual `/reload` after saving changes or updating

## License

MIT
