import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { createPaseoDaemon, loadConfig } from "@getpaseo/server";

const home = join(homedir(), ".gram", "runtime");
const lockPath = join(home, "gram.pid");
const password = process.env.GRAM_RUNTIME_PASSWORD;
const origin = process.env.GRAM_RUNTIME_ORIGIN;
delete process.env.GRAM_RUNTIME_PASSWORD;
delete process.env.GRAM_RUNTIME_ORIGIN;
process.env.PASEO_HOME = home;
if (!password || !origin)
  throw new Error("Gram runtime requires its owning app's credentials");
await mkdir(home, { recursive: true, mode: 0o700 });
async function acquire() {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8"));
    if (!Number.isInteger(pid) || pid < 1)
      throw new Error("Invalid Gram runtime ownership file");
    try {
      process.kill(pid, 0);
      throw new Error("Gram runtime is already owned by a running application");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await unlink(lockPath);
    return open(lockPath, "wx", 0o600);
  }
}
const lock = await acquire();
await lock.writeFile(String(process.pid));
await lock.close();
const logger = pino({ level: "warn" }, pino.destination(2));
let daemon;
let stopping;
let starting;
function stop() {
  if (!stopping)
    stopping = (async () => {
      try {
        await starting?.catch((error) =>
          logger.warn({ err: error }, "Gram runtime startup did not complete"),
        );
        await daemon?.stop();
      } finally {
        if (
          (await readFile(lockPath, "utf8").catch(() => "")) ===
          String(process.pid)
        ) {
          await unlink(lockPath);
        }
      }
    })();
  return stopping;
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.once(signal, () => void stop().finally(() => process.exit(0)));
}
process.stdin.resume();
process.stdin.once("end", () => void stop().finally(() => process.exit(0)));
try {
  const port = 0;
  const config = loadConfig(home, {
    env: {
      ...process.env,
      PASEO_HOME: home,
      PASEO_PASSWORD: password,
      PASEO_DICTATION_ENABLED: "false",
      PASEO_VOICE_MODE_ENABLED: "false",
    },
    cli: {
      listen: `127.0.0.1:${port}`,
      relayEnabled: false,
      mcpEnabled: true,
      webUiEnabled: false,
    },
  });
  config.corsAllowedOrigins = [origin];
  config.relayEnabledMutable = false;
  config.resumeOnStartup = false;
  config.pluginsEnabled = false;
  config.providerOverrides = {
    ...config.providerOverrides,
    omp: { ...config.providerOverrides?.omp, enabled: true },
  };
  starting = createPaseoDaemon(config, logger).then(async (created) => {
    daemon = created;
    await daemon.start();
  });
  await starting;
  const target = daemon.getListenTarget();
  if (target?.type !== "tcp" || target.host !== "127.0.0.1")
    throw new Error("Gram runtime did not bind to loopback");
  process.stdout.write(
    `${JSON.stringify({
      type: "ready",
      url: `ws://127.0.0.1:${target.port}/ws`,
      serverId: daemon.getServerId(),
    })}\n`,
  );
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  await stop();
  process.exit(1);
}
