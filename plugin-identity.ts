export function canonicalGitIdentity(ref: string): string | undefined {
  let value = ref.trim();
  if (/^(?:git|github):/i.test(value) && !/^git:\/\//i.test(value)) {
    value = value.replace(/^(?:git|github):/i, "");
    const branchAt = value.lastIndexOf("@");
    if (branchAt > value.lastIndexOf("/")) value = value.slice(0, branchAt);
    if (!value.includes(".")) value = `github.com/${value.replace(/^\/+/, "")}`;
  } else if (/^git@[^:]+:/i.test(value)) {
    value = value.replace(/^git@([^:]+):/i, "$1/");
  } else if (/^(?:https?|ssh|git):\/\//i.test(value)) {
    value = value.replace(/^(?:https?|ssh|git):\/\//i, "");
  } else if (!/^[^/]+\.[^/]+\//i.test(value)) {
    return undefined;
  }
  value = value.replace(/^www\./i, "").replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return value.includes("/") ? `git:${value}` : undefined;
}

export function canonicalPluginIdentity(ref: string, name: string, repository?: string): string {
  const gitIdentity = canonicalGitIdentity(ref) ?? (repository ? canonicalGitIdentity(repository) : undefined);
  return gitIdentity ?? `package:${name.replace(/@[^@/]+$/, "").toLowerCase()}`;
}
