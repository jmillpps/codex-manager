import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REQUIRED_LIBS = ["libnspr4.so", "libnss3.so", "libnssutil3.so", "libasound.so.2"];
const LOCAL_LIB_DIR = path.resolve(".data/playwright-libs/root/usr/lib/x86_64-linux-gnu");
const LOCAL_DEB_DIR = path.resolve(".data/playwright-libs/debs");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
    ...options
  });
}

function log(message) {
  process.stderr.write(`[playwright-bootstrap] ${message}\n`);
}

function systemHasRequiredLibs() {
  const result = run("ldconfig", ["-p"]);
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return false;
  }

  return REQUIRED_LIBS.every((name) => result.stdout.includes(name));
}

function localLibsAvailable() {
  return REQUIRED_LIBS.every((name) => existsSync(path.join(LOCAL_LIB_DIR, name)));
}

function ensureLinuxDeps() {
  if (process.platform !== "linux") {
    return;
  }

  if (systemHasRequiredLibs()) {
    return;
  }

  if (localLibsAvailable()) {
    return;
  }

  const aptVersion = run("apt-get", ["--version"]);
  if (aptVersion.status !== 0) {
    log("Missing Linux browser libs and apt-get unavailable; Playwright may fail to launch.");
    return;
  }

  mkdirSync(LOCAL_DEB_DIR, { recursive: true });
  const projectRootForRelativePaths = path.resolve(".");

  const packageGroups = [
    ["libnspr4", "libnss3", "libasound2t64"],
    ["libnspr4", "libnss3", "libasound2"]
  ];

  let downloaded = false;
  for (const packages of packageGroups) {
    const downloadResult = run("apt-get", ["download", ...packages], {
      cwd: LOCAL_DEB_DIR
    });

    if (downloadResult.status === 0) {
      downloaded = true;
      break;
    }
  }

  if (!downloaded) {
    log("Failed to download required browser libraries with apt-get download.");
    return;
  }

  const debFiles = readdirSync(LOCAL_DEB_DIR).filter((file) => file.endsWith(".deb"));
  if (debFiles.length === 0) {
    log("No .deb artifacts were downloaded for browser dependencies.");
    return;
  }

  const extractRoot = path.resolve(LOCAL_DEB_DIR, "..", "root");
  mkdirSync(extractRoot, { recursive: true });

  for (const debFile of debFiles) {
    const extractResult = run("dpkg-deb", ["-x", path.join(LOCAL_DEB_DIR, debFile), extractRoot], {
      cwd: projectRootForRelativePaths
    });

    if (extractResult.status !== 0) {
      log(`Failed to extract ${debFile}; Playwright may fail to launch.`);
      return;
    }
  }

  if (!localLibsAvailable()) {
    log("Dependency extraction completed, but required libraries are still missing.");
  }
}

function runPlaywright() {
  ensureLinuxDeps();

  const env = { ...process.env };
  if (!systemHasRequiredLibs() && localLibsAvailable()) {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
      ? `${LOCAL_LIB_DIR}:${env.LD_LIBRARY_PATH}`
      : LOCAL_LIB_DIR;
  }

  const args = process.argv.slice(2);
  const result = spawnSync("pnpm", ["exec", "playwright", "test", ...args], {
    stdio: "inherit",
    env
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

runPlaywright();
