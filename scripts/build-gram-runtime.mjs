import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTriple, tarExecutable } from "./build-goose-acp.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const resources = join(root, "src-tauri/resources");
const destination = join(resources, "gram-runtime");
const staging = `${destination}.new`;
const bin = join(resources, "bin");
const pin = JSON.parse(readFileSync(join(root, "runtime/node.json"), "utf8"));
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const asset = pin.assets[triple];
if (!asset) throw new Error(`Unsupported Gram Node target: ${triple}`);
if (asset.platform !== process.platform || asset.arch !== process.arch)
  throw new Error(
    "Gram's native runtime requires a matching build host and Node architecture",
  );
if (process.versions.node.split(".")[0] !== pin.version.split(".")[0])
  throw new Error(
    `Build Gram with Node ${pin.version} to match native addon ABI`,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cache = join(root, "target/gram-node-download");
mkdirSync(cache, { recursive: true });
mkdirSync(bin, { recursive: true });
const archive = join(
  cache,
  `${asset.sha256}${asset.platform === "win32" ? ".zip" : ".tar.gz"}`,
);
const temporary = mkdtempSync(join(cache, "stage-"));
try {
  if (!existsSync(archive) || hash(readFileSync(archive)) !== asset.sha256) {
    console.log(`Downloading standalone Node ${pin.version} (${triple})`);
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok)
      throw new Error(`Node download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== asset.sha256)
      throw new Error("Node archive SHA-256 mismatch");
    const pending = join(temporary, "download");
    writeFileSync(pending, bytes);
    renameSync(pending, archive);
  }
  for (const [kind, member] of [
    ["binary", asset.binary],
    ["license", asset.license],
  ]) {
    const extracted = spawnSync(tarExecutable(), ["-xOf", archive, member], {
      maxBuffer: 256 * 1024 * 1024,
    });
    if (extracted.error) throw extracted.error;
    if (extracted.status !== 0 || !extracted.stdout?.length)
      throw new Error(`Could not extract Node ${kind}: ${extracted.stderr}`);
    const pending = join(temporary, kind);
    writeFileSync(pending, extracted.stdout);
    if (kind === "binary") {
      chmodSync(pending, 0o755);
      if (process.platform === "darwin") {
        const linked = spawnSync("otool", ["-L", pending], {
          encoding: "utf8",
        });
        if (linked.error) throw linked.error;
        if (linked.status !== 0) throw new Error(linked.stderr);
        for (const line of linked.stdout.split("\n").slice(1)) {
          const library = line.trim().split(" (compatibility version")[0];
          if (
            library &&
            !library.startsWith("/usr/lib/") &&
            !library.startsWith("/System/Library/")
          )
            throw new Error(`Node links ${library}, which Macs do not ship`);
        }
      }
    }
    const name =
      kind === "license"
        ? "gram-node.LICENSE"
        : asset.platform === "win32"
          ? "gram-node.exe"
          : "gram-node";
    renameSync(pending, join(bin, name));
  }
  console.log(`Standalone Node ready (${pin.version}, ${triple})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

rmSync(staging, { recursive: true, force: true });
const rebuild = spawnSync(
  "pnpm",
  ["--filter", "@gram/runtime", "rebuild", "node-pty"],
  { cwd: root, stdio: "inherit" },
);
if (rebuild.error) throw rebuild.error;
if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);
const deployed = spawnSync(
  "pnpm",
  [
    "--config.node-linker=hoisted",
    "--filter",
    "@gram/runtime",
    "deploy",
    "--prod",
    staging,
  ],
  { cwd: root, stdio: "inherit" },
);
if (deployed.error) throw deployed.error;
if (deployed.status !== 0) process.exit(deployed.status ?? 1);
if (!existsSync(join(staging, "index.mjs")))
  throw new Error("Gram runtime staging is incomplete");
rmSync(join(staging, "node_modules/@getpaseo/server/dist/server/web-ui"), {
  recursive: true,
  force: true,
});
copyFileSync(join(root, "LICENSE"), join(staging, "LICENSE.buzz"));
copyFileSync(join(root, "NOTICE.md"), join(staging, "NOTICE.buzz"));
copyFileSync(join(root, "LICENSE.paseo"), join(staging, "LICENSE.paseo"));
rmSync(destination, { recursive: true, force: true });
renameSync(staging, destination);
