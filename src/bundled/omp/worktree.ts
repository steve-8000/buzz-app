// One git worktree and branch per conversation, so agents working on the same
// repository never share a checkout. Worktrees are never deleted here: they
// hold the agent's work until the owner merges or discards it.
export type ExecResult = Readonly<{ code: number; out: string; err: string }>;
/** Runs `git <args>` in `cwd`. */
export type Exec = (
  args: readonly string[],
  cwd: string,
) => Promise<ExecResult>;

export type Worktree = Readonly<{
  path: string;
  branch: string;
  /** The repository's top-level directory. */
  repo: string;
}>;

/** A name for a conversation that is safe in a path and a branch. */
export function slug(key: string): string {
  const base =
    key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "conversation";
  let hash = 5381;
  for (const char of key) hash = ((hash * 33) ^ char.charCodeAt(0)) >>> 0;
  return `${base}-${hash.toString(36)}`;
}

function failure(step: string, result: ExecResult) {
  return new Error(
    `git ${step} failed: ${result.err.trim() || result.out.trim()}`,
  );
}

/** The path of the worktree that has `branch` checked out, as git reports it
 * (a real path, which can differ from the one asked for through a symlink). */
function worktreeOf(porcelain: string, branch: string) {
  let path: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return path;
  }
  return undefined;
}

/** The conversation's worktree under `root`, made from `base` on first use. */
export async function prepareWorktree(
  exec: Exec,
  options: Readonly<{ repo: string; base: string; root: string; key: string }>,
): Promise<Worktree> {
  const top = await exec(["rev-parse", "--show-toplevel"], options.repo);
  if (top.code !== 0)
    throw new Error(`${options.repo} is not a git repository.`);
  const repo = top.out.trim();
  const id = slug(options.key);
  const path = `${options.root}/${repo.split("/").pop() || "repo"}/${id}`;
  const branch = `buzz/${id}`;
  const listed = await exec(["worktree", "list", "--porcelain"], repo);
  const existing = worktreeOf(listed.out, branch);
  if (existing) return { path: existing, branch, repo };
  const made = await exec(
    ["worktree", "add", "-b", branch, path, options.base],
    repo,
  );
  if (made.code === 0) return { path, branch, repo };
  if (!/already exists/.test(made.err)) throw failure("worktree add", made);
  const reused = await exec(["worktree", "add", path, branch], repo);
  if (reused.code !== 0) throw failure("worktree add", reused);
  return { path, branch, repo };
}
