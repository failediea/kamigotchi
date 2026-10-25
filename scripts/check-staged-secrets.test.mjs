import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scanner = fileURLToPath(new URL("./check-staged-secrets.mjs", import.meta.url));

test("scanner reads the actual linked-worktree index and supports release ranges", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vault-secret-scan-"));
  const repo = join(tmp, "source");
  const worktree = join(tmp, "repair");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8" });
  const scan = (...args) => spawnSync(process.execPath, [scanner, ...args], {
    env: { ...process.env, SECRET_SCAN_REPO: worktree }, encoding: "utf8",
  });
  try {
    execFileSync("git", ["init", repo], { stdio: "pipe" });
    git("config", "user.name", "Scanner test");
    git("config", "user.email", "scanner@example.invalid");
    writeFileSync(join(repo, "README.md"), "safe baseline\n");
    git("add", "README.md");
    git("commit", "-m", "baseline");
    const base = git("rev-parse", "HEAD").trim();
    git("worktree", "add", "-b", "repair", worktree);
    writeFileSync(join(worktree, "worker.js"), "export const limit = 100;\n");
    execFileSync("git", ["-C", worktree, "add", "worker.js"]);
    assert.equal(scan().status, 0);
    const secret = ["PRIVATE", "KEY"].join("_") + "=test-only-not-a-real-key\n";
    writeFileSync(join(worktree, "leak.env"), secret);
    execFileSync("git", ["-C", worktree, "add", "leak.env"]);
    const rejected = scan();
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /credential-like value/);
    assert.doesNotMatch(rejected.stderr, /test-only-not-a-real-key/);
    writeFileSync(join(worktree, "leak.env"), "# safe template\n");
    execFileSync("git", ["-C", worktree, "add", "leak.env"]);
    execFileSync("git", ["-C", worktree, "commit", "-m", "safe release"], { stdio: "pipe" });
    assert.equal(scan("--base", base).status, 0);
    writeFileSync(join(worktree, "unsafe.reservations.journal"), "{}\n");
    execFileSync("git", ["-C", worktree, "add", "unsafe.reservations.journal"]);
    assert.notEqual(scan().status, 0);
    assert.notEqual(scan("--base", "does-not-exist").status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
