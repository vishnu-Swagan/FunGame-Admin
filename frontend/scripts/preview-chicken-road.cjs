/* A small, local-only preview independent of the production app/dev middleware.
 * Uses installed frontend build dependencies; no API, account or wallet access.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const webpack = require("webpack");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src/pages/play/chicken-road");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "chakri-chicken-preview-"));
const port = Number(process.env.CHICKEN_PREVIEW_PORT || 4194);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CHICKEN_PREVIEW_PORT");

const compiler = webpack({
  mode: "development",
  context: root,
  entry: path.join(source, "preview.js"),
  output: { path: output, filename: "preview.js" },
  devtool: false,
  resolve: { modules: [path.join(root, "node_modules"), "node_modules"], extensions: [".js", ".json"] },
  module: { rules: [
    { test: /\.js$/, exclude: /node_modules/, use: { loader: require.resolve("babel-loader"), options: { babelrc: false, configFile: false, presets: [[require.resolve("@babel/preset-react"), { runtime: "automatic" }]] } } },
    { test: /\.css$/, use: [require.resolve("style-loader"), require.resolve("css-loader")] },
  ] },
});

compiler.run((error, stats) => {
  compiler.close(() => {});
  if (error || stats.hasErrors()) {
    console.error(error || stats.toString({ all: false, errors: true }));
    process.exitCode = 1;
    return;
  }
  fs.copyFileSync(path.join(source, "preview.html"), path.join(output, "index.html"));
  // A whitelist avoids exposing the checkout, credentials or unrelated files.
  const files = {
    "/": [path.join(output, "index.html"), "text/html; charset=utf-8"],
    "/preview.js": [path.join(output, "preview.js"), "text/javascript; charset=utf-8"],
    "/game-art/chicken-road.png": [path.join(root, "public/game-art/chicken-road.png"), "image/png"],
    "/games/chicken-road/chicken-idle.png": [path.join(root, "public/games/chicken-road/chicken-idle.png"), "image/png"],
    "/games/chicken-road/chicken-blink.png": [path.join(root, "public/games/chicken-road/chicken-blink.png"), "image/png"],
  };
  const server = http.createServer((request, response) => {
    const file = files[String(request.url).split("?")[0]];
    if (!["GET", "HEAD"].includes(request.method) || !file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": file[1], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (request.method === "HEAD") { response.end(); return; }
    fs.createReadStream(file[0]).on("error", () => response.destroy()).pipe(response);
  });
  server.on("error", (err) => { console.error(err.message); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Chicken Road local preview: http://127.0.0.1:${port}/`));
});
