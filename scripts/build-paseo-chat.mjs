import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "target");
const destination = join(target, "gram-paseo-source-d13438ba");
const source = join(destination, "source");
const commit = "d13438ba50ed74c0d9057370b5f5c781aee0f687";
const expected =
  "e71418556eb8a7894807fe97a6902b59f0a7dd25c0b504a3fdcdaf30736e1f8e";
const ready = [
  "packages/app/src/panels/agent-panel.tsx",
  "packages/client/dist/index.js",
  "node_modules/.package-lock.json",
];

if (ready.every((path) => existsSync(join(source, path)))) process.exit(0);
if (existsSync(destination))
  throw new Error(`Incomplete Paseo source cache: ${destination}`);

mkdirSync(target, { recursive: true });
const stage = mkdtempSync(join(target, "gram-paseo-build-"));
const extracted = join(stage, "source");
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, npm_config_cache: join(stage, "npm-cache") },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status})`);
};

try {
  const response = await fetch(
    `https://codeload.github.com/getpaseo/paseo/tar.gz/${commit}`,
    {
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!response.ok)
    throw new Error(`Paseo source download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== expected)
    throw new Error("Paseo source archive SHA-256 mismatch");
  const tarball = join(stage, "source.tar.gz");
  writeFileSync(tarball, archive);
  mkdirSync(extracted);
  run("tar", ["-xzf", tarball, "--strip-components=1", "-C", extracted], root);
  run(
    "npm",
    [
      "ci",
      "--workspace=@getpaseo/app",
      "--include-workspace-root",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    extracted,
  );
  run("npm", ["run", "postinstall"], extracted);
  run("npm", ["run", "build:app-deps"], extracted);
  if (!ready.every((path) => existsSync(join(extracted, path))))
    throw new Error("Paseo source preparation is incomplete");
  renameSync(stage, destination);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
