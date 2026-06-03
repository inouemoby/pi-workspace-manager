# pi-workspace-manager

Cross-workspace session browsing and unified plugin management for [pi coding agent](https://github.com/earendil-works/pi-mono).

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
| `/browse [query]` | Browse all sessions across workspaces, launch in new terminal |
| `/ws` | Quick workspace launcher — pick workspace, open in new terminal |
| `/plugins` | Plugin management panel — view and toggle plugins across all workspaces |

## `/plugins` — Plugin Manager

Unified TUI panel showing all plugins (extensions, skills, themes) from all workspaces.

Each plugin has three mutually exclusive states:

| State | Meaning |
|-------|---------|
| 🌐 Global | Registered in global settings, available in all workspaces |
| 📁 Workspace | Registered in current workspace settings only |
| ✗ Remove | Not loaded (soft-deleted via `_disabledPackages`) |

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

Plugins with missing source files show a ⚠ prefix.

## Tool: `workspace_sessions`

LLM-callable tool for searching sessions across all workspaces. Useful when the user wants to find a previous conversation or switch projects.

## Terminal

Launches new pi instances with a fallback chain:

1. **Alacritty** — if installed at `C:\Program Files\Alacritty\alacritty.exe`
2. **Windows Terminal** (`wt.exe`)
3. **cmd.exe** — always available fallback

## Design Notes

- Uses `.ignore` (not `.gitignore`) to block auto-discover — pi reads `.gitignore`, `.ignore`, and `.fdignore`
- `.ignore` files are created automatically on first startup after registration
- Soft-deletes via `_disabledPackages` field (pi ignores this field)
- Duplicate registration is prevented — only resources not already in `packages` are added
- Requires manual `/reload` after saving changes

## License

MIT
