import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import webPackage from "./package.json";
import { createDevProxy } from "../../scripts/dev/go-dev-config.mjs";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  },
  define: {
    __DUALLANE_APP_VERSION__: JSON.stringify(webPackage.version)
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
            return "vendor-react";
          }
          if (id.includes("/motion") || id.includes("/framer-motion")) {
            return "vendor-motion";
          }
          if (id.includes("/@radix-ui/")) {
            return "vendor-radix";
          }
          return undefined;
        }
      }
    }
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
