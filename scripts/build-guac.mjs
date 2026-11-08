import { spawnSync } from "node:child_process";
import { prepareGuac } from "./prepare-guac.mjs";

await prepareGuac();

const cwd = new URL("../vendor/guac/", import.meta.url);

for (const [command, args] of [
  [process.execPath, ["build.mjs"]],
  [
    "wasm-pack",
    [
      "build",
      "browser",
      "--release",
      "--target",
      "web",
      "--out-dir",
      "../client",
      "--out-name",
      "guac",
      "--no-pack",
      "--",
      "--locked",
    ],
  ],
]) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: "true" },
  });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
}
