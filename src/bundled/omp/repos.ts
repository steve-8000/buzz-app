// Finding the local repository a conversation belongs to, so a new channel or
// thread needs no agent setup: a channel works on the repository named like it.
export type Repo = Readonly<{ name: string; path: string }>;

/** Prints the repositories among the arguments, or directly inside them. */
export const LIST_SCRIPT = [
  'for r in "$@"; do',
  '  r=$(printf %s "$r" | sed "s|^~|$HOME|")',
  '  if [ -e "$r/.git" ]; then echo "$r"; continue; fi',
  '  for d in "$r"/*/; do',
  '    [ -e "$d.git" ] && echo "$d"',
  "  done",
  "done",
].join("\n");

export function parseRepositories(output: string): Repo[] {
  const seen = new Set<string>();
  const repos: Repo[] = [];
  for (const line of output.split("\n")) {
    const path = line.trim().replace(/\/+$/, "");
    const name = path.split("/").pop();
    if (!path.startsWith("/") || !name) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    repos.push({ name, path });
  }
  return repos;
}

export type Choice = Readonly<{
  repo?: Repo;
  asked?: string;
  /** The channel names a folder of repositories and the message names no
   * single one: the conversation works in that folder, across them. */
  hub?: string;
}>;

const parentName = (repo: Repo) =>
  repo.path.split("/").slice(-2)[0]?.toLowerCase() ?? "";

/** `name` as a whole word, so `thegram-ui` is not found in `thegram-ui-staging`. */
const named = (words: string, name: string) =>
  new RegExp(
    `(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`,
    "i",
  ).test(words);

/** `asked` is set when the owner named a repository, found or not: a typo
 * must not fall back to the channel's repository. */
export function pickRepository(
  repos: readonly Repo[],
  where: string,
  words: string,
): Choice {
  const asked = /(?:^|\s)repo[:=]\s*(\S+)/i
    .exec(words)?.[1]
    ?.replace(/[.,;)\]]+$/, "")
    .replace(/\/+$/, "");
  if (asked) {
    const wanted = asked.toLowerCase();
    const leaf = wanted.split("/").pop();
    const repo =
      repos.find((item) => item.path.toLowerCase() === wanted) ??
      repos.find((item) => item.name.toLowerCase() === leaf);
    return repo ? { repo, asked } : { asked };
  }
  const channel = where.startsWith("#") ? where.slice(1).toLowerCase() : "";
  if (!channel) return {};
  const exact = repos.find((item) => item.name.toLowerCase() === channel);
  if (exact) return { repo: exact };
  const longest = repos
    .filter((item) => {
      const name = item.name.toLowerCase();
      return channel.startsWith(`${name}-`) || channel.startsWith(`${name}_`);
    })
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (longest) return { repo: longest };
  // A channel named for a folder of repositories (an organisation): a message
  // naming one of them picks it, any other question works across the folder.
  const group = repos.filter((item) => {
    const folder = parentName(item);
    return folder === channel || folder.startsWith(`${channel}-`);
  });
  const first = group[0];
  if (!first) return {};
  const mentioned = group.filter((item) => named(words, item.name));
  const only = mentioned[0];
  if (mentioned.length === 1 && only) return { repo: only };
  return { hub: first.path.slice(0, first.path.lastIndexOf("/")) };
}

const NAMES_LIMIT = 120;

/** The repositories grouped by their folder, for the agent's instructions. */
export function describeRepositories(repos: readonly Repo[]): string {
  const groups = new Map<string, string[]>();
  for (const repo of repos.slice(0, NAMES_LIMIT)) {
    const parent = repo.path.slice(0, repo.path.lastIndexOf("/")) || "/";
    groups.set(parent, [...(groups.get(parent) ?? []), repo.name]);
  }
  return [...groups]
    .map(([parent, names]) => `${parent}/: ${names.join(", ")}`)
    .join("\n");
}
