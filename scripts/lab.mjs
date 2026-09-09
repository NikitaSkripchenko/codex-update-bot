import { build } from "esbuild";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
// Use a dedicated env file; never load production .dev.vars.
if (existsSync(".env.lab")) process.loadEnvFile(".env.lab");
const dataDir = resolve(process.env.LAB_DATA_DIR || ".local-lab");
mkdirSync(dataDir, { recursive: true });
const bundle = resolve(dataDir, "runtime.mjs");
await build({ entryPoints: ["src/local-lab.ts"], bundle: true, platform: "node", format: "esm", packages: "external", outfile: bundle });
const { LocalLab } = await import(pathToFileURL(bundle).href);
const dataPath = resolve(dataDir, "data.json");
const lab = new LocalLab(existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, "utf8")) : undefined, {
  apiKey: process.env.OPENROUTER_API_KEY,
  save(data) {
    const pending = `${dataPath}.tmp`;
    writeFileSync(pending, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(pending, dataPath);
  },
});
const port = Number(process.env.LAB_PORT || 8790);
const assets = new Map([["/", ["index.html", "text/html; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]], ["/style.css", ["style.css", "text/css; charset=utf-8"]]]);
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; form-action 'self'");
  const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return json(403, { error: "Local access only" });
    if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return json(403, { error: "Invalid origin" });
    const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
    if (req.method === "GET" && assets.has(path)) {
      const [name, contentType] = assets.get(path);
      res.writeHead(200, { "Content-Type": contentType });
      return res.end(readFileSync(resolve(root, "local-lab", name)));
    }
    if (req.method === "GET" && path === "/api/state") return json(200, lab.snapshot());
    if (req.method !== "POST" || !["/api/tweets", "/api/settings", "/api/run", "/api/reset"].includes(path)) return json(404, { error: "Not found" });
    if (!req.headers["content-type"]?.startsWith("application/json")) return json(415, { error: "JSON required" });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { json(413, { error: "Request too large" }); return; }
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (path === "/api/tweets") lab.addTweet(body);
    if (path === "/api/settings") lab.configure(body);
    if (path === "/api/run") await lab.run();
    if (path === "/api/reset") lab.reset();
    json(200, lab.snapshot());
  } catch (error) {
    json(400, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.on("error", (error) => { console.error(error.message); lab.stop(); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => {
  lab.start();
  console.log(`Local test environment: http://localhost:${port}\nData: ${dataPath}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { lab.stop(); server.close(); });
