import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiOrigin = process.env.DUALLANE_API_ORIGIN || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
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
