import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const port = Number(process.env.DSH_DESKTOP_DEV_PORT) || 1821;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available.
  //    821 is privileged, which macOS refuses to bind as a normal user, so the
  //    port is overridable there via DSH_DESKTOP_DEV_PORT (pair it with
  //    `--config '{"build":{"devUrl":"http://localhost:<port>"}}'`).
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 822,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`. `harness/` and `plugins/`
      //    are served by the Harness Host, not by Vite, and watching those
      //    trees costs thousands of descriptors — enough to take the dev
      //    server down when a Harness rebuild rewrites them.
      ignored: ["**/src-tauri/**", "**/harness/**", "**/plugins/**"],
    },
  },
}));
