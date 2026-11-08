import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
  assetsDirectory: "./public",
  build: { command: "npm exec -- vp build --config ../../vite.config.ts", watchDir: "./client" },
  dev: { port: 8787, inspectorPort: 9229 },
});
