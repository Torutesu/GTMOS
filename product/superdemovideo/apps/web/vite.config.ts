import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the SPA runs on its own port and the API stays where the
// worker is; in production the API serves this build directly, so the same
// relative paths work in both without a base URL to configure.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:3000", changeOrigin: true },
      "/d": { target: "http://127.0.0.1:3000", changeOrigin: true },
      "/badge": { target: "http://127.0.0.1:3000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
