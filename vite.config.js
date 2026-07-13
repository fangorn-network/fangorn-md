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
        },
    },
});
