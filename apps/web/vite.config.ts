import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webPackage from "./package.json";
import { createDevProxy } from "../../scripts/dev/go-dev-config.mjs";

export default defineConfig({
  plugins: [react()],
  define: {
    __DUALLANE_APP_VERSION__: JSON.stringify(webPackage.version)
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: createDevProxy(process.env)
  },
  preview: {
    port: 4173
  }
});
