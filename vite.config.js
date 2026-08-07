import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend never talks to Fangorn directly — the SDK needs Node (fs, LMDB
// block cache, wallet key). Everything goes through the local server, which the
// dev server proxies under /api so the browser sees a single origin.
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            "/api": {
                target: "http://localhost:8787",
                changeOrigin: true,
            },
            // So the MCP URL the 🤖 panel prints is just origin + /mcp, in dev
            // as in prod — including when dev is behind a tunnel.
            "/mcp": {
                target: "http://localhost:8787",
                changeOrigin: true,
            },
            // The public, no-login read view. Without this, dev serves the SPA
            // shell for /r/… and a share link copied in dev goes to a login
            // wall — the exact thing that route exists to avoid.
            "/r/": {
                target: "http://localhost:8787",
                changeOrigin: true,
            },
            // Yjs live-collab relay (see server/index.js) — needs WS upgrades.
            "/yjs": {
                target: "ws://localhost:8787",
                ws: true,
                changeOrigin: true,
            },
        },
    },
});
