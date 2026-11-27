// Dev: the UI talks to a real `health serve` through this proxy (same origin, so no CORS).
// The proxy drops the browser's Origin header (serve refuses any) and adds the owner token from HEALTH_SERVE.
// `tauri ios|android dev` on a device serves the UI on a LAN address (TAURI_DEV_HOST).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createReadStream, createWriteStream, mkdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

function serve(): { port: number; token: string } | null {
  const file = process.env.HEALTH_SERVE; // path to the JSON line `health serve` printed
  return file ? JSON.parse(readFileSync(file, "utf8")) : null;
}

/** The browser preview's stand-ins for what the app's shells do with files: a file picked in the page is written
 *  where `health serve` can read it (POST /dev/stage), and an export is written here, then downloaded
 *  (POST /dev/export, GET /dev/download). Dev server only; this page's origin only. */
function devFiles(): Plugin {
  const dir = join(tmpdir(), "health-dev-files");
  const safe = (name: string) => basename(name).replace(/[^\p{L}\p{N}._-]/gu, "_") || "file";
  return {
    name: "health-dev-files",
    configureServer(server) {
      server.middlewares.use("/dev", (req, res) => {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}`) return void res.writeHead(403).end();
        const url = new URL(req.url ?? "/", "http://x");
        const name = safe(decodeURIComponent(url.searchParams.get("name") ?? String(req.headers["x-file-name"] ?? "file")));
        if (req.method === "POST" && url.pathname === "/stage") {
          mkdirSync(join(dir, "stage"), { recursive: true });
          const path = join(dir, "stage", `${Date.now()}-${name}`);
          req.pipe(createWriteStream(path)).on("finish", () => res.end(path));
        } else if (req.method === "POST" && url.pathname === "/export") {
          mkdirSync(join(dir, "export"), { recursive: true });
          const path = join(dir, "export", name);
          rmSync(path, { force: true });
          res.end(path);
        } else if (req.method === "GET" && url.pathname === "/download") {
          res.setHeader("content-disposition", `attachment; filename="${name}"`);
          createReadStream(join(dir, "export", name))
            .on("error", () => res.writeHead(404).end())
            .pipe(res);
        } else res.writeHead(404).end();
      });
    },
  };
}

export default defineConfig(() => {
  const s = serve();
  const host = process.env.TAURI_DEV_HOST;
  return {
    plugins: [react(), tailwindcss(), devFiles()],
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
      host: host || false,
      hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
      watch: { ignored: ["**/src-tauri/**"] },
      proxy: s
        ? {
            "/v1": {
              target: `http://127.0.0.1:${s.port}`,
              changeOrigin: true,
              // the token is added below, so only this dev page may use the proxy: a page from another origin
              // (a site open in the same browser) is turned away before anything reaches serve
              bypass: (req) => {
                const o = req.headers.origin;
                return o && o !== `http://${req.headers.host}` ? false : undefined;
              },
              configure: (proxy) => {
                proxy.on("proxyReq", (req) => {
                  req.removeHeader("origin");
                  req.removeHeader("referer");
                  req.setHeader("authorization", `Bearer ${s.token}`);
                });
              },
            },
          }
        : undefined,
    },
    build: { target: "es2022", outDir: "dist" },
  };
});
