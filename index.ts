/**
 * pi-workspace-manager
 *
 * 1. Cross-workspace session browsing & launching via Alacritty
 * 2. Unified plugin management panel with custom TUI (/plugins)
 * 3. Startup validation — auto-remove invalid local-dev plugins
 * 4. Guarded model-triggered context compaction with automatic task continuation
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Container, Input, type SelectItem, SelectList,
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
import { canonicalGitIdentity, canonicalPluginIdentity } from "./plugin-identity.ts";
// The marker is bookkeeping only: it is hidden and never sent to the model.
export const RECOVERY_MARKER = "pi-workspace-manager:empty-enter-recovery";
const COMPACTION_RESUME_TYPE = "pi-workspace-manager:compaction-resume";

export function shouldResumeOnEnter({ enter, text, idle, autocomplete }: {
  enter: boolean; text: string; idle: boolean; autocomplete: boolean;
}): boolean {
  return enter && !text.trim() && idle && !autocomplete;
}

export function hasUnfinishedTurn(entries: readonly any[]): boolean {
  if (!entries.some((entry) => entry.type === "message" && entry.message?.role === "user")) return false;
  const last = [...entries].reverse().find((entry) =>
    entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message?.role));
  if (!last) return false;
  if (last.message.role === "assistant") return last.message.stopReason !== "stop";
  return last.message.role === "user" || last.message.role === "toolResult";
}

export function isRecoveryMarker(message: any): boolean {
  return message?.role === "custom" && message.customType === RECOVERY_MARKER;
}

export function withoutRecoveryMarkers(messages: readonly any[]): readonly any[] {
  if (!messages.some(isRecoveryMarker)) return messages;
  const filtered = messages.filter((message) => !isRecoveryMarker(message));
  // Only on a recovery request: the failed assistant tail remains visible in
  // the saved session, but must not become extra context for the next request.
  while (filtered.length > 1 && filtered.at(-1)?.role === "assistant" &&
         filtered.at(-1)?.stopReason !== "stop") {
    filtered.pop();
  }
  return filtered;
}

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
  };
  codexRetry: {
    enabled: boolean;
    maxRetries: number;
  };
}

interface PendingCompactRequest {
  unfinishedTask: string;
  config: WorkspaceManagerConfig["compact"];
  sessionId: string;
  generation: number;
  userSubmitted: boolean;
}

interface ReloadRecoveryMarker {
  session: string;
  sessionId?: string;
  createdAt?: number;
}

const DEFAULT_MANAGER_CONFIG: WorkspaceManagerConfig = {
  reload: { enabled: true },
  compact: {
    enabled: true,
    thresholdPercent: 95,
    retryOnFailure: true,
    maxRetries: 2,
    retryDelayMs: 2000,
  },
  // Promote Codex assistant errors to Pi's native retry path. After three
  // matching image-request failures, retry once with image-free model context.
  codexRetry: {
    enabled: true,
    maxRetries: 3,
  }
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

// Flex is not accepted by every Gemini API model. Keep this allowlist aligned
// with Google's published Flex-supported model families so unsupported models
// continue using the normal request shape instead of receiving a 400 error.
function supportsGoogleFlex(model: { id?: string; provider?: string; api?: string } | undefined): boolean {
  if (model?.provider !== "google" || model.api !== "google-generative-ai") return false;
  const id = String(model.id || "").toLowerCase().replace(/^models\//, "");
  return /^(?:gemini-3\.(?:8|7|6)-flash(?:[-.].*)?|gemini-3\.5-(?:flash|flash-lite)(?:[-.].*)?|gemini-3\.1-(?:pro|flash-lite)(?:[-.].*)?|gemini-3-(?:flash|pro-image)(?:[-.].*)?|gemini-2\.5-(?:pro|flash|flash-lite)(?:[-.].*)?)$/.test(id);
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
    },
    codexRetry: {
      enabled: typeof raw.codexRetry?.enabled === "boolean"
        ? raw.codexRetry.enabled
        : DEFAULT_MANAGER_CONFIG.codexRetry.enabled,
      maxRetries: boundedInteger(
        raw.codexRetry?.maxRetries,
        DEFAULT_MANAGER_CONFIG.codexRetry.maxRetries,
        0,
        10,
      ),
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

function isImageBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  if (block.type === "image") return true;
  if (block.type === "input_image") return true;
  return block.type === "image_url" || typeof block.image_url === "string";
}

function countImageBlocks(value: unknown, seen = new Set<object>()): number {
  if (!value || typeof value !== "object") return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (isImageBlock(value)) return 1;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countImageBlocks(item, seen), 0);
  return Object.values(value).reduce((total, item) => total + countImageBlocks(item, seen), 0);
}

function stripImageBlocks(messages: readonly any[]): { messages: any[]; removed: number } {
  let removed = 0;
  const result = messages.map((message) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) return message;
    const content = message.content.map((part: unknown) => {
      if (!isImageBlock(part)) return part;
      removed++;
      return {
        type: "text",
        text: "[Image omitted after repeated Codex request failures; use the available text context.]",
      };
    });
    return { ...message, content };
  });
  return { messages: result, removed };
}

function makeCodexErrorRetryable(errorText: string): string {
  // Pi's retry classifier checks these explicit account/quota exclusions before
  // its positive retry patterns. Break only those exact phrases with invisible
  // separators so the original diagnostic remains readable while the system
  // retry classifier can handle the error as requested.
  const nonRetryableLimitError = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/gi;
  const retryableText = errorText.replace(nonRetryableLimitError, (match) => [...match].join("\u200B"));
  return `${retryableText}\n[pi-workspace-manager: retryable Codex server error]`;
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
  id: string;       // Representative settings reference for this resource
  identity: string; // Stable identity shared by package refs and local checkout aliases
  aliases: string[]; // Alternate refs/source variants for the same plugin
  name: string;     // display name
  installed: boolean;
  state: ResourceState;
  type: "skill" | "package";  // skill → skills[] array, package → packages[] array
}

function localRepositoryIdentity(ref: string, cwd: string): string | undefined {
  if (/^(?:git|github|npm):/i.test(ref)) return undefined;
  const candidates = /^[A-Za-z]:\//.test(ref) || ref.startsWith("/")
    ? [ref]
    : [resolve(PI_AGENT, ref), resolve(cwd, ref)];
  for (const candidate of candidates) {
    const directory = existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : dirname(candidate);
    const packageJson = readJson(join(directory, "package.json"));
    const repository = typeof packageJson.repository === "string"
      ? packageJson.repository
      : packageJson.repository?.url;
    const fromPackage = typeof repository === "string" ? canonicalGitIdentity(repository) : undefined;
    if (fromPackage) return fromPackage;

    try {
      const gitConfig = readFileSync(join(directory, ".git", "config"), "utf8");
      const origin = gitConfig.match(/\[remote "origin"\][\s\S]*?\burl\s*=\s*([^\r\n]+)/i)?.[1]?.trim();
      const fromGit = origin ? canonicalGitIdentity(origin) : undefined;
      if (fromGit) return fromGit;
    } catch { /* Not a local git checkout. */ }
  }
  return undefined;
}

function packageIdentity(ref: string, name: string, cwd: string): string {
  return canonicalPluginIdentity(ref, name, localRepositoryIdentity(ref, cwd));
}

const PACKAGE_OVERRIDE_FIELDS = ["extensions", "themes", "prompts"] as const;

function resolvePackageRef(ref: string, base: string): string {
  const normalized = ref.replace(/\\/g, "/");
  if (/^(?:git|github|npm):/i.test(normalized) || normalized.includes(":") || normalized.startsWith("/")) return normalized;
  return resolve(base, normalized).replace(/\\/g, "/");
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
  const overrideFields = PACKAGE_OVERRIDE_FIELDS;
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

  // Keep at most one settings reference per plugin in the global/current pair.
  // Global wins; workspaces other than cwd are intentionally not normalized here.
  const registrationFields = ["packages", ...overrideFields, "_disabledPackages"];
  const normalizeScopeRegistrations = (settings: any, base: string, reserved = new Set<string>()) => {
    const identities = new Set(reserved);
    let changed = false;
    for (const field of registrationFields) {
      const entries = settings[field];
      if (!Array.isArray(entries)) continue;
      const isOverride = (overrideFields as readonly string[]).includes(field);
      const filtered = entries.filter((entry: string) => {
        const resolved = isOverride ? resolveRel(entry, base) : resolvePackageRef(entry, base);
        const name = resolved.split("/").pop() || resolved;
        const identity = packageIdentity(resolved, name, cwd);
        if (identities.has(identity)) {
          changed = true;
          return false;
        }
        identities.add(identity);
        return true;
      });
      if (filtered.length !== entries.length) settings[field] = filtered;
    }
    return { identities, changed };
  };
  const globalNormalization = normalizeScopeRegistrations(globalSettings, PI_AGENT);
  const workspaceNormalization = normalizeScopeRegistrations(projSettings, cwd, globalNormalization.identities);
  if (globalNormalization.changed) writeJson(join(PI_AGENT, "settings.json"), globalSettings);
  if (workspaceNormalization.changed) {
    const projPath = join(cwd, ".pi", "settings.json");
    const isSystemDir = /^(?:[A-Z]:\\(?:Windows|Program Files|Program Files \(x86\)))\b/i.test(cwd);
    if (!isSystemDir) writeJson(projPath, projSettings);
  }

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

  const getPkgState = (aliases: string[]): ResourceState => {
    const refs = new Set(aliases.map(normalize));
    if (globalActiveRefs.some(p => refs.has(normalize(p)))) return "global";
    if (projActiveRefs.some(p => refs.has(normalize(p)))) return "workspace";
    return "removed";
  };

  const resourcesByIdentity = new Map<string, ManagedResource>();
  const add = (id: string, name: string, type: "skill" | "package", installed = true) => {
    const nid = normalize(id);
    const identity = type === "skill" ? `skill:${nid}` : packageIdentity(nid, name, cwd);
    let resource = resourcesByIdentity.get(identity);
    if (!resource) {
      resource = { id: nid, identity, aliases: [], name: name.replace(/@[^@/]+$/, ""), installed, state: "removed", type };
      resourcesByIdentity.set(identity, resource);
    }
    if (!resource.aliases.includes(nid)) resource.aliases.push(nid);
    resource.installed ||= installed;
    if (type === "skill") resource.state = getSkillState(nid);
    else resource.state = getPkgState(resource.aliases);
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
        let valid = false;
        if (resType === "extensions") {
          valid = f.endsWith(".ts") || f.endsWith(".mjs") || f.endsWith(".js") ||
            (statSync(full).isDirectory() && (existsSync(join(full, "index.ts")) || existsSync(join(full, "index.js"))));
        } else {
          valid = f.endsWith(".js") || f.endsWith(".ts") || f.endsWith(".md") || statSync(full).isDirectory();
        }
        if (valid) add(absPath, f, "package");
      }
    } catch { /* */ }
  }

  // Add remaining from settings that weren't physically found (packages channel only)
  const allRegisteredIds = new Set([...globalAllRefs, ...projAllRefs, ...allWorkspaceRefs]);
  for (const rawId of allRegisteredIds) {
    const id = normalize(rawId);
    add(id, id.split("/").pop() || id, "package",
      existsSync(id) || rawId.startsWith("git:") || rawId.startsWith("npm:"));
  }
  // Add skill refs from settings not physically found
  for (const rawId of [...globalActiveSkills, ...projActiveSkills, ...allWsSkillRefs]) {
    const id = normalize(rawId);
    add(id, id.split("/").pop() || id, "skill", existsSync(resolve(PI_AGENT, id)));
  }

  return [...resourcesByIdentity.values()].sort((a, b) => a.name.localeCompare(b.name));
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

  for (const [id, newState] of changes) {
    const resource = resources.find(r => normalize(r.id) === normalize(id) || r.aliases.some(alias => matchRef(alias, id)));
    const refs = resource?.aliases ?? [id];
    const originalState = resource?.state ?? "removed";
    const isSkill = resource?.type === "skill";
    const matchesResource = (ref: string, base: string) => {
      if (refs.some(alias => matchRef(ref, alias))) return true;
      if (!resource || isSkill) return false;
      const resolved = resolvePackageRef(ref, base);
      const name = resolved.split("/").pop() || resolved;
      return packageIdentity(resolved, name, cwd) === resource.identity;
    };
    const matchesGlobal = (ref: string) => matchesResource(ref, PI_AGENT);
    const matchesProj = (ref: string) => matchesResource(ref, cwd);

    // Apply each state transition to every known source alias in the global/current-workspace pair.
    const removeFromGlobal = () => {
      if (isSkill) globalSkills = globalSkills.filter(p => !matchesGlobal(p));
      else globalPkgs = globalPkgs.filter(p => !matchesGlobal(p));
      globalDisabled = globalDisabled.filter(p => !matchesGlobal(p));
      for (const field of PACKAGE_OVERRIDE_FIELDS) {
        if (Array.isArray(globalSettings[field])) {
          globalSettings[field] = globalSettings[field].filter((p: string) => !matchesGlobal(p));
        }
      }
    };
    const removeFromProj = () => {
      if (isSkill) projSkills = projSkills.filter(p => !matchesProj(p));
      else projPkgs = projPkgs.filter(p => !matchesProj(p));
      projDisabled = projDisabled.filter(p => !matchesProj(p));
      for (const field of PACKAGE_OVERRIDE_FIELDS) {
        if (Array.isArray(projSettings[field])) {
          projSettings[field] = projSettings[field].filter((p: string) => !matchesProj(p));
        }
      }
    };
    const addDisabledRecord = (target: string[]) => {
      if (!target.some(existing => matchRef(existing, id))) target.push(id);
    };

    if (newState === "global") {
      // Global and the current workspace are mutually exclusive; other workspaces are independent.
      removeFromGlobal();
      removeFromProj();
      if (isSkill) globalSkills.push(id);
      else globalPkgs.push(id);

    } else if (newState === "workspace") {
      // Remove from global and current workspace only (don't touch other workspaces)
      removeFromGlobal();
      removeFromProj();
      if (isSkill) projSkills.push(id);
      else projPkgs.push(id);

    } else {
      // Remove any registration in the global/current-workspace pair, then keep one disabled record.
      const globalRegistrations = [...globalPkgs, ...globalSkills, ...globalDisabled,
        ...PACKAGE_OVERRIDE_FIELDS.flatMap(field => globalSettings[field] || [])];
      const workspaceRegistrations = [...projPkgs, ...projSkills, ...projDisabled,
        ...PACKAGE_OVERRIDE_FIELDS.flatMap(field => projSettings[field] || [])];
      const hasGlobalRegistration = globalRegistrations.some(matchesGlobal);
      const hasWorkspaceRegistration = workspaceRegistrations.some(matchesProj);
      if (!hasGlobalRegistration && !hasWorkspaceRegistration) continue;
      removeFromGlobal();
      removeFromProj();
      if (!isSkill) {
        const disabledTarget = originalState === "workspace" || (!hasGlobalRegistration && hasWorkspaceRegistration)
          ? projDisabled
          : globalDisabled;
        addDisabledRecord(disabledTarget);
      }
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

}

// ─── Plugin Manager TUI ─────────────────────────────────────

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
  let compactRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let compactResumeTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionGeneration = 0;
  let userInputEpoch = 0;
  // These counters only gate promotion to Pi's native retry path and the
  // image-specific fallback. Retry scheduling, backoff, and cancellation stay
  // in Pi's system retry implementation.
  let codexRetryAttempts = 0;
  let codexImageRetryAttempts = 0;
  let stripImagesForCodexRetry = false;

  const applyManagedToolAvailability = () => {
    const active = new Set(pi.getActiveTools());
    if (managerConfig.reload.enabled) active.add("pi_reload");
    else active.delete("pi_reload");
    if (managerConfig.compact.enabled) active.add("pi_compact");
    else active.delete("pi_compact");
    // Codemode is an opt-in built-in tool in Pi; keep it available whenever
    // workspace-manager is loaded so scripts can orchestrate other tools.
    active.add("codemode");
    pi.setActiveTools([...active]);
  };

  const persistManagerConfig = () => {
    saveManagerConfig(managerConfig);
    applyManagedToolAvailability();
  };

  const clearPendingCompaction = (request: PendingCompactRequest): boolean => {
    if (pendingCompactRequest !== request) return false;
    if (compactRetryTimer) clearTimeout(compactRetryTimer);
    if (compactResumeTimer) clearTimeout(compactResumeTimer);
    compactRetryTimer = undefined;
    compactResumeTimer = undefined;
    pendingCompactRequest = undefined;
    compactInProgress = false;
    return true;
  };

  const noteUserInput = () => {
    userInputEpoch++;
    if (!pendingCompactRequest) return;
    pendingCompactRequest.userSubmitted = true;
    // Once compaction has finished, no background retry or implicit resume
    // should remain scheduled after the user has taken over the conversation.
    if (compactRetryTimer || compactResumeTimer) clearPendingCompaction(pendingCompactRequest);
  };

  const isCurrentCompaction = (request: PendingCompactRequest, ctx: ExtensionContext): boolean => {
    if (pendingCompactRequest !== request || !sessionActive || request.generation !== sessionGeneration) return false;
    try { return ctx.sessionManager.getSessionId() === request.sessionId; }
    catch { return false; } // A session switch or reload invalidates the old ctx.
  };

  const continueAfterCompaction = (request: PendingCompactRequest, ctx: ExtensionContext) => {
    if (!isCurrentCompaction(request, ctx) || compactResumeTimer) return;
    if (ctx.hasUI) ctx.ui.notify("Context compaction complete.", "info");
    // Pi emits compaction_end first. Its TUI then flushes messages typed during
    // compaction, but that queue is not exposed by ctx.hasPendingMessages().
    // Yield to the TUI and let an actual user submission take precedence.
    compactResumeTimer = setTimeout(() => {
      compactResumeTimer = undefined;
      if (!isCurrentCompaction(request, ctx)) return;
      let shouldResume = !request.userSubmitted;
      try { shouldResume &&= ctx.isIdle() && !ctx.hasPendingMessages(); }
      catch { shouldResume = false; }
      clearPendingCompaction(request);
      if (!shouldResume) return;
      // Unlike sendUserMessage(), sendMessage() starts the session run before
      // its first await. A new editor submission can then only queue, never
      // race a still-idle preflight into two simultaneous agent.prompt() calls.
      try {
        pi.sendMessage({
          customType: COMPACTION_RESUME_TYPE,
          content: `继续任务：${request.unfinishedTask}`,
          display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Failed to continue after compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }, 0);
  };

  const runManualCompaction = (request: PendingCompactRequest, ctx: ExtensionContext, attempt: number) => {
    const customInstructions = `Summarize the context needed to continue this task: ${request.unfinishedTask}`;

    ctx.compact({
      customInstructions,
      onComplete: () => continueAfterCompaction(request, ctx),
      onError: (error) => {
        if (!isCurrentCompaction(request, ctx)) return;
        // Auto-compaction can win the race. Resume only after the same idle and
        // user-input checks as an ordinary completed manual compaction.
        if (/already compacted/i.test(error.message)) {
          continueAfterCompaction(request, ctx);
          return;
        }

        const retriesUsed = attempt - 1;
        const retryable = !/(cancelled|canceled|nothing to compact)/i.test(error.message);
        const shouldRetry = !request.userSubmitted
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
            if (!isCurrentCompaction(request, ctx) || request.userSubmitted) {
              clearPendingCompaction(request);
              return;
            }
            runManualCompaction(request, ctx, attempt + 1);
          }, request.config.retryDelayMs);
          return;
        }

        if (!clearPendingCompaction(request)) return;
        if (ctx.hasUI && !request.userSubmitted) ctx.ui.notify(`Context compaction failed: ${error.message}`, "error");
      },
    });
  };

  // Google Gemini API Flex inference is a request-level setting. Apply it at
  // the final provider-payload stage for supported direct `google` API models;
  // unsupported models keep the normal request shape.
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    if (!supportsGoogleFlex(model)) return;
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;

    const payload = event.payload as Record<string, any>;
    return {
      ...payload,
      config: {
        ...(payload.config && typeof payload.config === "object" ? payload.config : {}),
        serviceTier: "flex",
      },
    };
  });

  // Give Flex requests enough server-side queue time. This hook is also
  // restricted to the direct Google API, never the Antigravity provider.
  pi.on("before_provider_headers", (event, ctx) => {
    if (supportsGoogleFlex(ctx.model)) {
      event.headers["X-Server-Timeout"] = "900";
    }
  });

  // Promote every OpenAI Codex assistant error to Pi's native retry classifier.
  // Pi still owns retry budgets, backoff, cancellation, and retry UI. Keep the
  // historical-image fallback narrower: only repeated image-request failures
  // with image-bearing context should strip images from the next outbound try.
  pi.on("agent_end", (event, ctx) => {
    const model = ctx.model;
    if (model?.provider !== "openai-codex" || !managerConfig.codexRetry.enabled) return;

    let assistant: any;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const candidate = event.messages[i];
      if (candidate?.role === "assistant") {
        assistant = candidate;
        break;
      }
    }
    if (!assistant) return;

    if (assistant.stopReason !== "error") {
      codexRetryAttempts = 0;
      codexImageRetryAttempts = 0;
      stripImagesForCodexRetry = false;
      return;
    }

    if (codexRetryAttempts >= managerConfig.codexRetry.maxRetries) return;
    codexRetryAttempts++;

    const errorText = typeof assistant.errorMessage === "string" ? assistant.errorMessage : "";
    const hasImageHistory = countImageBlocks(ctx.sessionManager.getBranch()) > 0;
    const looksLikeImageRequestFailure = hasImageHistory && (
      /bad request/i.test(errorText) ||
      /(?:1009|message\s+too\s+big|request\s+(?:body\s+)?(?:too\s+large|size)|inline.?image|image_url)/i.test(errorText)
    );
    if (looksLikeImageRequestFailure) {
      codexImageRetryAttempts++;
      // After three matching image-request failures, let the next retry use
      // an image-free model context; the persisted transcript stays untouched.
      if (codexImageRetryAttempts >= 3) stripImagesForCodexRetry = true;
    }

    const original = errorText || "Codex returned an error.";
    assistant.errorMessage = makeCodexErrorRetryable(original);
    if (ctx.hasUI) {
      const imageFallback = stripImagesForCodexRetry
        ? "; next retry will omit historical images from the outbound context"
        : "";
      ctx.ui.notify(
        `Codex error; scheduling system retry (${codexRetryAttempts}/${managerConfig.codexRetry.maxRetries})${imageFallback}.`,
        "warning",
      );
    }
  });

  // Apply the image fallback only to the next retry request. The
  // session file and the visible/persisted conversation remain unchanged.
  pi.on("context", (event, ctx) => {
    if (!stripImagesForCodexRetry || ctx.model?.provider !== "openai-codex") return;
    const sanitized = stripImageBlocks(event.messages);
    stripImagesForCodexRetry = false;
    if (sanitized.removed === 0) return;
    // Clearing the poisoned image context starts a fresh retry sequence. Do
    // not carry the previous failed sequence into the next Codex error.
    codexRetryAttempts = 0;
    codexImageRetryAttempts = 0;
    if (ctx.hasUI) {
      ctx.ui.notify(`Codex retry: omitted ${sanitized.removed} historical image(s) from the outbound context.`, "warning");
    }
    return { messages: sanitized.messages };
  });

  // Reset both retry counters after settlement so each independent run starts
  // with a fresh budget.
  pi.on("agent_settled", () => {
    codexRetryAttempts = 0;
    codexImageRetryAttempts = 0;
    stripImagesForCodexRetry = false;
  });

  // User input from RPC or from Pi's post-compaction queue also supersedes
  // the implicit continuation. TUI submissions are captured even earlier in
  // the editor, before Pi's asynchronous prompt preflight starts.
  pi.on("input", (event) => {
    if (event.source !== "extension") noteUserInput();
  });

  // The empty custom marker starts an ordinary session turn without giving
  // the model any new instructions. Remove all such markers on every request.
  pi.on("context", (event) => {
    const messages = withoutRecoveryMarkers(event.messages);
    if (messages !== event.messages) return { messages };
  });

  // Intercept only an empty Enter while idle and a turn is unfinished.
  // Typed input, autocomplete and Pi's native working display stay unchanged.
  pi.on("session_start", (_event, ctx) => {
    if (pendingCompactRequest) clearPendingCompaction(pendingCompactRequest);
    sessionActive = true;
    sessionGeneration++;
    if (ctx.mode !== "tui") return;
    const previousFactory = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      // Pi's default editor embeds the working indicator in its top border.
      // Preserve that option when wrapping the editor; otherwise Pi moves it
      // to a separate status line and changes the native working display.
      const editor = previousFactory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        const autocomplete = editor as typeof editor & { isShowingAutocomplete?: () => boolean };
        if ((keybindings.matches(data, "tui.input.submit") ||
             keybindings.matches(data, "app.message.followUp")) && editor.getText().trim() &&
            !autocomplete.isShowingAutocomplete?.()) noteUserInput();
        if (shouldResumeOnEnter({
          enter: matchesKey(data, "enter"),
          text: editor.getText(),
          idle: ctx.isIdle(),
          autocomplete: autocomplete.isShowingAutocomplete?.() ?? false,
        }) && !pendingCompactRequest && !ctx.hasPendingMessages() && hasUnfinishedTurn(ctx.sessionManager.getBranch())) {
          userInputEpoch++;
          editor.setText("");
          try {
            pi.sendMessage({ customType: RECOVERY_MARKER, content: [], display: false }, { triggerTurn: true });
          } catch (error) {
            ctx.ui.notify(`Could not resume interrupted task: ${error instanceof Error ? error.message : String(error)}`, "error");
          }
          return;
        }
        handleInput(data);
      };
      return editor;
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 0. STARTUP VALIDATION
  // ═══════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    codexRetryAttempts = 0;
    codexImageRetryAttempts = 0;
    stripImagesForCodexRetry = false;
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

      const saved = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
        const container = new Container();
        const border1 = new DynamicBorder((s: string) => theme.fg("accent", s));
        const headerText = new Text("", 1, 0);
        const searchInput = new Input();
        const searchSpacer = new Text("", 1, 0);
        const listText = new Text("", 0, 0);
        const helpText = new Text("", 1, 0);
        const border2 = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(border1);
        container.addChild(headerText);
        container.addChild(searchInput);
        container.addChild(searchSpacer);
        container.addChild(listText);
        container.addChild(helpText);
        container.addChild(border2);
        let currentWidth = 80;
        let selected = 0;
        let filtered: ManagedResource[] = [];
        const maxVisible = 14;

        const refresh = () => {
          const ws = workspaceName(cwd);
          const dirtyCount = [...changes.entries()].filter(([id, st]) => {
            const r = resources.find(r2 => r2.id === id);
            return (r?.state ?? "removed") !== st;
          }).length;
          headerText.setText(theme.fg("accent", theme.bold(` Plugins — ${ws}`)) + (dirtyCount > 0 ? theme.fg("warning", `  (${dirtyCount} changed)` ) : ""));

          const query = searchInput.getValue().trim().toLowerCase();
          filtered = resources.filter((r) =>
            !query || `${r.name} ${r.id} ${r.type}`.toLowerCase().includes(query),
          );
          selected = Math.max(0, Math.min(selected, filtered.length - 1));

          const lines: string[] = [];
          if (filtered.length === 0) {
            lines.push(theme.fg("dim", resources.length === 0 ? "  (no resources found)" : "  (no matching resources)"));
          } else {
            let scrollStart = Math.max(0, selected - Math.floor(maxVisible / 2));
            const scrollEnd = Math.min(filtered.length, scrollStart + maxVisible);
            scrollStart = Math.max(0, scrollEnd - maxVisible);

            for (let i = scrollStart; i < scrollEnd; i++) {
              const r = filtered[i];
              const state = getEffectiveState(r);
              const changed = changes.has(r.id) && state !== (r.state ?? "removed");
              const cursor = i === selected ? theme.fg("accent", "→") : " ";
              const mark = changed ? theme.fg("warning", "●") : " ";
              const typeTag = r.type === "skill" ? theme.fg("accent", "S") : theme.fg("dim", "P");
              const nameMax = Math.max(10, currentWidth - 4 - 22);
              const prefix = r.installed ? "       " : theme.fg("warning", "[MISS] ");
              const nameRaw = r.name;
              const nameStr = nameRaw.length > nameMax ? nameRaw.slice(0, nameMax - 1) + "…" : nameRaw.padEnd(nameMax);
              const stateStr = theme.fg(STATE_COLORS[state], STATE_LABELS[state]);
              lines.push(` ${cursor} ${mark} ${prefix}${typeTag} ${nameStr}${stateStr}`);
            }

            if (filtered.length > maxVisible) {
              lines.push(theme.fg("dim", `  ${scrollStart + 1}-${scrollEnd} of ${filtered.length}`));
            }
          }
          listText.setText(lines.join("\n"));
          helpText.setText(theme.fg("dim", "Type to search · ↑↓ navigate · 1/2/3 change · Enter:save · Esc:cancel"));
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
              if (selected < filtered.length - 1) selected++;
              refresh(); container.invalidate(); tui.requestRender();
            } else if (data === "1" || data === "2" || data === "3") {
              const resource = filtered[selected];
              if (resource) {
                const state: ResourceState = data === "1" ? "global" : data === "2" ? "workspace" : "removed";
                changes.set(resource.id, state);
                refresh();
                container.invalidate();
              }
              tui.requestRender();
            } else if (matchesKey(data, "enter")) {
              done(true);
            } else if (matchesKey(data, "escape")) {
              done(false);
            } else {
              searchInput.handleInput(data);
              selected = 0;
              refresh();
              container.invalidate();
              tui.requestRender();
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
          if (newState !== origState || (r?.type === "package" && r.aliases.length > 1)) {
            realChanges.set(id, newState);
          }
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
    description: "Manage pi_reload and pi_compact",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/wm-settings requires TUI mode", "error");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const createValueSubmenu = (
          title: string,
          values: string[],
          currentValue: string,
          finish: (value?: string) => void,
        ) => {
          const options: SelectItem[] = values.map((value) => ({
            value,
            label: value === currentValue ? `✓ ${value}` : value,
          }));
          const menu = new SelectList(options, Math.min(options.length, 12), {
            selectedPrefix: (s) => theme.fg("accent", s),
            selectedText: (s) => theme.fg("accent", s),
            description: (s) => theme.fg("muted", s),
            scrollInfo: (s) => theme.fg("dim", s),
            noMatch: (s) => theme.fg("warning", s),
          });
          const currentIndex = values.indexOf(currentValue);
          menu.setSelectedIndex(currentIndex >= 0 ? currentIndex : 0);
          menu.onSelect = (item) => finish(item.value);
          menu.onCancel = () => finish();

          const container = new Container();
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold(` ${title}`)), 1, 0));
          container.addChild(menu);
          container.addChild(new Text(theme.fg("dim", " ↑↓ select · enter confirm · esc back"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => {
              menu.handleInput(data);
              tui.requestRender();
            },
          };
        };

        const thresholdValues = Array.from({ length: 50 }, (_, i) => `${i + 50}%`);
        const retryValues = Array.from({ length: 11 }, (_, i) => String(i));
        const retryDelayValues = [...new Set([
          250, 500, 1000, 2000, 3000, 5000, 10000, 30000,
          managerConfig.compact.retryDelayMs,
        ])].sort((a, b) => a - b).map((ms) => `${ms} ms`);
        const items: SettingItem[] = [
          {
            id: "reload.enabled",
            label: "Reload · pi_reload tool",
            description: "Enable or disable Pi restart.",
            currentValue: managerConfig.reload.enabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "compact.enabled",
            label: "Compact · pi_compact tool",
            description: "Enable or disable context compaction.",
            currentValue: managerConfig.compact.enabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "compact.thresholdPercent",
            label: "Compact · context threshold",
            description: "Context usage threshold for compaction.",
            currentValue: `${managerConfig.compact.thresholdPercent}%`,
            submenu: (currentValue, finish) => createValueSubmenu("Context threshold", thresholdValues, currentValue, finish),
          },
          {
            id: "compact.retryOnFailure",
            label: "Compact · retry transient failures",
            description: "Retry transient manual compaction failures",
            currentValue: managerConfig.compact.retryOnFailure ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "compact.maxRetries",
            label: "Compact · maximum retries",
            description: "Additional attempts after the initial compaction attempt",
            currentValue: String(managerConfig.compact.maxRetries),
            submenu: (currentValue, finish) => createValueSubmenu("Maximum compaction retries", retryValues, currentValue, finish),
          },
          {
            id: "compact.retryDelayMs",
            label: "Compact · retry delay",
            description: "Delay before retrying a failed manual compaction",
            currentValue: `${managerConfig.compact.retryDelayMs} ms`,
            submenu: (currentValue, finish) => createValueSubmenu("Compaction retry delay", retryDelayValues, currentValue, finish),
          },
          {
            id: "codexRetry.enabled",
            label: "Codex retry · all Codex errors",
            description: "Promote all OpenAI Codex errors to Pi's system retry",
            currentValue: managerConfig.codexRetry.enabled ? "enabled" : "disabled",
            values: ["enabled", "disabled"],
          },
          {
            id: "codexRetry.maxRetries",
            label: "Codex retry · maximum retries",
            description: "Maximum Codex assistant errors promoted to the system retry path",
            currentValue: String(managerConfig.codexRetry.maxRetries),
            submenu: (currentValue, finish) => createValueSubmenu("Maximum Codex retries", retryValues, currentValue, finish),
          },
        ];

        const container = new Container();
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Workspace Manager Settings")), 1, 0));
        const settingsList = new SettingsList(
          items,
          Math.min(items.length, 10),
          getSettingsListTheme(),
          (id, value) => {
            switch (id) {
              case "reload.enabled":
                managerConfig.reload.enabled = value === "enabled";
                break;
              case "compact.enabled":
                managerConfig.compact.enabled = value === "enabled";
                break;
              case "compact.thresholdPercent":
                managerConfig.compact.thresholdPercent = Number.parseInt(value, 10);
                break;
              case "compact.retryOnFailure":
                managerConfig.compact.retryOnFailure = value === "enabled";
                break;
              case "compact.maxRetries":
                managerConfig.compact.maxRetries = Number.parseInt(value, 10);
                break;
              case "compact.retryDelayMs":
                managerConfig.compact.retryDelayMs = Number.parseInt(value, 10);
                break;
              case "codexRetry.enabled":
                managerConfig.codexRetry.enabled = value === "enabled";
                break;
              case "codexRetry.maxRetries":
                managerConfig.codexRetry.maxRetries = Number.parseInt(value, 10);
                break;
            }
            persistManagerConfig();
            ctx.ui.notify(`Saved ${id}: ${value}`, "info");
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { settingsList.handleInput?.(data); tui.requestRender(); },
        };
      });
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

  // The marker is claimed only by a startup/resume that reopened its target session.
  const resumeFlagPath = join(homedir(), ".pi", "agent", ".pi-wm-resume");
  const sameSessionPath = (left: string, right: string) =>
    resolve(left).replace(/\\/g, "/").toLowerCase() === resolve(right).replace(/\\/g, "/").toLowerCase();

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup" && event.reason !== "resume") return;
    if (!fs.existsSync(resumeFlagPath)) return;

    let marker: ReloadRecoveryMarker;
    try {
      marker = JSON.parse(fs.readFileSync(resumeFlagPath, "utf-8"));
    } catch {
      return;
    }

    const restoredFile = ctx.sessionManager.getSessionFile();
    const restoredId = ctx.sessionManager.getSessionId();
    const restoredLeaf = ctx.sessionManager.getLeafId();
    const inputEpochAtStart = userInputEpoch;
    const generationAtStart = sessionGeneration;
    if (
      typeof marker.session !== "string" ||
      !restoredFile ||
      !sameSessionPath(marker.session, restoredFile) ||
      (marker.sessionId !== undefined && marker.sessionId !== restoredId)
    ) {
      return;
    }

    // Atomically claim the one-shot marker so a second pi process cannot also
    // trigger recovery for the same reload.
    const claimedPath = `${resumeFlagPath}.${process.pid}.claimed`;
    try {
      fs.renameSync(resumeFlagPath, claimedPath);
    } catch {
      return;
    }

    try {
      const claimed = JSON.parse(fs.readFileSync(claimedPath, "utf-8")) as ReloadRecoveryMarker;
      if (
        claimed.session !== marker.session ||
        claimed.sessionId !== marker.sessionId ||
        !sameSessionPath(claimed.session, restoredFile)
      ) {
        try { fs.renameSync(claimedPath, resumeFlagPath); } catch { fs.rmSync(claimedPath, { force: true }); }
        return;
      }
      fs.unlinkSync(claimedPath);
    } catch {
      try { fs.rmSync(claimedPath, { force: true }); } catch {}
      return;
    }

    setTimeout(() => {
      if (generationAtStart !== sessionGeneration || inputEpochAtStart !== userInputEpoch || !sessionActive) return;
      try {
        const activeFile = ctx.sessionManager.getSessionFile();
        if (!activeFile || !sameSessionPath(marker.session, activeFile)) return;
        if (ctx.sessionManager.getSessionId() !== restoredId || ctx.sessionManager.getLeafId() !== restoredLeaf) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages() || pendingCompactRequest) return;
        pi.sendMessage({
          customType: "pi-workspace-manager-reload-recovery",
          content: "Continue the current session.",
          display: false,
          details: { session: marker.session, createdAt: marker.createdAt },
        }, { triggerTurn: true, deliverAs: "followUp" });
      } catch { /* A replaced session has invalidated ctx; never resume it. */ }
    }, 3000);
  });

  // ═══════════════════════════════════════════════════════════
  // 6. Tools — pi_compact and pi_reload
  // ═══════════════════════════════════════════════════════════

  // Context compaction tool.
  pi.registerTool({
    name: "pi_compact",
    label: "Pi Compact",
    description: "Compact conversation context.",
    parameters: Type.Object({
      unfinishedTask: Type.String({ minLength: 1 }),
    }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const compactConfig = { ...managerConfig.compact };
      if (!compactConfig.enabled) {
        return {
          content: [{ type: "text", text: "Context compaction is disabled." }],
          details: { status: "disabled" },
        };
      }

      if (compactInProgress) {
        return {
          content: [{ type: "text", text: "Compaction is already in progress." }],
          details: { status: "already-in-progress" },
          terminate: true,
        };
      }

      const usage = ctx.getContextUsage();
      if (!usage || usage.percent === null || usage.tokens === null) {
        return {
          content: [{ type: "text", text: "Context usage is unavailable." }],
          details: { status: "refused", reason: "usage-unavailable", thresholdPercent: compactConfig.thresholdPercent },
        };
      }

      if (usage.percent <= compactConfig.thresholdPercent) {
        return {
          content: [{
            type: "text",
            text: `Context usage is below the configured threshold (${compactConfig.thresholdPercent}%).`,
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
          content: [{ type: "text", text: "unfinishedTask is required." }],
          details: { status: "refused", reason: "missing-unfinished-task" },
        };
      }

      compactInProgress = true;
      const request: PendingCompactRequest = {
        unfinishedTask,
        config: compactConfig,
        sessionId: ctx.sessionManager.getSessionId(),
        generation: sessionGeneration,
        userSubmitted: false,
      };
      pendingCompactRequest = request;
      runManualCompaction(request, ctx, 1);
      if (ctx.hasUI) {
        ctx.ui.notify(`Context at ${usage.percent.toFixed(1)}%. Starting manual compaction now...`, "info");
      }

      return {
        content: [{
          type: "text",
          text: "Compaction started.",
        }],
        details: {
          status: "started",
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
      if (status === "started") return new Text(theme.fg("success", "✓ Compaction started"), 0, 0);
      if (status === "already-in-progress") return new Text(theme.fg("warning", "Compaction already running"), 0, 0);
      return new Text(theme.fg("warning", "Compaction not needed"), 0, 0);
    },
  });

  pi.registerTool({
    name: "pi_reload",
    label: "Pi Reload",
    description: "Restart Pi and resume the current session.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!managerConfig.reload.enabled) {
        return {
          content: [{ type: "text", text: "Pi restart is disabled." }],
          details: { status: "disabled" },
        };
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "Pi restart is unavailable." }],
          details: { status: "no-session-file" },
          isError: true,
        };
      }

      const cwd = ctx.cwd;
      fs.writeFileSync(resumeFlagPath, JSON.stringify({
        session: sessionFile,
        sessionId: ctx.sessionManager.getSessionId(),
        createdAt: Date.now(),
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
    codexRetryAttempts = 0;
    codexImageRetryAttempts = 0;
    stripImagesForCodexRetry = false;
    if (pendingCompactRequest) clearPendingCompaction(pendingCompactRequest);
  });

  // User-invoked /update command
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
