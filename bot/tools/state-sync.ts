// Keeps the autopilot's memory (bot/state/*.json) on its own `bot-state`
// branch, so routine runs never commit to master.
//
//   npm run state:pull   start of a run: copy bot-state's JSON into bot/state/
//   npm run state:push   end of a run: commit bot/state/*.json to bot-state
//
// Only *.json is synced on purpose: bot/state/ also holds store.ts (code).
// Checking out the whole folder from bot-state would overwrite current code
// with whatever old copy sits on that branch.
//
// Push uses a throwaway git worktree, so the run's own checkout (master or a
// feature branch) is never switched or dirtied.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BRANCH = "bot-state";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const STATE_DIR = path.join(REPO_ROOT, "bot/state");

function git(args: string[], cwd = REPO_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function remoteBranchExists(): boolean {
  try {
    git(["fetch", "origin", BRANCH]);
    return true;
  } catch {
    return false;
  }
}

function pull() {
  if (!remoteBranchExists()) {
    console.log(`[state] no origin/${BRANCH} yet; using the state files in this checkout.`);
    return;
  }
  git(["checkout", "FETCH_HEAD", "--", "bot/state/*.json"]);
  // Leave them unstaged so a stray `git commit` on the code branch doesn't pick them up.
  git(["reset", "-q", "--", "bot/state"]);
  console.log(`[state] pulled bot/state/*.json from origin/${BRANCH}.`);
}

function push() {
  const exists = remoteBranchExists();
  const dir = mkdtempSync(path.join(tmpdir(), "bot-state-"));
  try {
    git(["worktree", "add", "--detach", dir, exists ? "FETCH_HEAD" : "HEAD"]);
    for (const f of readdirSync(STATE_DIR).filter((f) => f.endsWith(".json"))) {
      copyFileSync(path.join(STATE_DIR, f), path.join(dir, "bot/state", f));
    }
    git(["add", "bot/state"], dir);
    const changed = git(["status", "--porcelain", "--", "bot/state"], dir);
    // First push ever: the worktree starts from HEAD, whose JSON can already
    // match, so "nothing changed" — but the branch still has to be created.
    if (!changed && exists) {
      console.log("[state] nothing changed; no commit.");
      return;
    }
    if (changed) {
      // Fall back to a bot identity only if the environment has none.
      let identity: string[] = [];
      try {
        git(["config", "user.email"], dir);
      } catch {
        identity = ["-c", "user.name=fantasybot", "-c", "user.email=fantasybot@users.noreply.github.com"];
      }
      git([...identity, "commit", "-q", "-m", `chore: autopilot state ${new Date().toISOString()}`], dir);
    }
    git(["push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`], dir);
    console.log(`[state] pushed bot/state/*.json to ${BRANCH}.`);
  } finally {
    try {
      git(["worktree", "remove", "--force", dir]);
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * After a successful push, put bot/state/*.json in the run's checkout back to
 * what the code branch has, and delete JSON files the code branch doesn't
 * track (e.g. action-log.json). The state is safe on bot-state by now.
 *
 * Why (found live 2026-11-10): the cloud routine runs a Stop hook that sees
 * the pulled state files as "uncommitted changes" and tells the agent to
 * "commit and push these changes to the remote branch" — i.e. dump bot state
 * onto master. Opus refused, citing the playbook; a weaker or more literal
 * run might obey. A clean tree removes the prompt entirely.
 */
function cleanCheckout() {
  try {
    git(["checkout", "HEAD", "--", "bot/state/*.json"]);
  } catch {
    // No tracked JSON under bot/state on this branch — nothing to restore.
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", "bot/state"])
    .split("\n")
    .filter((f) => f.endsWith(".json"));
  for (const f of untracked) rmSync(path.join(REPO_ROOT, f), { force: true });
  console.log("[state] working tree cleaned (state lives on bot-state).");
}

const cmd = process.argv[2];
if (cmd === "pull") pull();
else if (cmd === "push") {
  push();
  cleanCheckout();
}
else {
  console.error("Usage: tsx bot/tools/state-sync.ts pull|push");
  process.exitCode = 1;
}
