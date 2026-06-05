/**
 * pi-workspace-manager
 *
 * 1. Cross-workspace session browsing & launching via Alacritty
 * 2. Unified plugin management panel with custom TUI (/plugins)
 * 3. Startup validation — auto-remove invalid local-dev plugins
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, type SelectItem, SelectList, Text, matchesKey } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join, resolve } from "node:path";
import {
  existsSync, readFileSync, writeFileSync,
  readdirSync, statSync, mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";

const HOME = homedir();
const PI_AGENT = join(HOME, ".pi", "agent");
const SESSIONS_DIR = join(PI_AGENT, "sessions");
const PI_CMD = join(HOME, "AppData", "Roaming", "npm", "pi.cmd");
const ALACRITTY = "C:\\Program Files\\Alacritty\\alacritty.exe";
const WT = "wt.exe";
const CMD = "cmd.exe";

// ─── Helpers ────────────────────────────────────────────────

function readJson(p: string): any {
  try { return JSON.parse(readFileSync(p, "utf-8")); }
  catch { return {}; }
}

function writeJson(p: string, data: any) {
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function sessionDirToCwd(dir: string): string {
  try {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".meta.json")) {
        const meta = readJson(join(dir, f));
        if (meta.cwd) return meta.cwd;
      }
    }
  } catch { /* */ }
  return basename(dir);
}

function listSessionDirs(): string[] {
  try {
    return readdirSync(SESSIONS_DIR)
      .filter(f => statSync(join(SESSIONS_DIR, f)).isDirectory() && !f.startsWith("."))
      .map(f => join(SESSIONS_DIR, f));
  } catch { return []; }
}

interface SessionInfo {
  file: string; metaFile: string; name: string;
  modified: Date; size: number; cwd: string; preview: string;
}

function listSessionsInDir(dir: string): SessionInfo[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => {
        const full = join(dir, f);
        const stat = statSync(full);
        return {
          file: full, metaFile: join(dir, f.replace(".jsonl", ".meta.json")),
          name: f.replace(/\.jsonl$/, ""), modified: stat.mtime,
          size: stat.size, cwd: "", preview: "",
        };
      })
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  } catch { return []; }
}

function getFirstMessage(file: string): string {
  try {
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === "message" && e.message?.role === "user") {
          const c = e.message.content;
          if (typeof c === "string") return c.slice(0, 120);
          if (Array.isArray(c)) {
            for (const p of c) {
              if (typeof p === "string") return p.slice(0, 120);
              if (p?.type === "text") return (p.text || "").slice(0, 120);
            }
          }
        }
      } catch { /* */ }
    }
  } catch { /* */ }
  return "";
}

function workspaceName(cwd: string): string { return basename(cwd) || cwd; }
function getSessionName(metaFile: string): string | null {
  try { return readJson(metaFile).name || null; } catch { return null; }
}

function launchTerminal(cwd: string, sessionFile?: string): boolean {
  const piCmd = sessionFile
    ? `"${PI_CMD}" --session "${sessionFile}"`
    : `"${PI_CMD}"`;

  const tryExec = (cmd: string): boolean => {
    try {
      execSync(cmd, { stdio: "ignore", windowsHide: true, shell: true });
      return true;
    } catch { return false; }
  };

  // 1. Alacritty (if installed)
  if (existsSync(ALACRITTY)) {
    if (tryExec(`start "" "${ALACRITTY}" --working-directory "${cwd}" -e ${piCmd}`)) return true;
  }

  // 2. Windows Terminal
  if (tryExec(`start "" "${WT}" -d "${cwd}" -- ${piCmd}`)) return true;

  // 3. cmd.exe (always available)
  if (tryExec(`start "" "${CMD}" /k "cd /d "${cwd}" && ${piCmd}"`)) return true;

  return false;
}

// ─── Resource Scanning ──────────────────────────────────────

function listInstalledExtensions(): string[] {
  const extDir = join(PI_AGENT, "extensions");
  try {
    return readdirSync(extDir).filter(f => {
      if (f.startsWith(".") || f === ".gitignore") return false;
      const full = join(extDir, f);
      if (f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js")) return true;
      if (statSync(full).isDirectory())
        return existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"));
      return false;
    });
  } catch { return []; }
}

function listInstalledGitPackages(): string[] {
  const gitDir = join(PI_AGENT, "git");
  const results: string[] = [];
  try {
    const walk = (dir: string, prefix: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (existsSync(join(full, "index.ts")) || existsSync(join(full, "package.json")))
            results.push(`git:${prefix}${entry.name}`);
          else walk(full, `${prefix}${entry.name}/`);
        }
      }
    };
    walk(gitDir, "");
  } catch { /* */ }
  return results;
}

function listInstalledSkills(): string[] {
  const dir = join(PI_AGENT, "skills");
  try {
    return readdirSync(dir).filter(f => {
      if (f.startsWith(".") || f === ".gitignore") return false;
      return statSync(join(dir, f)).isDirectory();
    });
  } catch { return []; }
}

function listInstalledThemes(): string[] {
  const dir = join(PI_AGENT, "themes");
  try {
    return readdirSync(dir).filter(f => {
      if (f.startsWith(".") || f === ".gitignore") return false;
      const full = join(dir, f);
      return f.endsWith(".js") || f.endsWith(".ts") || statSync(full).isDirectory();
    });
  } catch { return []; }
}

// ─── Plugin Management Types ────────────────────────────────

type ResourceState = "global" | "workspace" | "removed";

interface ManagedResource {
  id: string;       // e.g. "extensions/ollama-usage" or "git:github.com/..."
  name: string;     // display name
  installed: boolean;
  state: ResourceState;
}

function buildResourceIndex(cwd: string): ManagedResource[] {
  const normalize = (p: string) => p.replace(/\\/g, "/");

  const globalSettings = readJson(join(PI_AGENT, "settings.json"));
  const globalPkgs: string[] = globalSettings.packages || [];
  const globalDisabled: string[] = globalSettings._disabledPackages || [];

  const projSettings = readJson(join(cwd, ".pi", "settings.json"));
  const projPkgs: string[] = projSettings.packages || [];
  const projDisabled: string[] = projSettings._disabledPackages || [];

  // Resolve all registered refs (packages + extensions/skills/themes/prompts overrides)
  const overrideFields = ["extensions", "skills", "themes", "prompts"];
  const resolveRel = (rawId: string, base: string) => {
    if (rawId.startsWith("git:") || rawId.startsWith("npm:") || rawId.startsWith("github:")) return rawId;
    if (rawId.includes(":") || rawId.startsWith("/")) return rawId;
    return resolve(base, rawId).replace(/\\/g, "/");
  };
  const collectActiveRefs = (settings: any, base: string): string[] => {
    const refs: string[] = [...(settings.packages || [])];
    for (const field of overrideFields) {
      for (const entry of settings[field] || []) {
        refs.push(resolveRel(entry, base));
      }
    }
    return refs;
  };
  const collectAllRefs = (settings: any, base: string): string[] => {
    return [...collectActiveRefs(settings, base), ...(settings._disabledPackages || [])];
  };
  const globalActiveRefs = collectActiveRefs(globalSettings, PI_AGENT);
  const projActiveRefs = collectActiveRefs(projSettings, cwd);
  const globalAllRefs = collectAllRefs(globalSettings, PI_AGENT);
  const projAllRefs = collectAllRefs(projSettings, cwd);
  const allWorkspaceRefs = new Set<string>();
  for (const dir of listSessionDirs()) {
    const wsCwd = sessionDirToCwd(dir);
    const wsSettings = readJson(join(wsCwd, ".pi", "settings.json"));
    for (const ref of collectAllRefs(wsSettings, wsCwd)) allWorkspaceRefs.add(ref);
  }

  const getState = (id: string): ResourceState => {
    const nid = normalize(id);
    if (globalActiveRefs.some(p => normalize(p) === nid)) return "global";
    if (projActiveRefs.some(p => normalize(p) === nid)) return "workspace";
    return "removed";
  };

  const resources: ManagedResource[] = [];
  const seen = new Set<string>();

  const add = (id: string, name: string) => {
    const nid = normalize(id);
    if (seen.has(nid)) return;
    seen.add(nid);
    resources.push({ id: nid, name, installed: true, state: getState(id) });
  };

  // Physical scan — global
  for (const ext of listInstalledExtensions()) add(`extensions/${ext}`, ext);
  for (const git of listInstalledGitPackages()) add(git, git.split("/").pop() || git);
  for (const skill of listInstalledSkills()) add(`skills/${skill}`, skill);
  for (const theme of listInstalledThemes()) add(`themes/${theme}`, theme);

  // Physical scan — workspace-local .pi/ resources
  const WS_RES_TYPES = ["extensions", "skills", "themes", "prompts"];
  for (const resType of WS_RES_TYPES) {
    const wsResDir = join(cwd, ".pi", resType);
    if (!existsSync(wsResDir)) continue;
    try {
      for (const f of readdirSync(wsResDir)) {
        if (f.startsWith(".") || f === ".ignore") continue;
        const full = join(wsResDir, f);
        const absPath = full.replace(/\\/g, "/");
        if (seen.has(absPath)) continue;
        let valid = false;
        if (resType === "extensions") {
          valid = f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js") ||
            (statSync(full).isDirectory() && (existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"))));
        } else if (resType === "skills") {
          valid = statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
        } else {
          valid = f.endsWith(".js") || f.endsWith(".ts") || f.endsWith(".md") || statSync(full).isDirectory();
        }
        if (valid) {
          seen.add(absPath);
          resources.push({ id: absPath, name: f, installed: true, state: getState(absPath) });
        }
      }
    } catch { /* */ }
  }

  // Add remaining from all settings that weren't physically found
  const allRegisteredIds = new Set([...globalAllRefs, ...projAllRefs, ...allWorkspaceRefs]);
  for (const rawId of allRegisteredIds) {
    const id = normalize(rawId);
    if (!seen.has(id)) {
      seen.add(id);
      resources.push({ id, name: id.split("/").pop() || id, installed: existsSync(id) || rawId.startsWith("git:") || rawId.startsWith("npm:"), state: getState(id) });
    }
  }

  resources.sort((a, b) => a.name.localeCompare(b.name));
  return resources;
}

function applyChanges(cwd: string, resources: ManagedResource[], changes: Map<string, ResourceState>) {
  if (changes.size === 0) return;

  const normalize = (p: string) => p.replace(/\\/g, "/");
  const matchPkg = (pkg: string, id: string) => normalize(pkg) === normalize(id);

  // Read current settings — global
  const globalPath = join(PI_AGENT, "settings.json");
  const globalSettings = readJson(globalPath);
  let globalPkgs: string[] = [...(globalSettings.packages || [])];
  let globalDisabled: string[] = [...(globalSettings._disabledPackages || [])];

  // Read current settings — current workspace
  const projPath = join(cwd, ".pi", "settings.json");
  const projSettings = readJson(projPath);
  let projPkgs: string[] = [...(projSettings.packages || [])];
  let projDisabled: string[] = [...(projSettings._disabledPackages || [])];

  // Collect all other workspace settings that might be affected
  const otherWorkspaceSettings: Array<{ cwd: string; path: string; settings: any; pkgs: string[]; disabled: string[] }> = [];
  for (const dir of listSessionDirs()) {
    const wsCwd = sessionDirToCwd(dir);
    if (normalize(wsCwd) === normalize(cwd)) continue; // skip current workspace
    const wsPath = join(wsCwd, ".pi", "settings.json");
    const wsSettings = readJson(wsPath);
    if (!wsSettings.packages && !wsSettings._disabledPackages) continue;
    otherWorkspaceSettings.push({
      cwd: wsCwd, path: wsPath, settings: wsSettings,
      pkgs: [...(wsSettings.packages || [])],
      disabled: [...(wsSettings._disabledPackages || [])],
    });
  }

  // Find which workspace originally owns a package (for "global" state)
  const findOwner = (id: string): string | null => {
    for (const ws of otherWorkspaceSettings) {
      if (ws.pkgs.some(p => matchPkg(p, id))) return ws.cwd;
    }
    return null;
  };

  for (const [id, newState] of changes) {
    const resource = resources.find(r => normalize(r.id) === normalize(id));
    const originalState = resource?.state ?? "removed";

    if (newState === "global") {
      // Remove from ALL lists everywhere
      globalPkgs = globalPkgs.filter(p => !matchPkg(p, id));
      globalDisabled = globalDisabled.filter(p => !matchPkg(p, id));
      projPkgs = projPkgs.filter(p => !matchPkg(p, id));
      projDisabled = projDisabled.filter(p => !matchPkg(p, id));
      for (const ws of otherWorkspaceSettings) {
        ws.pkgs = ws.pkgs.filter(p => !matchPkg(p, id));
        ws.disabled = ws.disabled.filter(p => !matchPkg(p, id));
      }
      // Add to global
      globalPkgs.push(id);

    } else if (newState === "workspace") {
      // Remove from global and current workspace only (don't touch other workspaces)
      globalPkgs = globalPkgs.filter(p => !matchPkg(p, id));
      globalDisabled = globalDisabled.filter(p => !matchPkg(p, id));
      projPkgs = projPkgs.filter(p => !matchPkg(p, id));
      projDisabled = projDisabled.filter(p => !matchPkg(p, id));
      // Add to current workspace
      projPkgs.push(id);

    } else {
      // "removed" — only remove from the scope it belongs to
      if (originalState === "global") {
        // Remove from global
        globalPkgs = globalPkgs.filter(p => !matchPkg(p, id));
        globalDisabled.push(id);
      } else if (originalState === "workspace") {
        // Remove from current workspace
        projPkgs = projPkgs.filter(p => !matchPkg(p, id));
        projDisabled.push(id);
      } else {
        // Not in any scope — just add to disabled
        globalDisabled.push(id);
      }
      // Never touch other workspaces
    }
  }

  // Write global settings
  globalSettings.packages = globalPkgs;
  globalSettings._disabledPackages = globalDisabled;
  // Also sync extensions/skills/themes/prompts overrides with disabled state
  for (const field of ["extensions", "skills", "themes", "prompts"]) {
    const entries: string[] = globalSettings[field] || [];
    const filtered = entries.filter(e => {
      const resolved = resolve(PI_AGENT, e).replace(/\\/g, "/");
      return !globalDisabled.some(d => normalize(d) === resolved);
    });
    if (filtered.length !== entries.length) globalSettings[field] = filtered;
  }
  writeJson(globalPath, globalSettings);

  // Write current workspace settings (skip system directories)
  const isSystemDir = /^(?:[A-Z]:\\(?:Windows|Program Files|Program Files \(x86\)))\b/i.test(cwd);
  if (!isSystemDir) {
    projSettings.packages = projPkgs;
    projSettings._disabledPackages = projDisabled;
    // Also sync extensions/skills/themes/prompts overrides with disabled state
    const overrideFields = ["extensions", "skills", "themes", "prompts"];
    for (const field of overrideFields) {
      const entries: string[] = projSettings[field] || [];
      const filtered = entries.filter(e => {
        const resolved = resolve(cwd, e).replace(/\\/g, "/");
        return !projDisabled.some(d => normalize(d) === resolved);
      });
      if (filtered.length !== entries.length) projSettings[field] = filtered;
    }
    writeJson(projPath, projSettings);
  }

  // Write other affected workspace settings
  for (const ws of otherWorkspaceSettings) {
    // Only write if changed
    const origSettings = readJson(ws.path);
    const origPkgs = JSON.stringify(origSettings.packages || []);
    const newPkgs = JSON.stringify(ws.pkgs);
    if (origPkgs !== newPkgs) {
      origSettings.packages = ws.pkgs;
      if (ws.disabled.length > 0) origSettings._disabledPackages = ws.disabled;
      writeJson(ws.path, origSettings);
    }
  }
}

// ─── Plugin Manager TUI ─────────────────────────────────────

const TABS = ["Extensions", "Skills", "Others"] as const;
const STATE_LABELS: Record<ResourceState, string> = {
  global: "🌐 Global",
  workspace: "📁 Workspace",
  removed: "✗ Remove",
};
const STATE_COLORS: Record<ResourceState, string> = {
  global: "success",
  workspace: "accent",
  removed: "dim",
};

export default function (pi: ExtensionAPI) {

  // ═══════════════════════════════════════════════════════════
  // 0. STARTUP VALIDATION
  // ═══════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;
    const messages: string[] = [];

    // ═══ 1. Validate current workspace local-dev plugins ═══
    const projPath = join(cwd, ".pi", "settings.json");
    const settings = readJson(projPath);
    const packages: string[] = settings.packages || [];

    const invalid: string[] = [];
    for (const pkg of packages) {
      if (pkg.startsWith("extensions/") || pkg.startsWith("extensions\\") ||
          pkg.startsWith("git:") || pkg.startsWith("github:") || pkg.startsWith("npm:"))
        continue;
      if (!existsSync(resolve(PI_AGENT, pkg))) invalid.push(pkg);
    }
    if (invalid.length > 0) {
      settings.packages = packages.filter(p => !invalid.includes(p));
      writeJson(projPath, settings);
      messages.push(`Removed ${invalid.length} invalid plugin(s)`);
    }

    // ═══ 2. Scan ALL workspaces for local resources ═══
    const RESOURCE_DIRS = ["extensions", "skills", "themes", "prompts"];
    const sessionDirs = listSessionDirs();
    // Include current workspace even if it has no sessions yet
    const allWorkspaceCwds = new Set<string>(sessionDirs.map(d => sessionDirToCwd(d)));
    allWorkspaceCwds.add(cwd);

    for (const wsCwd of allWorkspaceCwds) {
      for (const resType of RESOURCE_DIRS) {
        const wsResDir = join(wsCwd, ".pi", resType);
        if (!existsSync(wsResDir)) continue;

        // List local resources
        let resFiles: string[] = [];
        try {
          resFiles = readdirSync(wsResDir).filter(f => {
            if (f.startsWith(".") || f === ".ignore" || f === ".gitignore") return false;
            const full = join(wsResDir, f);
            if (resType === "extensions") {
              if (f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js")) return true;
              if (statSync(full).isDirectory())
                return existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"));
            } else if (resType === "skills") {
              return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
            } else if (resType === "themes") {
              return f.endsWith(".js") || f.endsWith(".ts") || statSync(full).isDirectory();
            } else if (resType === "prompts") {
              return f.endsWith(".md");
            }
            return false;
          });
        } catch { continue; }
        if (resFiles.length === 0) continue;

        // Add .ignore to block auto-discover
        const ignorePath = join(wsResDir, ".ignore");
        if (!existsSync(ignorePath)) {
          writeFileSync(ignorePath, "*\n", "utf-8");
          messages.push(`${workspaceName(wsCwd)}: added .ignore to ${resType}`);
        }

        // Register to workspace's .pi/settings.json
        const wsSettingsPath = join(wsCwd, ".pi", "settings.json");
        const wsSettings = readJson(wsSettingsPath);
        let wsPkgs: string[] = wsSettings.packages || [];
        const wsDisabled: string[] = wsSettings._disabledPackages || [];
        const wNorm = (p: string) => p.replace(/\\/g, "/");
        let added = 0;
        for (const res of resFiles) {
          const pkgRef = join(wsCwd, ".pi", resType, res).replace(/\\/g, "/");
          // Check both packages and disabled — skip if already registered or disabled
          if (wsPkgs.some(p => wNorm(p) === pkgRef)) continue;
          if (wsDisabled.some(d => wNorm(d) === pkgRef)) continue;
          wsPkgs.push(pkgRef);
          added++;
        }
        if (added > 0) {
          wsSettings.packages = wsPkgs;
          writeJson(wsSettingsPath, wsSettings);
          messages.push(`${workspaceName(wsCwd)}: registered ${added} ${resType}(s)`);
        }
      }
    }

    // ═══ 3. Scan global directories — always register ═══
    // Unconditionally scan global extensions/skills/themes,
    // register to settings.json, then create .ignore to prevent
    // double-loading (auto-discover + packages).
    for (const resType of ["extensions", "skills", "themes"]) {
      const globalResDir = join(PI_AGENT, resType);
      if (!existsSync(globalResDir)) continue;

      let resFiles: string[] = [];
      try {
        resFiles = readdirSync(globalResDir).filter(f => {
          if (f.startsWith(".") || f === ".ignore" || f === ".gitignore") return false;
          const full = join(globalResDir, f);
          if (resType === "extensions") {
            if (f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js")) return true;
            if (statSync(full).isDirectory())
              return existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"));
          } else if (resType === "skills") {
            return statSync(full).isDirectory() && existsSync(join(full, "SKILL.md"));
          } else if (resType === "themes") {
            return f.endsWith(".js") || f.endsWith(".ts") || statSync(full).isDirectory();
          }
          return false;
        });
      } catch { continue; }
      if (resFiles.length === 0) continue;

      const globalSettingsPath = join(PI_AGENT, "settings.json");
      const gs = readJson(globalSettingsPath);
      let gPkgs: string[] = gs.packages || [];
      const gDisabled: string[] = gs._disabledPackages || [];
      const normalize = (p: string) => p.replace(/\\/g, "/");
      const isDisabled = (ref: string) => gDisabled.some(d => normalize(d) === normalize(ref));
      let added = 0;
      for (const res of resFiles) {
        const pkgRef = `${resType}/${res}`;
        if (isDisabled(pkgRef)) continue; // skip disabled plugins
        if (!gPkgs.includes(pkgRef)) {
          gPkgs.push(pkgRef);
          added++;
        }
      }
      if (added > 0) {
        gs.packages = gPkgs;
        writeJson(globalSettingsPath, gs);
        messages.push(`Global: registered ${added} ${resType}(s)`);
      }

      // Create .ignore AFTER registration to prevent double-loading
      const ignorePath = join(globalResDir, ".ignore");
      if (!existsSync(ignorePath)) {
        writeFileSync(ignorePath, "*\n", "utf-8");
        messages.push(`Global: created ${resType}/.ignore`);
      }
    }

    if (messages.length > 0) {
      ctx.ui.notify(messages.join("\n"), "info");
    }
  });

  // ═══════════════════════════════════════════════════════════
  // 1. SESSION BROWSING
  // ═══════════════════════════════════════════════════════════

  pi.registerCommand("browse", {
    description: "Browse all sessions across workspaces, launch in new terminal tab",
    getArgumentCompletions: (prefix: string) => {
      if (!prefix) return null;
      return [{ value: prefix, label: `Search: ${prefix}` }];
    },
    handler: async (args, ctx) => {
      const query = args?.trim().toLowerCase();
      const dirs = listSessionDirs();
      if (dirs.length === 0) { ctx.ui.notify("No sessions found.", "info"); return; }

      const allSessions: SessionInfo[] = [];
      for (const dir of dirs) {
        const cwd = sessionDirToCwd(dir);
        for (const s of listSessionsInDir(dir)) {
          s.cwd = cwd; s.preview = getFirstMessage(s.file);
          allSessions.push(s);
        }
      }
      allSessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      const filtered = query
        ? allSessions.filter(s => s.name.toLowerCase().includes(query) || s.preview.toLowerCase().includes(query) || s.cwd.toLowerCase().includes(query))
        : allSessions;

      if (filtered.length === 0) { ctx.ui.notify("No sessions found.", "info"); return; }

      const items: SelectItem[] = filtered.slice(0, 50).map(s => ({
        value: JSON.stringify({ cwd: s.cwd, file: s.file }),
        label: `[${workspaceName(s.cwd)}] ${s.modified.toLocaleDateString()} ${s.modified.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
        description: s.preview.replace(/\n/g, " ").slice(0, 60) || "(empty)",
      }));

      const title = query ? `Sessions: ${filtered.length} match` : `All sessions (${filtered.length})`;

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 1, 0));
        const sl = new SelectList(items, Math.min(items.length + 2, 15), {
          selectedPrefix: (t) => theme.fg("accent", t), selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t), scrollInfo: (t) => theme.fg("dim", t),
        });
        sl.onSelect = (item) => done(item.value); sl.onCancel = () => done(null);
        container.addChild(sl);
        container.addChild(new Text(theme.fg("dim", " ↑↓ navigate · enter launch · esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w) => container.render(w), invalidate: () => container.invalidate(),
          handleInput: (data) => { sl.handleInput(data); tui.requestRender(); },
        };
      });

      if (!result) return;
      const { cwd: targetCwd, file: targetFile } = JSON.parse(result);
      const ok = launchTerminal(targetCwd, targetFile);
      ctx.ui.notify(ok ? `Launched: ${workspaceName(targetCwd)}` : "Failed to launch Alacritty.", ok ? "info" : "error");
    },
  });

  // ═══════════════════════════════════════════════════════════
  // 2. PLUGIN MANAGEMENT PANEL
  // ═══════════════════════════════════════════════════════════

  pi.registerCommand("plugins", {
    description: "Plugin manager — manage plugins, skills, and themes",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      let resources = buildResourceIndex(cwd);
      const changes = new Map<string, ResourceState>();

      const getEffectiveState = (r: ManagedResource): ResourceState => {
        return changes.get(r.id) ?? r.state;
      };

      let selected = 0;
      const maxVisible = 14;

      const saved = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
        const container = new Container();
        const border1 = new DynamicBorder((s: string) => theme.fg("accent", s));
        const headerText = new Text("", 1, 0);
        const listText = new Text("", 0, 0);
        const helpText = new Text("", 1, 0);
        const border2 = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(border1);
        container.addChild(headerText);
        container.addChild(listText);
        container.addChild(helpText);
        container.addChild(border2);
        let currentWidth = 80;

        const refresh = () => {
          resources = buildResourceIndex(cwd);
          if (selected >= resources.length) selected = Math.max(0, resources.length - 1);

          const ws = workspaceName(cwd);
          const dirtyCount = [...changes.entries()].filter(([id, st]) => {
            const r = resources.find(r2 => r2.id === id);
            return (r?.state ?? "removed") !== st;
          }).length;
          headerText.setText(theme.fg("accent", theme.bold(` Plugins — ${ws}`)) + (dirtyCount > 0 ? theme.fg("warning", `  (${dirtyCount} changed)` ) : ""));

          const lines: string[] = [];
          if (resources.length === 0) {
            lines.push(theme.fg("dim", "  (no resources found)"));
          } else {
            let scrollStart = Math.max(0, selected - Math.floor(maxVisible / 2));
            const scrollEnd = Math.min(resources.length, scrollStart + maxVisible);
            scrollStart = Math.max(0, scrollEnd - maxVisible);

            for (let i = scrollStart; i < scrollEnd; i++) {
              const r = resources[i];
              const st = getEffectiveState(r);
              const changed = changes.has(r.id) && st !== (r.state ?? "removed");
              const cursor = i === selected ? theme.fg("accent", "→") : " ";
              const mark = changed ? theme.fg("warning", "●") : " ";
              const nameMax = Math.max(10, currentWidth - 4 - 20);
              const prefix = r.installed ? "       " : theme.fg("warning", "[MISS] ");
              const nameRaw = r.name;
              const nameStr = nameRaw.length > nameMax ? nameRaw.slice(0, nameMax - 1) + "…" : nameRaw.padEnd(nameMax);
              const stateStr = theme.fg(STATE_COLORS[st], STATE_LABELS[st]);
              lines.push(` ${cursor} ${mark} ${prefix}${nameStr}${stateStr}`);
            }

            if (resources.length > maxVisible) {
              lines.push(theme.fg("dim", `  ${scrollStart + 1}-${scrollEnd} of ${resources.length}`));
            }
          }
          listText.setText(lines.join("\n"));

          helpText.setText(theme.fg("dim", " ↑↓ move  1:Global 2:Workspace 3:Remove  Enter:save  Esc:cancel"));
        };

        refresh();

        return {
          render: (w) => {
            if (currentWidth !== w) { currentWidth = w; refresh(); container.invalidate(); }
            return container.render(w);
          },
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "up")) {
              if (selected > 0) selected--;
              refresh(); container.invalidate(); tui.requestRender();
            } else if (matchesKey(data, "down")) {
              if (selected < resources.length - 1) selected++;
              refresh(); container.invalidate(); tui.requestRender();
            } else if (data === "1") {
              if (resources.length > 0) {
                changes.set(resources[selected].id, "global");
              }
              refresh(); container.invalidate(); tui.requestRender();
            } else if (data === "2") {
              if (resources.length > 0) {
                changes.set(resources[selected].id, "workspace");
              }
              refresh(); container.invalidate(); tui.requestRender();
            } else if (data === "3") {
              if (resources.length > 0) {
                changes.set(resources[selected].id, "removed");
              }
              refresh(); container.invalidate(); tui.requestRender();
            } else if (matchesKey(data, "enter")) {
              done(true);
            } else if (matchesKey(data, "escape")) {
              done(false);
            }
          },
        };
      });

      if (saved && changes.size > 0) {
        // Filter out no-ops (final state === original state)
        const realChanges = new Map<string, ResourceState>();
        for (const [id, newState] of changes) {
          const r = resources.find(r2 => r2.id === id);
          const origState = r?.state ?? "removed";
          if (newState !== origState) realChanges.set(id, newState);
        }
        if (realChanges.size > 0) {
          applyChanges(cwd, resources, realChanges);
          ctx.ui.notify(`Saved ${realChanges.size} change(s). /reload to apply.`, "info");
        }
      }
    },
  });

  // ═══════════════════════════════════════════════════════════
  // 3. WORKSPACE SESSION TOOL
  // ═══════════════════════════════════════════════════════════

  pi.registerTool({
    name: "workspace_sessions",
    label: "Workspace Sessions",
    description: "List all pi conversation sessions across all workspaces/projects.",
    promptSnippet: "List/search sessions across all workspaces",
    promptGuidelines: [
      "Use workspace_sessions when the user wants to find a previous conversation or switch between projects.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Filter by keyword" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const dirs = listSessionDirs();
      if (dirs.length === 0) return { content: [{ type: "text", text: "No sessions found." }] };

      const query = params.query?.toLowerCase();
      const limit = params.limit ?? 20;

      const all: SessionInfo[] = [];
      for (const dir of dirs) {
        const cwd = sessionDirToCwd(dir);
        for (const s of listSessionsInDir(dir)) { s.cwd = cwd; s.preview = getFirstMessage(s.file); all.push(s); }
      }
      all.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      const filtered = query
        ? all.filter(s => s.name.toLowerCase().includes(query!) || s.preview.toLowerCase().includes(query!) || s.cwd.toLowerCase().includes(query!))
        : all;

      const shown = filtered.slice(0, limit);
      const byWs = new Map<string, SessionInfo[]>();
      for (const s of shown) {
        const ws = workspaceName(s.cwd);
        if (!byWs.has(ws)) byWs.set(ws, []);
        byWs.get(ws)!.push(s);
      }

      let output = query ? `Sessions matching "${params.query}" (${filtered.length}):\n\n` : `All sessions (${filtered.length}, showing ${shown.length}):\n\n`;
      for (const [ws, sessions] of byWs) {
        output += `📁 ${ws} (${sessions[0].cwd})\n`;
        for (const s of sessions) {
          const date = s.modified.toLocaleDateString() + " " + s.modified.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          output += `   [${date}] ${(getSessionName(s.metaFile) || "").padEnd(20)} ${s.preview.replace(/\n/g, " ").slice(0, 60) || "(empty)"}\n`;
        }
        output += "\n";
      }
      return { content: [{ type: "text", text: output }] };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("workspace_sessions ")) + theme.fg("dim", args.query ? `"${args.query}"` : "all"), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Loading..."), 0, 0);
      if (result.isError) return new Text(theme.fg("error", "Failed"), 0, 0);
      const m = (result.content?.[0]?.text || "").match(/\((\d+)\)/);
      return new Text(theme.fg("success", m ? `✓ ${m[1]} session(s)` : "✓ Done"), 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════
  // 4. /ws — Quick workspace launcher
  // ═══════════════════════════════════════════════════════════

  pi.registerCommand("ws", {
    description: "Quick workspace launcher — pick workspace, open in new terminal",
    handler: async (_args, ctx) => {
      const dirs = listSessionDirs();
      if (dirs.length === 0) { ctx.ui.notify("No workspaces found.", "info"); return; }

      const wsMap = new Map<string, Date>();
      for (const dir of dirs) {
        const cwd = sessionDirToCwd(dir);
        const sessions = listSessionsInDir(dir);
        if (sessions.length > 0) {
          const latest = sessions[0].modified;
          if (!wsMap.has(cwd) || latest > wsMap.get(cwd)!) wsMap.set(cwd, latest);
        }
      }

      const workspaces = Array.from(wsMap.entries()).sort((a, b) => b[1].getTime() - a[1].getTime());
      const items: SelectItem[] = workspaces.map(([cwd, date]) => ({
        value: cwd, label: workspaceName(cwd),
        description: `${date.toLocaleDateString()} — ${cwd}`,
      }));

      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Workspaces")), 1, 0));
        const sl = new SelectList(items, Math.min(items.length + 2, 15), {
          selectedPrefix: (t) => theme.fg("accent", t), selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t), scrollInfo: (t) => theme.fg("dim", t),
        });
        sl.onSelect = (item) => done(item.value); sl.onCancel = () => done(null);
        container.addChild(sl);
        container.addChild(new Text(theme.fg("dim", " ↑↓ navigate · enter launch · esc cancel"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (w) => container.render(w), invalidate: () => container.invalidate(),
          handleInput: (data) => { sl.handleInput(data); tui.requestRender(); },
        };
      });

      if (!result) return;
      const ok = launchTerminal(result);
      ctx.ui.notify(ok ? `Launched: ${workspaceName(result)}` : "Failed to launch Alacritty.", ok ? "info" : "error");
    },
  });
}
