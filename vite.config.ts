import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching the Rust crates and build output
      ignored: ["**/crates/**", "**/target/**"],
    },
  },
  build: {
    // The oldest web views the README supports: Safari 17.5-era WebKit on
    // macOS 14.5 and WebKitGTK 4.1 with current updates on Linux, and
    // Evergreen WebView2 on Windows
    target: ["safari17", "chrome120"],
  },
}));
