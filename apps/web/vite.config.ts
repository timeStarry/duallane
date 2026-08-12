import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webPackage from "./package.json";

const apiOrigin = process.env.DUALLANE_API_ORIGIN || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  define: {
    __DUALLANE_APP_VERSION__: JSON.stringify(webPackage.version)
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiOrigin,
      "/auth": apiOrigin,
      "/ws": {
        target: apiOrigin.replace(/^http/, "ws"),
        ws: true
      }
    }
  },
  preview: {
    port: 4173
  }
});
