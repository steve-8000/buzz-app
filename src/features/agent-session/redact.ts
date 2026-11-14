// What a session shows its readers must not carry the owner's credentials.
import type { SessionItem } from "./item";

const SECRET = new RegExp(
  [
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
    "AKIA[0-9A-Z]{16}",
    "xox[abprs]-[A-Za-z0-9-]{10,}",
    "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
    "nsec1[02-9ac-hj-np-z]{58}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)",
  ].join("|"),
  "g",
);
const ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Z0-9_]*)=(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g;

const MASK = "••••";

export function mask(text: string) {
  return text.replace(SECRET, MASK).replace(ASSIGNMENT, `$1=${MASK}`);
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, walk(field)]),
    );
  return value;
}

/** The item with every credential-shaped string masked. */
export function redact(item: SessionItem): SessionItem {
  return walk(item) as SessionItem;
}
