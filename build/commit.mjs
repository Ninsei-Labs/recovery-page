// THE COMMIT OF THE CHECKOUT, read from files only - no `git` process, no network.
//
// A build made from a release archive has no `.git` beside it, and then the commit is null: a
// placeholder would be a false claim, and "unknown" is a fact. A linked worktree is handled too: its
// `.git` is a file holding `gitdir: <path>`, its refs live in the common directory named by
// `commondir`, and looking only in the gitdir answers "no commit" exactly where the commit is known.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function gitDir(dir) {
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit)) return null;
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const text = readFileSync(dotGit, "utf8");
    return text.startsWith("gitdir:") ? text.slice("gitdir:".length).trim() : null;
  } catch {
    return null;
  }
}

function commonDir(gd) {
  try {
    const text = readFileSync(join(gd, "commondir"), "utf8").trim();
    return text ? resolve(gd, text) : gd;
  } catch {
    return gd;
  }
}

export function checkoutCommit(dir = join(HERE, "..")) {
  const gd = gitDir(dir);
  if (!gd) return null;
  const full = (value) => (/^[0-9a-f]{40}$/.test(value) ? value : null);
  try {
    const head = readFileSync(join(gd, "HEAD"), "utf8").trim();
    const direct = full(head);
    if (direct) return direct;
    const named = /^ref:\s*(\S+)$/.exec(head);
    if (!named) return null;
    const ref = named[1];
    for (const root of [gd, commonDir(gd)]) {
      const loose = join(root, ref);
      if (existsSync(loose)) {
        const found = full(readFileSync(loose, "utf8").trim());
        if (found) return found;
      }
      const packed = join(root, "packed-refs");
      if (existsSync(packed)) {
        for (const line of readFileSync(packed, "utf8").split("\n")) {
          // "<sha> <ref>" and, above it, "^<sha>" lines for tag objects - those carry no ref.
          if (line.endsWith(" " + ref)) {
            const found = full(line.slice(0, 40));
            if (found) return found;
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
