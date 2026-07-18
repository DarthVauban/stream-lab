import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextCli = path.join(root, "node_modules", "next", "dist", "bin", "next");
const mediaServer = path.join(root, "media-server", "server.mjs");

const children = [
  spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", "5173"], {
    cwd: root,
    stdio: "inherit",
  }),
  spawn(process.execPath, [mediaServer], {
    cwd: root,
    stdio: "inherit",
  }),
];

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 1000).unref();
}

for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    shutdown(1);
  });
  child.once("exit", (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal)) shutdown(code || 1);
  });
}

process.once("SIGINT", () => shutdown(0));
process.once("SIGTERM", () => shutdown(0));

