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
6. Exposes `pi_compact` to compact conversation context
7. Enables Pi's `codemode` tool by default so scripts can orchestrate tools
8. Provides `/wm-settings` to manage Reload, Compact, and Codex system retries
9. Promotes any OpenAI Codex assistant error to Pi's native retry path; repeated image-request failures retain the image-stripping fallback
10. Forces direct Google Gemini API requests to use the Flex inference tier
11. Resumes unfinished turns on empty Enter while idle, without a new user prompt
12. Shows one completion timestamp per model turn, on that turn's final block

This ensures every installed plugin is tracked and manageable through the `/plugins` panel. Direct `google` provider requests using the `google-generative-ai` API are sent with Flex inference when the selected model is on Google's published Flex-supported list; unsupported models, Antigravity, and other providers are not modified.

## Commands

| Command | Description |
|---------|-------------|
| `/plugins` | Plugin management panel — view and toggle plugins across all workspaces |
| `/wm-settings` | Searchable settings for timestamps, Reload, Compact, Codex retries, and Codemode mode |
| `/update` | Update pi to the latest version, with real-time progress output |

### Model-turn timestamps

Enabled by default. **One timestamp per model turn**, not per tool call or user message: Pi's `turn_end` boundary runs after the assistant response and its entire tool batch, before the next model request can start. This also includes intermediate turns while the overall task is still working, as well as a final tool-free reply.

The time is right-aligned on the turn's **last block**, always on its dedicated bottom-most row. For a tool batch, only the final tool in display order is stamped—even when parallel tools finish in a different order. The stamp uses the native frame's bottom padding; custom shells without padding get a dedicated footer inside their shell. `Took`/elapsed/duration output is preserved in place and never merged with the timestamp. Tool-free replies likewise show a bottom row below the assistant text. User messages, hidden controls, and individual tool completions do not get separate stamps.

Today's stamps show local `HH:mm:ss`; other dates show `YYYY-MM-DD HH:mm:ss`. `/wm-settings` → **时间戳 · 模型轮次完成时间** switches between **显示** and **不显示**, applying immediately. Completion times are private session metadata, never model messages. Old per-tool records are grouped into one stamp per turn; records without metadata use Pi's saved message/result times. Labels recalculate on rendering and refresh at local midnight.

This is a plugin-only, reversible in-memory adapter around Pi's exported TUI classes (tested on Pi 1.0.4). It preserves native block bodies and Working, changes no tool execution or model input, and modifies no Pi client files. The adapter is removed when the extension shuts down.

### Empty Enter recovery

Pressing Enter in an empty editor while Pi is idle resumes an interrupted turn (error, cancellation, or incomplete reply) through the ordinary session lifecycle. It works as an installed extension with stock Pi: no core patch or restart is required; `/reload` loads the change. Normal completions do not restart. Typed input, Enter while running, and autocomplete retain their usual behavior. The working indicator remains in Pi's usual editor border.

The extension triggers the turn with an **invisible, empty custom marker** and removes that marker and the failed assistant tail before model serialization. No new prompt or recovery instruction reaches the model. One hidden marker entry remains in the session journal for bookkeeping; it is not displayed and is filtered from every future model request. This is the trade-off for a plugin-only implementation.

### `/wm-settings`

Opens a single searchable settings list, following pi's native settings interaction. Type to filter settings; toggles change directly, while numeric settings open a selectable submenu instead of cycling values with repeated Enter presses.

- **Model-turn timestamps** — show or hide one completion time per assistant/tool round, applying immediately
- **Reload** — enable or disable the Pi restart tool
- **Compact** — enable or disable the context compaction tool, and configure its threshold and retries
- **Codex system retry** — promote any `openai-codex` assistant error to Pi's native retry path and set the extension retry cap
- **Codemode mode** — choose `off`, `on` (direct and scripted tool calls), or `only` (route active tool calls through scripts). Mode changes require `/reload` to update tool visibility.

Pi handles retry scheduling, backoff, cancellation, and its global retry limit. After three matching image-request failures during one agent run with image-bearing history, the next retry omits historical images from the outbound context; the persisted transcript is never rewritten.

Settings are persisted under `pi-workspace-manager` in `~/.pi/agent/settings.json`. Tool activation changes apply immediately; Codemode's `on`/`only` request-loadout behavior takes effect after `/reload`.

Defaults:

```json
{
  "codemode": { "mode": "on" },
  "timestamps": { "enabled": true },
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

After manual compaction, the extension resumes the unfinished task only if the same session is idle and nobody submitted a new message. Text entered during compaction belongs to Pi's own queue and takes priority over automatic continuation. The resumed task is sent as one hidden custom message through Pi's normal session turn, avoiding competing prompts.

### `/update`

Runs `pi update` asynchronously. Progress is shown in real-time so the UI does not freeze. After completion, run `/reload` to apply the new version.

## `/plugins` — Plugin Manager

Unified TUI panel showing all plugins (extensions, skills, themes) from all workspaces. Package references that resolve to the same plugin repository are grouped into one row, including Git branch aliases and local checkouts with matching repository metadata. A plugin may be registered globally or in the current workspace, never both; when opening the manager, a global registration takes precedence and duplicate current-workspace registrations are removed. Other workspaces are independent and are never changed by this cleanup.

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
| Type | Filter plugins, skills, and themes by name or path |
| ↑↓ | Navigate filtered results |
| 1 | Set to Global |
| 2 | Set to Workspace |
| 3 | Set to Remove |
| Enter | Save changes |
| Esc | Cancel |

### State transition rules

| Action | Current workspace | Other workspaces |
|--------|------------------|-----------------|
| Global | Add globally and remove current-workspace duplicates | No change |
| Workspace | Add to current workspace and remove global registration | No change |
| Remove | Remove global/current registrations and keep at most one disabled record | No change |

## Tools

### `workspace_sessions`

LLM-callable tool for searching sessions across all workspaces. Useful when the user wants to find a previous conversation or switch projects.

### `pi_compact`

Compacts conversation context.

### `pi_reload`

Restarts Pi and resumes the current session.

### Codemode

When this extension starts a session, it enables Pi's built-in `codemode` tool by default. No separate `defaultTools` setting is needed; Pi's sandbox and tool-call restrictions still apply.

## Design Notes

- Uses `.ignore` (not `.gitignore`) to block auto-discover — pi reads `.gitignore`, `.ignore`, and `.fdignore`
- `.ignore` files are created automatically on first startup after registration
- Soft-deletes via `_disabledPackages` field (pi ignores this field)
- Duplicate registration is prevented — only resources not already in `packages` are added
- `/update` runs asynchronously via `spawn` — no UI freeze
- Requires manual `/reload` after saving changes or updating

## License

MIT
