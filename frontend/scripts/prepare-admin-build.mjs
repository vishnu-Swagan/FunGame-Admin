import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const buildDirectory = process.argv[2];

if (!buildDirectory) {
  throw new Error("Usage: node scripts/prepare-admin-build.mjs <build-directory>");
}

const buildPath = resolve(buildDirectory);
const indexPath = resolve(buildPath, "index.html");
const manifestPath = resolve(buildPath, "manifest.json");
const serviceWorkerPath = resolve(buildPath, "service-worker.js");
const adminManifestPath = resolve("public/manifest.admin.json");

for (const requiredPath of [indexPath, manifestPath, serviceWorkerPath, adminManifestPath]) {
  if (!existsSync(requiredPath)) {
    throw new Error(`Missing required admin build file: ${requiredPath}`);
  }
}

let indexHtml = readFileSync(indexPath, "utf8");
const indexReplacements = [
  ["Chakri.Casino — play-chip amusement games.", "MYDGP.CASINO — restricted operator control console."],
  ["Chakri.Casino", "MYDGP.CASINO"],
  ["Chakri.Casino — Play Chips", "MYDGP.CASINO — Admin"],
];

for (const [from, to] of indexReplacements) {
  if (!indexHtml.includes(from)) {
    throw new Error(`Unexpected index.html template: missing ${JSON.stringify(from)}`);
  }
  indexHtml = indexHtml.replace(from, to);
}

if (indexHtml.includes("Chakri.Casino")) {
  throw new Error("Admin index.html still includes legacy Chakri branding");
}

writeFileSync(indexPath, indexHtml);
copyFileSync(adminManifestPath, manifestPath);

let serviceWorker = readFileSync(serviceWorkerPath, "utf8");
if (!serviceWorker.includes("chakri-shell-v1")) {
  throw new Error("Unexpected service-worker cache namespace");
}
serviceWorker = serviceWorker.replaceAll("chakri-shell-v1", "mydgp-admin-shell-v1");
writeFileSync(serviceWorkerPath, serviceWorker);

console.log(`Prepared MyDGP admin bundle: ${buildPath}`);
