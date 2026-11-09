/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const consoleBaseRedirect: Plugin = {
  name: "ohmyomop-router-console-base-redirect",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const pathname = request.url?.split("?")[0] ?? "";
      const destination =
        pathname === "/performance" || pathname === "/console/performance" ? "/console/usage" : null;
      if (destination === null) {
        // Serve landing at "/" and console at "/console/*" (SPA)
        if (pathname === "/") {
          request.url = "/landing.html";
        } else if (pathname.startsWith("/console/") || pathname === "/console") {
          // let Vite serve index.html (console) for /console/* — bypass via URL rewrite
          if (!pathname.startsWith("/console/api")) {
            request.url = "/index.html";
          }
        }
        next();
        return;
      }
      response.statusCode = 302;
      response.setHeader("Location", destination);
      response.end();
    });
  },
};

export default defineConfig({
  base: "/",
  plugins: [consoleBaseRedirect, react(), tailwindcss()],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: false,
    css: false,
    testTimeout: 15_000,
  },
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/console/api": {
        target: "http://127.0.0.1:12800",
        changeOrigin: false,
      },
      "/v1": {
        target: "http://127.0.0.1:12800",
        changeOrigin: false,
      },
      "/share": {
        target: "http://127.0.0.1:12800",
        changeOrigin: false,
        bypass: (req) => {
          const url = req.url ?? "";
          const path = url.split("?")[0];
          if (path.endsWith("/data") || path.endsWith("/stream") || path.includes("/setup/")) return undefined;
          return "/share.html";
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
    cssCodeSplit: true,
    reportCompressedSize: false,
    minify: "esbuild",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: {
        landing: "landing.html",
        console: "index.html",
        share: "share.html",
      },
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "query-vendor": ["@tanstack/react-query"],
          chart: ["recharts"],
          lucide: ["lucide-react"],
          sonner: ["sonner"],
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": "/src",
      "@/shared": "/src/shared",
    },
  },
});
