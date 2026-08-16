/**
 * Arms registry — the ONLY product-specific part of the bench.
 *
 * Skills are NOT vendored here. The recommended distribution path is: the
 * signal repo's installer (install.sh — macOS/Linux/WSL; install.ps1 — Windows)
 * installs the skill
 * into each agent's skills dir on the HOST. The bench resolves the HOST
 * installed copy (the same path a real user's agent loads) and passes it to
 * harbor — so the bench measures the real distribution + install path, not a
 * vendored copy. If the skill is missing, the bench installs it (one-line,
 * idempotent) before running.
 */
import path from "node:path";
import { homedir } from "node:os";
import { promises as fs } from "node:fs";

export type ArmName = "naive" | "signal" | "caveman" | "ponytail" | "signal+ponytail" | "caveman+ponytail";

export interface Arm {
  skills?: string[]; // skill dirs installed into the container (skill tool)
  hint?: string;
}

// Recommended host install location (opencode per-agent skills dir; the
// installer targets the same matrix for every agent).
export const HOST_SKILLS_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
  "opencode",
  "skills",
);

const SKILL_SOURCE = path.join(import.meta.dir, "..", "..", "signal"); // sibling signal repo checkout, if present

async function resolveSkill(name: string): Promise<string | null> {
  const installed = path.join(HOST_SKILLS_DIR, name);
  try {
    await fs.access(path.join(installed, "SKILL.md"));
    return installed;
  } catch {}
  // fallback: sibling checkout (dev mode)
  try {
    await fs.access(path.join(SKILL_SOURCE, name, "SKILL.md"));
    return path.join(SKILL_SOURCE, name);
  } catch {}
  return null;
}

export interface ArmSkills {
  dirs: string[];
  sourceSha: string | null; // installed skill revision (provenance)
}

// Installed skill revision: the git HEAD of the distribution checkout that
// installed the host skills (symlinks point there), or null when unknown.
async function installedSha(): Promise<string | null> {
  try {
    const p = Bun.spawn({ cmd: ["git", "-C", SKILL_SOURCE, "rev-parse", "HEAD"], stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Harbor copies each entry of agents[].skills into the container's skills
// ROOT via `cp -r <dir>/* ~/.config/opencode/skills/` — which flattens a
// single skill dir (SKILL.md lands in the root, opencode never finds it).
// Stage the arm's skills under one dir, one subdir per skill, so the copy
// preserves the required <skills>/<name>/SKILL.md layout.
export async function stageSkills(arm: ArmName, stageRoot: string): Promise<ArmSkills | undefined> {
  const info = await ensureArmSkills(arm);
  if (!info) return undefined;
  const stage = path.join(stageRoot, arm);
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  for (const dir of info.dirs) {
    // host installs are symlinks — resolve so the staged copy is real files
    const real = await fs.realpath(dir).catch(() => dir);
    await fs.cp(real, path.join(stage, path.basename(dir)), { recursive: true, force: true });
  }
  return { dirs: [stage], sourceSha: info.sourceSha };
}

export async function ensureArmSkills(arm: ArmName): Promise<ArmSkills | undefined> {
  const names: Record<string, string[]> = {
    signal: ["signal"],
    caveman: ["caveman"],
    ponytail: ["ponytail"],
    "signal+ponytail": ["signal", "ponytail"],
    "caveman+ponytail": ["caveman", "ponytail"],
  };
  const want = names[arm];
  if (!want) return undefined;
  const dirs: string[] = [];
  for (const n of want) {
    const dir = await resolveSkill(n);
    if (dir) {
      dirs.push(dir);
      continue;
    }
    // recommended distribution path: run the signal installer on the host
    const installer = path.join(SKILL_SOURCE, "install.sh");
    if (await fs.access(installer).then(() => true).catch(() => false)) {
      const p = Bun.spawn({ cmd: ["bash", installer, "--targets", "opencode"], cwd: path.dirname(SKILL_SOURCE), stdout: "pipe", stderr: "pipe" });
      await p.exited;
      const dir2 = await resolveSkill(n);
      if (dir2) dirs.push(dir2);
    }
  }
  const sourceSha = await installedSha();
  return dirs.length ? { dirs, sourceSha } : undefined;
}

export const ARMS: Record<ArmName, Arm> = {
  naive: {},
  signal: {},
  caveman: {},
  ponytail: {},
  "signal+ponytail": {},
  "caveman+ponytail": {},
};

// Read the arm's installed skill SKILL.md content (for always-on AGENTS.md injection).
export async function armSkillContent(arm: ArmName): Promise<string> {
  const info = await ensureArmSkills(arm);
  if (!info) return "";
  const parts: string[] = [];
  for (const dir of info.dirs) {
    const real = await fs.realpath(dir).catch(() => dir);
    try {
      parts.push(await fs.readFile(path.join(real, "SKILL.md"), "utf8"));
    } catch {}
  }
  return parts.join("\n\n");
}

// Which installed skill names an arm expects the agent to load.
export function armSkillNames(arm: ArmName): string[] {
  const names: Record<string, string[]> = {
    signal: ["signal"],
    caveman: ["caveman"],
    ponytail: ["ponytail"],
    "signal+ponytail": ["signal", "ponytail"],
    "caveman+ponytail": ["caveman", "ponytail"],
  };
  return names[arm] ?? [];
}

// Pinned skill commits for the study. harbor's tree/<ref> parser resolves the
// ref via `git ls-remote` refname matching, which rejects raw SHAs — so each
// pin is a dedicated branch (refs/heads/study-pin-<sha>) pushed to the repo at
// exactly that commit. A future push to main cannot change what a study
// measured. Bump deliberately and record the new SHA in the run's provenance.
export const SKILL_PINS: Record<string, string> = {
  signal: "study-pin-364f8b3", // -> 364f8b350c8b11234ce16cb81835d4bf4c40d47a
  ponytail: "main", // -> 2ed6c52c9d7e5e56942508591085fd45dea277d3 (branch, resolves via ls-remote)
  caveman: "main",
};

// Remote git skill sources for the same arms: harbor resolves org/name or a
// tree URL, sparse-checkouts into cache, and mounts the skill dir. Skills with
// a pin in SKILL_PINS resolve from that exact commit; unpinned ones use `ref`.
export function armSkillRefs(arm: ArmName, ref = "main"): string[] {
  // each skill resolved from its published git repo, pinned to its subdir
  const refs: Record<string, string[]> = {
    signal: [`https://github.com/darvh/signal/tree/${SKILL_PINS.signal ?? ref}/signal`],
    caveman: [`https://github.com/JuliusBrussee/caveman/tree/${SKILL_PINS.caveman ?? "main"}/skills/caveman`],
    ponytail: [`https://github.com/DietrichGebert/ponytail/tree/${SKILL_PINS.ponytail ?? "main"}/skills/ponytail`],
    "signal+ponytail": [
      `https://github.com/darvh/signal/tree/${SKILL_PINS.signal ?? ref}/signal`,
      `https://github.com/DietrichGebert/ponytail/tree/${SKILL_PINS.ponytail ?? "main"}/skills/ponytail`,
    ],
    "caveman+ponytail": [
      `https://github.com/JuliusBrussee/caveman/tree/${SKILL_PINS.caveman ?? "main"}/skills/caveman`,
      `https://github.com/DietrichGebert/ponytail/tree/${SKILL_PINS.ponytail ?? "main"}/skills/ponytail`,
    ],
  };
  return refs[arm] ?? [];
}
