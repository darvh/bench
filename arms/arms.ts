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

export type ArmName = "naive" | "signal" | "clarity" | "signal+clarity";

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

export async function ensureArmSkills(arm: ArmName): Promise<ArmSkills | undefined> {
  const names: Record<string, string[]> = {
    signal: ["signal"],
    clarity: ["clarity"],
    "signal+clarity": ["signal", "clarity"],
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
  signal: { hint: "Before making changes, use the Signal skill." },
  clarity: { hint: "Before responding, use the Clarity skill." },
  "signal+clarity": { hint: "Before making changes, use the Signal skill, then the Clarity skill." },
};
