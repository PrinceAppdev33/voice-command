import { request as httpRequest } from "node:http";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from "vite";

const apiHost = "127.0.0.1";
const apiPort = 3001;
const apiProxyTimeoutMs = 70_000;
const apiUnavailable = JSON.stringify({
  error: "Could not reach the TaskPilot AI server on port 3001. Run npm run dev so the API and web app start together.",
});

function attachApiProxy(server: ViteDevServer | PreviewServer) {
  server.middlewares.use((req, res, next) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api")) {
      next();
      return;
    }

    const proxyReq = httpRequest({
      hostname: apiHost,
      port: apiPort,
      path: url,
      method: req.method,
      headers: { ...req.headers, host: `${apiHost}:${apiPort}` },
      timeout: apiProxyTimeoutMs,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("timeout", () => {
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "The TaskPilot API proxy timed out. Check that the API server is running and try again." }));
      }
      proxyReq.destroy();
    });
    proxyReq.on("error", () => {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(apiUnavailable);
    });
    req.pipe(proxyReq);
  });
}

function apiProxyPlugin(): Plugin {
  return {
    name: "taskpilot-api-proxy",
    enforce: "pre",
    configureServer: attachApiProxy,
    configurePreviewServer: attachApiProxy,
  };
}

export default defineConfig({
  plugins: [apiProxyPlugin(), react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
