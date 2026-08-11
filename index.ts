/**
 * pi-workspace-manager
 *
 * 1. Cross-workspace session browsing & launching via Alacritty
 * 2. Unified plugin management panel with custom TUI (/plugins)
 * 3. Startup validation — auto-remove invalid local-dev plugins
 * 4. Guarded model-triggered context compaction with automatic task continuation
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Container, type SelectItem, SelectList,
  type SettingItem, SettingsList, Text, matchesKey,
} from "@earendil-works/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join, resolve } from "node:path";
import {
  existsSync, readFileSync, writeFileSync,
  readdirSync, statSync, mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";

const HOME = homedir();
const PI_AGENT = join(HOME, ".pi", "agent");
const SESSIONS_DIR = join(PI_AGENT, "sessions");
const PI_CMD = join(HOME, "AppData", "Roaming", "npm", "pi.cmd");
const ALACRITTY = "C:\\Program Files\\Alacritty\\alacritty.exe";
const WT = "wt.exe";
const CMD = "cmd.exe";
const MANAGER_CONFIG_KEY = "pi-workspace-manager";

interface WorkspaceManagerConfig {
  reload: {
    enabled: boolean;
  };
  compact: {
    enabled: boolean;
    thresholdPercent: number;
    retryOnFailure: boolean;
    maxRetries: number;
    retryDelayMs: number;
    resumeAfterForcedAutoCompact: boolean;
  };
}

interface PendingCompactRequest {
  unfinishedTask: string;
  config: WorkspaceManagerConfig["compact"];
  compactionObserved: boolean;
  manualStarted: boolean;
}

interface ForcedAutoCompactResume {
  reason: "threshold" | "overflow";
  percent: number | null;
  willRetry: boolean;
  previousTask: string;
  compactionObserved: boolean;
}

const DEFAULT_MANAGER_CONFIG: WorkspaceManagerConfig = {
  reload: { enabled: true },
  compact: {
    enabled: true,
    thresholdPercent: 95,
    retryOnFailure: true,
    maxRetries: 2,
    retryDelayMs: 2000,
    resumeAfterForcedAutoCompact: true,
  },
};

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

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function loadManagerConfig(): WorkspaceManagerConfig {
  const settings = readJson(join(PI_AGENT, "settings.json"));
  const raw = settings[MANAGER_CONFIG_KEY] ?? {};
  const rawReload = raw.reload ?? {};
  const rawCompact = raw.compact ?? {};
  return {
    reload: {
      enabled: typeof rawReload.enabled === "boolean" ? rawReload.enabled : DEFAULT_MANAGER_CONFIG.reload.enabled,
    },
    compact: {
      enabled: typeof rawCompact.enabled === "boolean" ? rawCompact.enabled : DEFAULT_MANAGER_CONFIG.compact.enabled,
      thresholdPercent: boundedInteger(rawCompact.thresholdPercent, DEFAULT_MANAGER_CONFIG.compact.thresholdPercent, 50, 99),
      retryOnFailure: typeof rawCompact.retryOnFailure === "boolean"
        ? rawCompact.retryOnFailure
        : DEFAULT_MANAGER_CONFIG.compact.retryOnFailure,
      maxRetries: boundedInteger(rawCompact.maxRetries, DEFAULT_MANAGER_CONFIG.compact.maxRetries, 0, 10),
      retryDelayMs: boundedInteger(rawCompact.retryDelayMs, DEFAULT_MANAGER_CONFIG.compact.retryDelayMs, 250, 30000),
      resumeAfterForcedAutoCompact: typeof rawCompact.resumeAfterForcedAutoCompact === "boolean"
        ? rawCompact.resumeAfterForcedAutoCompact
        : DEFAULT_MANAGER_CONFIG.compact.resumeAfterForcedAutoCompact,
    },
  };
}

function saveManagerConfig(config: WorkspaceManagerConfig): void {
  const settingsPath = join(PI_AGENT, "settings.json");
  const settings = readJson(settingsPath);
  settings[MANAGER_CONFIG_KEY] = config;
  writeJson(settingsPath, settings);
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

function getMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && "type" in part && "text" in part && part.type === "text") {
      return typeof part.text === "string" ? part.text : "";
    }
    return "";
  }).filter(Boolean).join("\n");
}

function getLatestUserTask(entries: readonly any[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "message" || entry.message?.role !== "user") continue;
    const text = getMessageText(entry.message.content).trim();
    if (!text) continue;
    return text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
  }
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

/**
 * Launch terminal via detached node process (survives parent shutdown).
 * Uses same Alacritty → WT → cmd fallback as launchTerminal.
 */
function launchTerminalDetached(cwd: string, sessionFile: string): boolean {
  const piCmd = process.platform === "win32"
    ? execSync("where pi.cmd").toString().trim().split("\n")[0].replace(/\\/g, "/")
    : "pi";

  // Build launch commands in priority order
  const commands: [string, string[]][] = [];
  if (existsSync(ALACRITTY)) {
    commands.push([ALACRITTY, ["--working-directory", cwd, "-e", piCmd, "--session", sessionFile]]);
  }
  commands.push(["wt.exe", ["-d", cwd, "--", piCmd, "--session", sessionFile]]);
  commands.push(["cmd.exe", ["/c", `cd /d "${cwd}" && "${piCmd}" --session "${sessionFile}"`]]);

  if (process.platform === "win32") {
    // On Windows: save foreground window, launch terminal, then restore focus
    // Look for focus scripts in plugin's own bin/ directory
    const pluginBin = join(PI_AGENT, "git", "github.com", "inouemoby", "pi-workspace-manager", "bin");
    const focusPs1 = join(pluginBin, "restore-focus.ps1").replace(/\\/g, "/");
    const hasFocusPs1 = existsSync(focusPs1);
    if (hasFocusPs1) {
      // Save foreground window handle before launching
      try {
        execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${focusPs1}" save`, { timeout: 3000, stdio: "ignore" });
      } catch {}
    }
    // Launch terminal via node launcher (survives process.exit)
    const launcher = `
      const{spawn}=require('child_process');
      const cmds=${JSON.stringify(commands)};
      for(const[exe,args]of cmds){
        try{
          const p=spawn(exe,args,{detached:true,stdio:'ignore'});
          p.unref();
          if(p.pid){process.exit(0);}
        }catch{}
      }
      process.exit(1);
    `;
    spawn(process.execPath, ["-e", launcher], { detached: true, stdio: "ignore" }).unref();
    // Restore foreground window after launch
    if (hasFocusPs1) {
      try {
        execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${focusPs1}" restore`, { timeout: 5000, stdio: "ignore" });
      } catch {}
    }
  } else {
    // macOS/Linux: just spawn directly via node launcher
    const launcher = `
      const{spawn}=require('child_process');
      const cmds=${JSON.stringify(commands)};
      for(const[exe,args]of cmds){
        try{
          const p=spawn(exe,args,{detached:true,stdio:'ignore'});
          p.unref();
          if(p.pid){process.exit(0);}
        }catch{}
      }
      process.exit(1);
    `;
    spawn(process.execPath, ["-e", launcher], { detached: true, stdio: "ignore" }).unref();
  }
  return true;
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

/**
 * Recursively find all directories containing SKILL.md under baseDir.
 * Returns POSIX-style relative paths from baseDir.
 * A SKILL.md marks a skill boundary — stop recursing once found.
 * Skips .git and node_modules, but traverses other dot-directories
 * (e.g. .claude/skills/...) where skills may nest in Claude-style repos.
 */
function findSkillDirs(baseDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string, rel: string) => {
    if (existsSync(join(dir, "SKILL.md"))) {
      if (rel) results.push(rel);
      return; // skill boundary — don't recurse into skill internals
    }
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === ".git" || name === "node_modules" || name === ".ignore") continue;
      const full = join(dir, name);
      try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
      walk(full, rel ? `${rel}/${name}` : name);
    }
  };
  walk(baseDir, "");
  return results;
}

function listInstalledSkills(): string[] {
  const dir = join(PI_AGENT, "skills");
  try {
    return findSkillDirs(dir);
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
  type: "skill" | "package";  // skill → skills[] array, package → packages[] array
}

function buildResourceIndex(cwd: string): ManagedResource[] {
  const normalize = (p: string) => p.replace(/\\/g, "/");

  const globalSettings = readJson(join(PI_AGENT, "settings.json"));
  const projSettings = readJson(join(cwd, ".pi", "settings.json"));

  // ── Auto-cleanup: prune stale references to physically-removed resources ──
  // A disabled-but-missing entry is stale (the resource was permanently removed outside pi).
  // Keeping it in _disabledPackages makes the entry reappear in the list forever as "removed",
  // confusing users who already deleted the files. Prune silently.
  // Only _disabledPackages is pruned automatically — skills[]/packages[] [MISS] entries are
  // kept visible so the user can decide via the UI.
  const installedGit = new Set(listInstalledGitPackages());
  const checkExists = (ref: string): boolean => {
    if (ref.startsWith("git:") || ref.startsWith("github:")) return installedGit.has(ref);
    if (ref.startsWith("npm:")) return true;
    return existsSync(resolve(PI_AGENT, ref)) || existsSync(resolve(cwd, ref));
  };
  let prunedAny = false;
  for (const settings of [globalSettings, projSettings]) {
    const disabled = settings._disabledPackages;
    if (Array.isArray(disabled) && disabled.length > 0) {
      const filtered = disabled.filter(checkExists);
      if (filtered.length !== disabled.length) {
        settings._disabledPackages = filtered;
        prunedAny = true;
      }
    }
  }
  if (prunedAny) {
    try {
      writeJson(join(PI_AGENT, "settings.json"), globalSettings);
      const projPath = join(cwd, ".pi", "settings.json");
      const isSystemDir = /^(?:[A-Z]:\\(?:Windows|Program Files|Program Files \(x86\)))\b/i.test(cwd);
      if (!isSystemDir && existsSync(projPath)) writeJson(projPath, projSettings);
    } catch { /* best effort */ }
  }

  // ── Skills channel: skills[] array (relative paths, no resolve) ──
  // Skills are registered as relative paths like "skills/repo/.claude/skills/x"
  // and stored verbatim in settings.skills[]. State is determined by exact
  // string match against skills[] — never resolved to absolute.
  const globalActiveSkills: string[] = globalSettings.skills || [];
  const projActiveSkills: string[] = projSettings.skills || [];
  const allWsSkillRefs = new Set<string>();
  for (const dir of listSessionDirs()) {
    const wsCwd = sessionDirToCwd(dir);
    const wsSettings = readJson(join(wsCwd, ".pi", "settings.json"));
    for (const s of wsSettings.skills || []) allWsSkillRefs.add(normalize(s));
  }

  const getSkillState = (id: string): ResourceState => {
    const nid = normalize(id);
    if (globalActiveSkills.some(p => normalize(p) === nid)) return "global";
    if (projActiveSkills.some(p => normalize(p) === nid)) return "workspace";
    return "removed";
  };

  // ── Packages channel: packages[] array + extensions/themes/prompts overrides (existing behavior) ──
  const overrideFields = ["extensions", "themes", "prompts"];
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

  const getPkgState = (id: string): ResourceState => {
    const nid = normalize(id);
    if (globalActiveRefs.some(p => normalize(p) === nid)) return "global";
    if (projActiveRefs.some(p => normalize(p) === nid)) return "workspace";
    return "removed";
  };

  const resources: ManagedResource[] = [];
  const seen = new Set<string>();

  const add = (id: string, name: string, type: "skill" | "package") => {
    const nid = normalize(id);
    if (seen.has(nid)) return;
    seen.add(nid);
    const state = type === "skill" ? getSkillState(id) : getPkgState(id);
    resources.push({ id: nid, name, installed: true, state, type });
  };

  // Physical scan — global skills (recursive, finds nested SKILL.md)
  // ID = "skills/<relpath>" (matches settings entry); name = last path segment
  for (const skill of listInstalledSkills()) {
    const display = skill.split("/").pop() || skill;
    add(`skills/${skill}`, display, "skill");
  }
  // Physical scan — global packages
  for (const ext of listInstalledExtensions()) add(`extensions/${ext}`, ext, "package");
  for (const git of listInstalledGitPackages()) add(git, git.split("/").pop() || git, "package");
  for (const theme of listInstalledThemes()) add(`themes/${theme}`, theme, "package");

  // Physical scan — workspace-local .pi/ resources
  const WS_RES_TYPES = ["extensions", "skills", "themes", "prompts"];
  for (const resType of WS_RES_TYPES) {
    const wsResDir = join(cwd, ".pi", resType);
    if (!existsSync(wsResDir)) continue;
    try {
      if (resType === "skills") {
        // Recursive skill discovery in workspace .pi/skills/
        // ID format: "skills/<relpath>" to match settings.skills[] entries (resolved against cwd/.pi)
        for (const rel of findSkillDirs(wsResDir)) {
          const display = rel.split("/").pop() || rel;
          add(`skills/${rel}`, display, "skill");
        }
        continue;
      }
      for (const f of readdirSync(wsResDir)) {
        if (f.startsWith(".") || f === ".ignore") continue;
        const full = join(wsResDir, f);
        const absPath = full.replace(/\\/g, "/");
        if (seen.has(absPath)) continue;
        let valid = false;
        if (resType === "extensions") {
          valid = f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js") ||
            (statSync(full).isDirectory() && (existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"))));
        } else {
          valid = f.endsWith(".js") || f.endsWith(".ts") || f.endsWith(".md") || statSync(full).isDirectory();
        }
        if (valid) {
          seen.add(absPath);
          resources.push({ id: absPath, name: f, installed: true, state: getPkgState(absPath), type: "package" });
        }
      }
    } catch { /* */ }
  }

  // Add remaining from settings that weren't physically found (packages channel only)
  const allRegisteredIds = new Set([...globalAllRefs, ...projAllRefs, ...allWorkspaceRefs]);
  for (const rawId of allRegisteredIds) {
    const id = normalize(rawId);
    if (!seen.has(id)) {
      seen.add(id);
      resources.push({ id, name: id.split("/").pop() || id, installed: existsSync(id) || rawId.startsWith("git:") || rawId.startsWith("npm:"), state: getPkgState(id), type: "package" });
    }
  }
  // Add skill refs from settings not physically found
  for (const rawId of [...globalActiveSkills, ...projActiveSkills, ...allWsSkillRefs]) {
    const id = normalize(rawId);
    if (!seen.has(id)) {
      seen.add(id);
      resources.push({ id, name: id.split("/").pop() || id, installed: existsSync(resolve(PI_AGENT, id)), state: getSkillState(id), type: "skill" });
    }
  }

  resources.sort((a, b) => a.name.localeCompare(b.name));
  return resources;
}

function applyChanges(cwd: string, resources: ManagedResource[], changes: Map<string, ResourceState>) {
  if (changes.size === 0) return;

  const normalize = (p: string) => p.replace(/\\/g, "/");
  const matchRef = (ref: string, id: string) => normalize(ref) === normalize(id);

  // Read current settings — global
  const globalPath = join(PI_AGENT, "settings.json");
  const globalSettings = readJson(globalPath);
  let globalPkgs: string[] = [...(globalSettings.packages || [])];
  let globalSkills: string[] = [...(globalSettings.skills || [])];
  let globalDisabled: string[] = [...(globalSettings._disabledPackages || [])];

  // Read current settings — current workspace
  const projPath = join(cwd, ".pi", "settings.json");
  const projSettings = readJson(projPath);
  let projPkgs: string[] = [...(projSettings.packages || [])];
  let projSkills: string[] = [...(projSettings.skills || [])];
  let projDisabled: string[] = [...(projSettings._disabledPackages || [])];

  // Collect all other workspace settings that might be affected
  const otherWorkspaceSettings: Array<{ cwd: string; path: string; pkgs: string[]; skills: string[]; disabled: string[] }> = [];
  for (const dir of listSessionDirs()) {
    const wsCwd = sessionDirToCwd(dir);
    if (normalize(wsCwd) === normalize(cwd)) continue; // skip current workspace
    const wsPath = join(wsCwd, ".pi", "settings.json");
    const wsSettings = readJson(wsPath);
    if (!wsSettings.packages && !wsSettings.skills && !wsSettings._disabledPackages) continue;
    otherWorkspaceSettings.push({
      cwd: wsCwd, path: wsPath,
      pkgs: [...(wsSettings.packages || [])],
      skills: [...(wsSettings.skills || [])],
      disabled: [...(wsSettings._disabledPackages || [])],
    });
  }

  for (const [id, newState] of changes) {
    const resource = resources.find(r => normalize(r.id) === normalize(id));
    const originalState = resource?.state ?? "removed";
    const isSkill = resource?.type === "skill";

    // Helper: remove id from one scope's appropriate array(s)
    const removeFromGlobal = () => {
      if (isSkill) globalSkills = globalSkills.filter(p => !matchRef(p, id));
      else globalPkgs = globalPkgs.filter(p => !matchRef(p, id));
      globalDisabled = globalDisabled.filter(p => !matchRef(p, id));
    };
    const removeFromProj = () => {
      if (isSkill) projSkills = projSkills.filter(p => !matchRef(p, id));
      else projPkgs = projPkgs.filter(p => !matchRef(p, id));
      projDisabled = projDisabled.filter(p => !matchRef(p, id));
    };
    const removeFromAllOtherWs = () => {
      for (const ws of otherWorkspaceSettings) {
        if (isSkill) ws.skills = ws.skills.filter(p => !matchRef(p, id));
        else ws.pkgs = ws.pkgs.filter(p => !matchRef(p, id));
        ws.disabled = ws.disabled.filter(p => !matchRef(p, id));
      }
    };

    if (newState === "global") {
      // Remove from ALL lists everywhere, then add to global
      removeFromGlobal();
      removeFromProj();
      removeFromAllOtherWs();
      if (isSkill) globalSkills.push(id);
      else globalPkgs.push(id);

    } else if (newState === "workspace") {
      // Remove from global and current workspace only (don't touch other workspaces)
      removeFromGlobal();
      removeFromProj();
      if (isSkill) projSkills.push(id);
      else projPkgs.push(id);

    } else {
      // "removed" — only remove from the scope it belongs to
      if (originalState === "global") {
        removeFromGlobal();
        globalDisabled.push(id);
      } else if (originalState === "workspace") {
        removeFromProj();
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
  globalSettings.skills = globalSkills;
  globalSettings._disabledPackages = globalDisabled;
  writeJson(globalPath, globalSettings);

  // Write current workspace settings (skip system directories)
  const isSystemDir = /^(?:[A-Z]:\\(?:Windows|Program Files|Program Files \(x86\)))\b/i.test(cwd);
  if (!isSystemDir) {
    projSettings.packages = projPkgs;
    projSettings.skills = projSkills;
    projSettings._disabledPackages = projDisabled;
    writeJson(projPath, projSettings);
  }

  // Write other affected workspace settings
  for (const ws of otherWorkspaceSettings) {
    const origSettings = readJson(ws.path);
    const changed = JSON.stringify(origSettings.packages || []) !== JSON.stringify(ws.pkgs) ||
                    JSON.stringify(origSettings.skills || []) !== JSON.stringify(ws.skills);
    if (changed) {
      origSettings.packages = ws.pkgs;
      origSettings.skills = ws.skills;
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
  let managerConfig = loadManagerConfig();
  let sessionActive = false;
  let compactInProgress = false;
  let pendingCompactRequest: PendingCompactRequest | undefined;
  let forcedAutoCompactResume: ForcedAutoCompactResume | undefined;
  let compactRetryTimer: ReturnType<typeof setTimeout> | undefined;

  const applyManagedToolAvailability = () => {
    const active = new Set(pi.getActiveTools());
    if (managerConfig.reload.enabled) active.add("pi_reload");
    else active.delete("pi_reload");
    if (managerConfig.compact.enabled) active.add("pi_compact");
    else active.delete("pi_compact");
    pi.setActiveTools([...active]);
  };

  const persistManagerConfig = () => {
    saveManagerConfig(managerConfig);
    applyManagedToolAvailability();
  };

  const clearPendingCompaction = (request: PendingCompactRequest): boolean => {
    if (pendingCompactRequest !== request) return false;
    if (compactRetryTimer) clearTimeout(compactRetryTimer);
    compactRetryTimer = undefined;
    pendingCompactRequest = undefined;
    compactInProgress = false;
    return true;
  };

  const continueAfterCompaction = (request: PendingCompactRequest, ctx: ExtensionContext) => {
    if (!clearPendingCompaction(request) || !sessionActive) return;
    if (ctx.hasUI) ctx.ui.notify("Context compaction completed. Continuing task...", "info");
    try {
      pi.sendUserMessage(`上下文压缩已完成。请根据压缩后的上下文继续执行尚未完成的任务：${request.unfinishedTask}`);
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Failed to continue after compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  };

  const continueAfterForcedAutoCompaction = (request: ForcedAutoCompactResume, ctx: ExtensionContext) => {
    if (forcedAutoCompactResume !== request) return;
    forcedAutoCompactResume = undefined;
    if (!sessionActive) return;

    const percentText = request.percent === null ? "unknown usage" : `${request.percent.toFixed(1)}% context usage`;
    const retryText = request.willRetry
      ? "Pi has already completed its automatic compact-and-retry flow."
      : "Pi completed forced automatic compaction without an automatic task retry.";
    const taskText = request.previousTask
      ? `\n\nThe most recent user task before compaction was:\n${request.previousTask}`
      : "";
    if (ctx.hasUI) {
      ctx.ui.notify(`Forced automatic compaction completed (${percentText}). Checking unfinished task...`, "info");
    }
    try {
      pi.sendUserMessage(
        `Pi was forced to compact context because of ${request.reason} (${percentText}). ${retryText} `
        + "Inspect the compacted context now: if the previously requested task is still unfinished, continue from the interruption point and complete it. If it is already complete, do not repeat completed work; only confirm completion."
        + taskText,
      );
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Failed to continue after forced automatic compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  };

  const runManualCompaction = (request: PendingCompactRequest, ctx: ExtensionContext, attempt: number) => {
    const customInstructions = [
      "The current task is unfinished. Preserve everything required to resume it accurately after compaction.",
      `Unfinished task and next step: ${request.unfinishedTask}`,
      "Retain the user's original requirements and constraints, completed and pending work, key decisions, exact file paths and edits, errors, verification results, and concrete next steps.",
    ].join("\n");

    ctx.compact({
      customInstructions,
      onComplete: () => continueAfterCompaction(request, ctx),
      onError: (error) => {
        // Another compaction may have completed between the settled-state check
        // and this manual attempt. Treat that as success rather than surfacing a
        // second extension error or retrying an already-compacted session.
        if (/already compacted/i.test(error.message)) {
          continueAfterCompaction(request, ctx);
          return;
        }

        const retriesUsed = attempt - 1;
        const retryable = !/(cancelled|canceled|nothing to compact)/i.test(error.message);
        const shouldRetry = sessionActive
          && request.config.retryOnFailure
          && retriesUsed < request.config.maxRetries
          && retryable;
        if (shouldRetry) {
          const retryNumber = retriesUsed + 1;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Compaction failed: ${error.message}. Retry ${retryNumber}/${request.config.maxRetries} in ${request.config.retryDelayMs}ms...`,
              "warning",
            );
          }
          compactRetryTimer = setTimeout(() => {
            compactRetryTimer = undefined;
            if (!sessionActive || pendingCompactRequest !== request) return;
            runManualCompaction(request, ctx, attempt + 1);
          }, request.config.retryDelayMs);
          return;
        }

        if (!clearPendingCompaction(request)) return;
        if (ctx.hasUI) ctx.ui.notify(`Context compaction failed: ${error.message}`, "error");
      },
    });
  };

  // Capture forced native compaction even when the model never had a chance to
  // call pi_compact. Normal below-window threshold compaction is left alone;
  // the fallback is for overflow or a measured pre-compaction context >= 100%.
  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "manual" || pendingCompactRequest) return;
    if (!managerConfig.compact.resumeAfterForcedAutoCompact) return;

    const contextWindow = ctx.model?.contextWindow ?? 0;
    const percent = contextWindow > 0 ? (event.preparation.tokensBefore / contextWindow) * 100 : null;
    const forced = event.reason === "overflow" || (percent !== null && percent >= 100);
    if (!forced) return;

    if (forcedAutoCompactResume) {
      forcedAutoCompactResume.reason = event.reason;
      forcedAutoCompactResume.percent = percent ?? forcedAutoCompactResume.percent;
      forcedAutoCompactResume.willRetry ||= event.willRetry;
      const latestTask = getLatestUserTask(event.branchEntries);
      if (latestTask) forcedAutoCompactResume.previousTask = latestTask;
      return;
    }

    forcedAutoCompactResume = {
      reason: event.reason,
      percent,
      willRetry: event.willRetry,
      previousTask: getLatestUserTask(event.branchEntries),
      compactionObserved: false,
    };
  });

  // A model tool call ends its current turn first. Pi may then perform native
  // threshold/overflow compaction. Observe that result and only start manual
  // compaction after the agent is fully settled when no native compaction ran.
  pi.on("session_compact", () => {
    if (pendingCompactRequest) pendingCompactRequest.compactionObserved = true;
    if (forcedAutoCompactResume) forcedAutoCompactResume.compactionObserved = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
    const request = pendingCompactRequest;
    if (request && !request.manualStarted) {
      if (request.compactionObserved) {
        continueAfterCompaction(request, ctx);
        return;
      }

      request.manualStarted = true;
      if (ctx.hasUI) ctx.ui.notify("No automatic compaction ran. Starting manual compaction...", "warning");
      runManualCompaction(request, ctx, 1);
      return;
    }

    const forcedResume = forcedAutoCompactResume;
    if (!forcedResume) return;
    if (forcedResume.compactionObserved) {
      continueAfterForcedAutoCompaction(forcedResume, ctx);
    } else {
      // The forced auto-compaction attempt failed or was cancelled, so there is
      // no compacted context from which a continuation can safely start.
      forcedAutoCompactResume = undefined;
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!managerConfig.compact.enabled) return;
    const retryNote = managerConfig.compact.retryOnFailure
      ? `Transient failures may be retried up to ${managerConfig.compact.maxRetries} time(s).`
      : "Failure retry is disabled.";
    return {
      systemPrompt: `${event.systemPrompt}\n\nRuntime pi_compact setting: the task must be unfinished and context usage must be strictly above ${managerConfig.compact.thresholdPercent}% before calling the tool. ${retryNote}`,
    };
  });

  // ═══════════════════════════════════════════════════════════
  // 0. STARTUP VALIDATION
  // ═══════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    managerConfig = loadManagerConfig();
    applyManagedToolAvailability();

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

    // ═══ 1b. Migrate old-style skill entries from packages[] to skills[] ═══
    // Old workspace-manager versions registered skills as "skills/<name>" in
    // packages[]. Move them to the skills[] array where they belong.
    const migrateSettings = (settingsPath: string, label: string) => {
      const s = readJson(settingsPath);
      const pkgs: string[] = s.packages || [];
      const skills: string[] = s.skills || [];
      const skillEntries = pkgs.filter(p => p.startsWith("skills/") || p.startsWith("skills\\\\"));
      if (skillEntries.length === 0) return;
      s.packages = pkgs.filter(p => !skillEntries.includes(p));
      for (const sk of skillEntries) {
        if (!skills.includes(sk)) skills.push(sk);
      }
      s.skills = skills;
      writeJson(settingsPath, s);
      messages.push(`${label}: migrated ${skillEntries.length} skill(s) packages[] → skills[]`);
    };
    migrateSettings(join(PI_AGENT, "settings.json"), "Global");
    migrateSettings(join(cwd, ".pi", "settings.json"), workspaceName(cwd));
    for (const dir of listSessionDirs()) {
      const wsCwd = sessionDirToCwd(dir);
      if (wsCwd === cwd) continue;
      migrateSettings(join(wsCwd, ".pi", "settings.json"), workspaceName(wsCwd));
    }

    // ═══ 2. Scan ALL workspaces for local resources ═══
    const sessionDirs = listSessionDirs();
    // Include current workspace even if it has no sessions yet
    const allWorkspaceCwds = new Set<string>(sessionDirs.map(d => sessionDirToCwd(d)));
    allWorkspaceCwds.add(cwd);

    for (const wsCwd of allWorkspaceCwds) {
      // ── Workspace skills: recursive discovery, register to skills[] ──
      {
        const wsSkillsDir = join(wsCwd, ".pi", "skills");
        if (existsSync(wsSkillsDir)) {
          const skillRels = findSkillDirs(wsSkillsDir); // relative from wsSkillsDir
          if (skillRels.length > 0) {
            // Ensure .ignore blocks pi's auto-discover
            const ignorePath = join(wsSkillsDir, ".ignore");
            if (!existsSync(ignorePath) || readFileSync(ignorePath, "utf-8").trim() !== "*") {
              writeFileSync(ignorePath, "*\n", "utf-8");
              messages.push(`${workspaceName(wsCwd)}: ensured skills/.ignore`);
            }
            // Register to workspace's .pi/settings.json skills[]
            const wsSettingsPath = join(wsCwd, ".pi", "settings.json");
            const wsSettings = readJson(wsSettingsPath);
            let wsSkills: string[] = wsSettings.skills || [];
            const wsDisabled: string[] = wsSettings._disabledPackages || [];
            const wNorm = (p: string) => p.replace(/\\/g, "/");
            let added = 0;
            for (const rel of skillRels) {
              const skillRef = `skills/${rel}`; // relative to cwd/.pi
              if (wsSkills.some(p => wNorm(p) === skillRef)) continue;
              if (wsDisabled.some(d => wNorm(d) === skillRef)) continue;
              wsSkills.push(skillRef);
              added++;
            }
            if (added > 0) {
              wsSettings.skills = wsSkills;
              writeJson(wsSettingsPath, wsSettings);
              messages.push(`${workspaceName(wsCwd)}: registered ${added} skill(s)`);
            }
          }
        }
      }

      // ── Workspace packages (extensions/themes/prompts): register to packages[] ──
      for (const resType of ["extensions", "themes", "prompts"]) {
        const wsResDir = join(wsCwd, ".pi", resType);
        if (!existsSync(wsResDir)) continue;

        let resFiles: string[] = [];
        try {
          resFiles = readdirSync(wsResDir).filter(f => {
            if (f.startsWith(".") || f === ".ignore" || f === ".gitignore") return false;
            const full = join(wsResDir, f);
            if (resType === "extensions") {
              if (f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js")) return true;
              if (statSync(full).isDirectory())
                return existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"));
            } else if (resType === "themes") {
              return f.endsWith(".js") || f.endsWith(".ts") || statSync(full).isDirectory();
            } else if (resType === "prompts") {
              return f.endsWith(".md");
            }
            return false;
          });
        } catch { continue; }
        if (resFiles.length === 0) continue;

        const ignorePath = join(wsResDir, ".ignore");
        if (!existsSync(ignorePath) || readFileSync(ignorePath, "utf-8").trim() !== "*") {
          writeFileSync(ignorePath, "*\n", "utf-8");
          messages.push(`${workspaceName(wsCwd)}: ensured ${resType}/.ignore`);
        }

        const wsSettingsPath = join(wsCwd, ".pi", "settings.json");
        const wsSettings = readJson(wsSettingsPath);
        let wsPkgs: string[] = wsSettings.packages || [];
        const wsDisabled: string[] = wsSettings._disabledPackages || [];
        const wNorm = (p: string) => p.replace(/\\/g, "/");
        let added = 0;
        for (const res of resFiles) {
          const pkgRef = join(wsCwd, ".pi", resType, res).replace(/\\/g, "/");
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
    // Skills → skills[] (recursive discovery, relative paths)
    // Extensions/themes → packages[] (existing behavior)
    // .ignore blocks pi's auto-discover so only explicit registration loads.

    // ── Global skills ──
    {
      const globalSkillsDir = join(PI_AGENT, "skills");
      if (existsSync(globalSkillsDir)) {
        const skillRels = findSkillDirs(globalSkillsDir);
        if (skillRels.length > 0) {
          const globalSettingsPath = join(PI_AGENT, "settings.json");
          const gs = readJson(globalSettingsPath);
          let gSkills: string[] = gs.skills || [];
          const gDisabled: string[] = gs._disabledPackages || [];
          const normalize = (p: string) => p.replace(/\\/g, "/");
          const isDisabled = (ref: string) => gDisabled.some(d => normalize(d) === normalize(ref));
          const isInGlobalSkills = (ref: string) => gSkills.some(p => normalize(p) === normalize(ref));
          // Check if registered as a workspace skill — don't override user's scope choice
          const isInAnyWorkspaceSkills = (skillRef: string) => {
            for (const dir of listSessionDirs()) {
              const wsCwd = sessionDirToCwd(dir);
              const wsSettings = readJson(join(wsCwd, ".pi", "settings.json"));
              const wsSkills: string[] = wsSettings.skills || [];
              if (wsSkills.some(p => normalize(p) === normalize(skillRef))) return true;
            }
            const projSettings2 = readJson(join(cwd, ".pi", "settings.json"));
            const projSkills2: string[] = projSettings2.skills || [];
            if (projSkills2.some(p => normalize(p) === normalize(skillRef))) return true;
            return false;
          };
          let added = 0;
          for (const rel of skillRels) {
            const skillRef = `skills/${rel}`; // relative to agentDir
            if (isDisabled(skillRef)) continue;
            if (isInGlobalSkills(skillRef)) continue;
            if (isInAnyWorkspaceSkills(skillRef)) continue;
            gSkills.push(skillRef);
            added++;
          }
          if (added > 0) {
            gs.skills = gSkills;
            writeJson(globalSettingsPath, gs);
            messages.push(`Global: registered ${added} skill(s)`);
          }
        }
        // Create/fix .ignore AFTER registration to kill pi's auto-discover
        const ignorePath = join(globalSkillsDir, ".ignore");
        if (!existsSync(ignorePath) || readFileSync(ignorePath, "utf-8").trim() !== "*") {
          writeFileSync(ignorePath, "*\n", "utf-8");
          messages.push(`Global: ensured skills/.ignore`);
        }
      }
    }

    // ── Global extensions/themes → packages[] ──
    for (const resType of ["extensions", "themes"]) {
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
      const isInGlobalPkgs = (ref: string) => gPkgs.some(p => normalize(p) === normalize(ref));
      const isInAnyWorkspace = (pkgRef: string) => {
        for (const dir of listSessionDirs()) {
          const wsCwd = sessionDirToCwd(dir);
          const wsSettings = readJson(join(wsCwd, ".pi", "settings.json"));
          const wsPkgs: string[] = wsSettings.packages || [];
          if (wsPkgs.some(p => normalize(p).endsWith("/" + pkgRef.split("/").pop()))) return true;
        }
        const projSettings2 = readJson(join(cwd, ".pi", "settings.json"));
        const projPkgs2: string[] = projSettings2.packages || [];
        if (projPkgs2.some(p => normalize(p).endsWith("/" + pkgRef.split("/").pop()))) return true;
        return false;
      };
      let added = 0;
      for (const res of resFiles) {
        const pkgRef = `${resType}/${res}`;
        if (isDisabled(pkgRef)) continue;
        if (isInGlobalPkgs(pkgRef)) continue;
        if (isInAnyWorkspace(pkgRef)) continue;
        gPkgs.push(pkgRef);
        added++;
      }
      if (added > 0) {
        gs.packages = gPkgs;
        writeJson(globalSettingsPath, gs);
        messages.push(`Global: registered ${added} ${resType}(s)`);
      }

      const ignorePath = join(globalResDir, ".ignore");
      if (!existsSync(ignorePath) || readFileSync(ignorePath, "utf-8").trim() !== "*") {
        writeFileSync(ignorePath, "*\n", "utf-8");
        messages.push(`Global: ensured ${resType}/.ignore`);
      }
    }

    if (messages.length > 0) {
      ctx.ui.notify(messages.join("\n"), "info");
    }
  });

  // ═══════════════════════════════════════════════════════════
  /* DISABLED: pi now has built-in cross-workspace session support
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
  */

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
              const typeTag = r.type === "skill" ? theme.fg("accent", "S") : theme.fg("dim", "P");
              const nameMax = Math.max(10, currentWidth - 4 - 22);
              const prefix = r.installed ? "       " : theme.fg("warning", "[MISS] ");
              const nameRaw = r.name;
              const nameStr = nameRaw.length > nameMax ? nameRaw.slice(0, nameMax - 1) + "…" : nameRaw.padEnd(nameMax);
              const stateStr = theme.fg(STATE_COLORS[st], STATE_LABELS[st]);
              lines.push(` ${cursor} ${mark} ${prefix}${typeTag} ${nameStr}${stateStr}`);
            }

            if (resources.length > maxVisible) {
              lines.push(theme.fg("dim", `  ${scrollStart + 1}-${scrollEnd} of ${resources.length}`));
            }
          }
          listText.setText(lines.join("\n"));

          helpText.setText(theme.fg("dim", " S=skill P=pkg | ↑↓ move  1:Global 2:Workspace 3:Remove  Enter:save  Esc:cancel"));
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
  // 3. WORKSPACE MANAGER SETTINGS UI
  // ═══════════════════════════════════════════════════════════

  pi.registerCommand("wm-settings", {
    description: "Manage pi_reload, pi_compact, and forced auto-compaction recovery",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/wm-settings requires TUI mode", "error");
        return;
      }

      const chooseSection = async (): Promise<string | null> => {
        const retrySummary = managerConfig.compact.retryOnFailure
          ? `${managerConfig.compact.maxRetries} retries / ${managerConfig.compact.retryDelayMs}ms`
          : "retry off";
        const items: SelectItem[] = [
          {
            value: "reload",
            label: "Reload tool",
            description: managerConfig.reload.enabled ? "pi_reload enabled" : "pi_reload disabled",
          },
          {
            value: "compact",
            label: "Compact tool",
            description: `${managerConfig.compact.enabled ? "enabled" : "disabled"} · threshold >${managerConfig.compact.thresholdPercent}% · ${retrySummary}`,
          },
          {
            value: "forced-auto-compact",
            label: "Forced auto-compact recovery",
            description: managerConfig.compact.resumeAfterForcedAutoCompact
              ? "enabled · overflow or measured context ≥100%"
              : "disabled",
          },
          { value: "done", label: "Done", description: "Close workspace manager settings" },
        ];

        return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(" Workspace Manager Settings")), 1, 0));
          const list = new SelectList(items, items.length + 1, {
            selectedPrefix: (s) => theme.fg("accent", s),
            selectedText: (s) => theme.fg("accent", s),
            description: (s) => theme.fg("muted", s),
            scrollInfo: (s) => theme.fg("dim", s),
          });
          list.onSelect = (item) => done(item.value);
          list.onCancel = () => done(null);
          container.addChild(list);
          container.addChild(new Text(theme.fg("dim", " ↑↓ navigate · enter open · esc close"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data) => { list.handleInput(data); tui.requestRender(); },
          };
        });
      };

      const showSettings = async (
        title: string,
        items: SettingItem[],
        onChange: (id: string, value: string) => void,
      ): Promise<void> => {
        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 1, 0));
          const list = new SettingsList(
            items,
            Math.min(items.length + 2, 12),
            getSettingsListTheme(),
            (id, value) => {
              onChange(id, value);
              persistManagerConfig();
              ctx.ui.notify(`${title}: ${id} = ${value}`, "info");
              tui.requestRender();
            },
            () => done(undefined),
          );
          container.addChild(list);
          container.addChild(new Text(theme.fg("dim", " ↑↓ select · enter/space change · esc back"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data) => { list.handleInput?.(data); tui.requestRender(); },
          };
        });
      };

      while (true) {
        const section = await chooseSection();
        if (!section || section === "done") return;

        if (section === "reload") {
          await showSettings(
            "Reload Tool Settings",
            [{
              id: "enabled",
              label: "Model-callable pi_reload",
              currentValue: managerConfig.reload.enabled ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            }],
            (_id, value) => {
              managerConfig.reload.enabled = value === "enabled";
            },
          );
          continue;
        }

        if (section === "forced-auto-compact") {
          await showSettings(
            "Forced Auto-Compact Recovery",
            [{
              id: "resumeAfterForcedAutoCompact",
              label: "Append continuation after overflow / ≥100% auto-compact",
              currentValue: managerConfig.compact.resumeAfterForcedAutoCompact ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            }],
            (_id, value) => {
              managerConfig.compact.resumeAfterForcedAutoCompact = value === "enabled";
            },
          );
          continue;
        }

        const thresholdValues = Array.from({ length: 50 }, (_, i) => `${i + 50}%`);
        const retryDelayValues = [...new Set([
          250, 500, 1000, 2000, 3000, 5000, 10000, 30000,
          managerConfig.compact.retryDelayMs,
        ])].sort((a, b) => a - b).map(String);
        await showSettings(
          "Compact Tool Settings",
          [
            {
              id: "enabled",
              label: "Model-callable pi_compact",
              currentValue: managerConfig.compact.enabled ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            },
            {
              id: "thresholdPercent",
              label: "Compact when context exceeds",
              currentValue: `${managerConfig.compact.thresholdPercent}%`,
              values: thresholdValues,
            },
            {
              id: "retryOnFailure",
              label: "Retry transient failures",
              currentValue: managerConfig.compact.retryOnFailure ? "enabled" : "disabled",
              values: ["enabled", "disabled"],
            },
            {
              id: "maxRetries",
              label: "Maximum retries after first attempt",
              currentValue: String(managerConfig.compact.maxRetries),
              values: Array.from({ length: 11 }, (_, i) => String(i)),
            },
            {
              id: "retryDelayMs",
              label: "Retry delay (milliseconds)",
              currentValue: String(managerConfig.compact.retryDelayMs),
              values: retryDelayValues,
            },
          ],
          (id, value) => {
            if (id === "enabled") managerConfig.compact.enabled = value === "enabled";
            else if (id === "thresholdPercent") managerConfig.compact.thresholdPercent = Number.parseInt(value, 10);
            else if (id === "retryOnFailure") managerConfig.compact.retryOnFailure = value === "enabled";
            else if (id === "maxRetries") managerConfig.compact.maxRetries = Number.parseInt(value, 10);
            else if (id === "retryDelayMs") managerConfig.compact.retryDelayMs = Number.parseInt(value, 10);
          },
        );
      }
    },
  });

  // ═══════════════════════════════════════════════════════════
  // 4. WORKSPACE SESSION TOOL
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
  /* DISABLED: pi now has built-in cross-workspace session support
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
  */

  // ═══════════════════════════════════════════════════════════
  // 5. Reload command + recovery
  // ═══════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════
  // 5. Reload recovery
  // ═══════════════════════════════════════════════════════════

  // Flag file: pi_reload tool writes it before triggering restart
  const resumeFlagPath = join(homedir(), ".pi", "agent", ".pi-wm-resume");

  // After restart: if flag exists, send resume message to continue conversation
  pi.on("session_start", async (_event, _ctx) => {
    if (!fs.existsSync(resumeFlagPath)) return;
    let data: { message: string };
    try {
      data = JSON.parse(fs.readFileSync(resumeFlagPath, "utf-8"));
    } catch {
      data = { message: fs.readFileSync(resumeFlagPath, "utf-8") };
    }
    fs.unlinkSync(resumeFlagPath);
    const trySend = async () => {
      try { await pi.sendUserMessage(data.message); } catch { setTimeout(trySend, 1000); }
    };
    setTimeout(trySend, 3000);
  });

  // ═══════════════════════════════════════════════════════════
  // 6. Tools — pi_compact, pi_update, and pi_reload
  // ═══════════════════════════════════════════════════════════

  // Model-triggered compaction is deliberately guarded. The model may decide
  // whether its task is unfinished, but the extension independently enforces
  // the configured context threshold before allowing compaction.
  pi.registerTool({
    name: "pi_compact",
    label: "Pi Compact",
    description: "Compact older conversation history so an unfinished task can continue. Use only when the current task is not finished AND context usage is strictly above the configured threshold (default 95%). The tool checks its enabled state and threshold, optionally retries transient failures, and automatically resumes the task after success.",
    promptSnippet: "Compact history only when an unfinished task must continue and context usage exceeds the configured threshold",
    promptGuidelines: [
      "Use pi_compact only when the current task is still unfinished and context usage is strictly above its configured threshold (default 95%); never use pi_compact for routine cleanup or after the task is complete.",
      "When pi_compact is necessary, describe the remaining work precisely in unfinishedTask so compaction preserves it and the automatic continuation message resumes the correct work.",
    ],
    parameters: Type.Object({
      unfinishedTask: Type.String({
        minLength: 1,
        description: "Concise description of the unfinished task, current progress, and immediate next step to resume after compaction.",
      }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const compactConfig = { ...managerConfig.compact };
      if (!compactConfig.enabled) {
        return {
          content: [{ type: "text", text: "Compaction refused: pi_compact is disabled in /wm-settings." }],
          details: { status: "disabled" },
        };
      }

      if (compactInProgress) {
        return {
          content: [{ type: "text", text: "Compaction is already in progress. Do not request another one." }],
          details: { status: "already-in-progress" },
          terminate: true,
        };
      }

      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null || usage.tokens === null) {
        return {
          content: [{ type: "text", text: `Compaction refused: current context usage is unavailable. Continue without compacting unless a later call reports usage above the configured ${compactConfig.thresholdPercent}% threshold.` }],
          details: { status: "refused", reason: "usage-unavailable", thresholdPercent: compactConfig.thresholdPercent },
        };
      }

      if (usage.percent <= compactConfig.thresholdPercent) {
        return {
          content: [{
            type: "text",
            text: `Compaction refused: context usage is ${usage.percent.toFixed(1)}%, which has not exceeded the configured ${compactConfig.thresholdPercent}% threshold. Continue the task without compacting.`,
          }],
          details: {
            status: "refused",
            reason: "below-threshold",
            tokens: usage.tokens,
            contextWindow: usage.contextWindow,
            percent: usage.percent,
            thresholdPercent: compactConfig.thresholdPercent,
          },
        };
      }

      const unfinishedTask = params.unfinishedTask.trim();
      if (!unfinishedTask) {
        return {
          content: [{ type: "text", text: "Compaction refused: unfinishedTask must describe the work that remains." }],
          details: { status: "refused", reason: "missing-unfinished-task" },
        };
      }

      compactInProgress = true;
      pendingCompactRequest = {
        unfinishedTask,
        config: compactConfig,
        compactionObserved: false,
        manualStarted: false,
      };
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Context at ${usage.percent.toFixed(1)}%. Waiting for pi's automatic compaction before using the manual fallback...`,
          "warning",
        );
      }

      return {
        content: [{
          type: "text",
          text: `Context usage is ${usage.percent.toFixed(1)}%. Compaction has been queued. Pi's automatic compaction gets priority; a manual fallback runs only if no automatic compaction occurs. The task will resume automatically afterward.`,
        }],
        details: {
          status: "queued",
          tokens: usage.tokens,
          contextWindow: usage.contextWindow,
          percent: usage.percent,
          thresholdPercent: compactConfig.thresholdPercent,
          retryOnFailure: compactConfig.retryOnFailure,
          maxRetries: compactConfig.maxRetries,
          retryDelayMs: compactConfig.retryDelayMs,
          unfinishedTask,
        },
        terminate: true,
      };
    },
    renderCall(args, theme) {
      const rawTask = args.unfinishedTask ?? "";
      const task = rawTask.length > 60 ? `${rawTask.slice(0, 59)}…` : rawTask;
      return new Text(theme.fg("toolTitle", theme.bold("pi_compact ")) + theme.fg("dim", task || "preparing..."), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Checking context..."), 0, 0);
      const status = (result.details as { status?: string } | undefined)?.status;
      if (status === "queued") return new Text(theme.fg("success", "✓ Compaction queued"), 0, 0);
      if (status === "already-in-progress") return new Text(theme.fg("warning", "Compaction already running"), 0, 0);
      return new Text(theme.fg("warning", "Compaction not needed"), 0, 0);
    },
  });

  pi.registerTool({
    name: "pi_update",
    label: "Pi Update",
    description: "Update pi and all installed packages to the latest version (--all). Downloads and installs updates. Run pi_reload after to apply.",
    promptSnippet: "Update pi and all packages to latest",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const child = spawn("pi", ["update", "--all"], { stdio: ["ignore", "pipe", "pipe"], shell: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      await new Promise<void>((resolve) => { child.on("close", () => resolve()); });
      if (child.exitCode !== 0) {
        return { content: [{ type: "text", text: "Update failed: " + (stderr.trim() || stdout.trim()) }], isError: true };
      }
      const lastLine = stdout.trim().split("\n").pop() || "Done";
      return { content: [{ type: "text", text: "Update complete: " + lastLine + "\nUse pi_reload to apply." }] };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("pi_update ")) + theme.fg("dim", "updating..."), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Updating..."), 0, 0);
      if (result.isError) return new Text(theme.fg("error", "Failed"), 0, 0);
      return new Text(theme.fg("success", "\u2713 Updated"), 0, 0);
    },
  });

  pi.registerTool({
    name: "pi_reload",
    label: "Pi Reload",
    description: "Restart pi to reload extensions, skills, themes, and config. Conversation is automatically resumed after restart.",
    promptSnippet: "Reload pi to apply changes",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!managerConfig.reload.enabled) {
        return {
          content: [{ type: "text", text: "Reload refused: pi_reload is disabled in /wm-settings." }],
          details: { status: "disabled" },
        };
      }

      const sessionFile = ctx.sessionManager.sessionFile;
      const cwd = ctx.cwd;
      fs.writeFileSync(resumeFlagPath, JSON.stringify({
        message: "pi_reload completed. Continuing from where we left off.",
        cwd,
        session: sessionFile,
      }), "utf-8");
      launchTerminalDetached(cwd, sessionFile);
      process.exit(0);
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("pi_reload ")) + theme.fg("dim", "restarting..."), 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Restarting..."), 0, 0);
      const status = (result.details as { status?: string } | undefined)?.status;
      if (status === "disabled") return new Text(theme.fg("warning", "Reload disabled"), 0, 0);
      return new Text(theme.fg("success", "\u2713 Restarted"), 0, 0);
    },
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    if (compactRetryTimer) clearTimeout(compactRetryTimer);
    compactRetryTimer = undefined;
    pendingCompactRequest = undefined;
    forcedAutoCompactResume = undefined;
    compactInProgress = false;
  });

  // Keep /update command as well (non-tool fallback)
  pi.registerCommand("update", {
    description: "Update pi and all installed packages (--all)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Starting pi update (--all)...", "info");
      const child = spawn("pi", ["update", "--all"], { stdio: ["ignore", "pipe", "pipe"], shell: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        const last = d.toString().trim().split("\n").pop() || "";
        if (last) ctx.ui.notify("Updating: " + last, "info");
      });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      await new Promise<void>((resolve) => { child.on("close", () => resolve()); });
      if (child.exitCode === 0) {
        const lastLine = stdout.trim().split("\n").pop() || "Done";
        ctx.ui.notify("Update complete: " + lastLine + "\nRun /reload to apply.", "success");
      } else {
        ctx.ui.notify("Update failed: " + (stderr.trim() || stdout.trim()), "error");
      }
    },
  });
}
