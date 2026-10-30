import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyError = JSON.stringify({
  error: "Could not reach the TaskPilot AI server on port 3001. Run npm run dev so the API and web app start together.",
});

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:3001",
    timeout: 35_000,
    proxyTimeout: 35_000,
    configure(proxy: { on: (event: string, listener: (...args: unknown[]) => void) => void }) {
      proxy.on("error", (_error: unknown, _request: unknown, response: unknown) => {
        const res = response as { headersSent?: boolean; writeHead?: (status: number, headers: Record<string, string>) => void; end?: (body: string) => void };
        if (res?.headersSent || typeof res?.writeHead !== "function" || typeof res?.end !== "function") return;
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(apiProxyError);
      });
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
});
