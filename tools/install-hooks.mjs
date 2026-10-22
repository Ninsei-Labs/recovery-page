// Install the tracked Git hooks for this clone. Windows git-bash resolves `git` through an MSYS wrapper that
// cannot be started from some Bun child processes, so try the normal name first and then the native binary.
import { spawnSync } from "node:child_process";

const candidates = [process.env.GIT_BIN, "git", "C:/Program Files/Git/cmd/git.exe"].filter(Boolean);
for (const bin of candidates) {
  const result = spawnSync(bin, ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
  if (result.status === 0) process.exit(0);
}
console.error("hooks:install: could not run git; set GIT_BIN to the git executable");
process.exit(1);
