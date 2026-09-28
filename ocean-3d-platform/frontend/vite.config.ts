import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cesium from "vite-plugin-cesium";

export default defineConfig({
  plugins: [react(), cesium()],
  server: {
    proxy: {
      // FastAPI backend (uvicorn on :8000). Same-origin for the dev
      // server, so the frontend needs neither CORS exceptions nor
      // absolute backend URLs.
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
});
