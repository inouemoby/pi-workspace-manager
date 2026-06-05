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

This ensures every installed plugin is tracked and manageable through the `/plugins` panel.

## Commands

| Command | Description |
|---------|-------------|
| `/plugins` | Plugin management panel — view and toggle plugins across all workspaces |
| `/update` | Update pi to the latest version, with real-time progress output |

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

## Tool: `workspace_sessions`

LLM-callable tool for searching sessions across all workspaces. Useful when the user wants to find a previous conversation or switch projects.

## Design Notes

- Uses `.ignore` (not `.gitignore`) to block auto-discover — pi reads `.gitignore`, `.ignore`, and `.fdignore`
- `.ignore` files are created automatically on first startup after registration
- Soft-deletes via `_disabledPackages` field (pi ignores this field)
- Duplicate registration is prevented — only resources not already in `packages` are added
- `/update` runs asynchronously via `spawn` — no UI freeze
- Requires manual `/reload` after saving changes or updating

## License

MIT
