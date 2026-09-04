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
7. Provides `/wm-settings` to manage Reload, Compact, and independent forced auto-compact recovery
8. Forces direct Google Gemini API requests to use the Flex inference tier

This ensures every installed plugin is tracked and manageable through the `/plugins` panel. Direct `google` provider requests using the `google-generative-ai` API are sent with Flex inference when the selected model is on Google's published Flex-supported list; unsupported models, Antigravity, and other providers are not modified.

## Commands

| Command | Description |
|---------|-------------|
| `/plugins` | Plugin management panel — view and toggle plugins across all workspaces |
| `/wm-settings` | Two-level settings UI for Reload, Compact, and forced auto-compact recovery |
| `/update` | Update pi to the latest version, with real-time progress output |

### `/wm-settings`

Opens a first-level category menu with separate second-level panels:

- **Reload Tool Settings** — enable or disable the model-callable `pi_reload` tool
- **Compact Tool Settings** — enable/disable `pi_compact`, set its context threshold, and manage transient-failure retries
- **Forced Auto-Compact Recovery** — independently enable/disable continuation after forced native automatic compaction and configure its pre-compaction usage threshold (default 100%)

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
    "retryDelayMs": 2000,
    "resumeAfterForcedAutoCompact": true,
    "forcedAutoCompactResumeThresholdPercent": 100
  }
}
```

`maxRetries` counts additional attempts after the initial compaction. Cancellation and permanent conditions such as “already compacted” or “nothing to compact” are not retried.

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

`pi_compact` runs sequentially and terminates its current tool turn. It then waits for pi's native post-turn automatic compaction. If automatic compaction occurs, the tool accepts it and continues the task without starting a duplicate manual compaction. Manual `ctx.compact()` is used only as a fallback after `agent_settled` when no automatic compaction occurred. This avoids the automatic/manual race that otherwise produces `Already compacted`.

### Forced automatic compaction recovery

This recovery path does not depend on the model calling `pi_compact`. When measured pre-compaction usage reaches the independently configured recovery threshold (default 100%), the extension captures the latest user task before native automatic compaction. An overflow whose usage percentage cannot be calculated is also treated as a safety fallback. After compaction and any built-in compact-and-retry flow have fully settled, it sends a conditional user continuation message:

- Continue from the interruption point if the previous task is unfinished
- Do not repeat work if the task was already completed

The behavior is controlled by `resumeAfterForcedAutoCompact`; its threshold is set by `forcedAutoCompactResumeThresholdPercent` (50–150%). Both are independently configurable under `/wm-settings` → **Forced Auto-Compact Recovery**, and remain effective even when the model-callable `pi_compact` tool itself is disabled.

## Design Notes

- Uses `.ignore` (not `.gitignore`) to block auto-discover — pi reads `.gitignore`, `.ignore`, and `.fdignore`
- `.ignore` files are created automatically on first startup after registration
- Soft-deletes via `_disabledPackages` field (pi ignores this field)
- Duplicate registration is prevented — only resources not already in `packages` are added
- `/update` runs asynchronously via `spawn` — no UI freeze
- Requires manual `/reload` after saving changes or updating

## License

MIT
