import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = new Set(["critical", "high"]);

function result(id, severity, passed, message) {
  return { id, severity, passed, message };
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

async function staticChecks() {
  const [compose, caddy, deploy, gitignore, restoreScript] = await Promise.all([
    readFile(path.join(root, "compose.yaml"), "utf8"),
    readFile(path.join(root, "Caddyfile"), "utf8"),
    readFile(path.join(root, ".github", "workflows", "deploy.yml"), "utf8"),
    readFile(path.join(root, ".gitignore"), "utf8"),
    readFile(path.join(root, "scripts", "restore-backup.sh"), "utf8"),
  ]);
  const files = trackedFiles();
  const mediaBlock = compose.match(/^  media-server:\r?\n[\s\S]*?(?=^  [A-Za-z0-9_-]+:\r?$|\Z)/m)?.[0] || "";
  const forbiddenTracked = files.filter((file) => /(^|\/)(\.env|.*\.pem|.*\.key)$/i.test(file));
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bghp_[A-Za-z0-9]{36,}\b/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\b\d{6,20}:[A-Za-z0-9_-]{35,}\b/,
  ];
  const scanCandidates = files.filter((file) =>
    !file.startsWith("tests/") &&
    (file === ".env.example" || /\.(?:js|mjs|cjs|ts|tsx|json|ya?ml|sh|md)$/i.test(file)),
  );
  const secretHits = [];
  for (const file of scanCandidates) {
    const content = await readFile(path.join(root, file), "utf8");
    if (secretPatterns.some((pattern) => pattern.test(content))) secretHits.push(file);
  }

  return [
    result("git.no-secret-files", "critical", forbiddenTracked.length === 0, forbiddenTracked.length ? `Tracked secret files: ${forbiddenTracked.join(", ")}` : "No environment, key or certificate files are tracked."),
    result("git.no-secret-values", "critical", secretHits.length === 0, secretHits.length ? `Possible live secrets: ${secretHits.join(", ")}` : "No high-confidence live secret values found in production sources."),
    result("git.ignore-runtime-secrets", "high", /\.env\*/.test(gitignore), "Runtime environment files are ignored."),
    result("docker.media-private", "high", !/^    ports:/m.test(mediaBlock), "The media API is not published on the host."),
    result("docker.web-loopback", "high", compose.includes('127.0.0.1:3000:3000'), "The fallback web port is bound to loopback only."),
    result("docker.no-new-privileges", "high", (compose.match(/no-new-privileges:true/g) || []).length >= 7, "Production and maintenance containers disable privilege escalation."),
    result("docker.required-secrets", "critical", ["POSTGRES_PASSWORD", "OWNER_PASSWORD_HASH", "SESSION_SECRET", "STREAM_CONFIG_SECRET"].every((name) => compose.includes(`\${${name}:?`)), "Required secrets fail closed when absent."),
    result("backup.automatic", "high", compose.includes("backup-scheduler:") && compose.includes("BACKUP_RETENTION_DAYS"), "Automatic retained backups are configured."),
    result("restore.confirmation", "critical", restoreScript.includes("STREAMLAB_RESTORE_CONFIRMED=YES"), "Restore requires an explicit confirmation and controlled service stop."),
    result("headers.hsts", "high", caddy.includes("Strict-Transport-Security"), "HSTS is configured."),
    result("headers.csp", "high", caddy.includes("Content-Security-Policy") && caddy.includes("object-src 'none'") && caddy.includes("frame-ancestors 'none'"), "CSP blocks objects and framing."),
    result("headers.browser-hardening", "medium", ["Permissions-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"].every((header) => caddy.includes(header)), "Browser hardening headers are configured."),
    result("auth.secure-cookie-production", "high", deploy.includes('AUTH_COOKIE_SECURE="true"'), "Production deployment forces Secure session cookies."),
  ];
}

async function runtimeChecks(baseUrl) {
  if (!baseUrl) return [];
  const parsed = new URL(baseUrl);
  const checks = [
    result("runtime.https", "critical", parsed.protocol === "https:", "Production audit URL uses HTTPS."),
  ];
  const response = await fetch(new URL("/api/health", parsed), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  checks.push(result("runtime.health", "high", response.ok, `Health endpoint returned HTTP ${response.status}.`));
  const requiredHeaders = [
    "strict-transport-security",
    "content-security-policy",
    "permissions-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
  ];
  const missing = requiredHeaders.filter((name) => !response.headers.get(name));
  checks.push(result("runtime.headers", "high", missing.length === 0, missing.length ? `Missing response headers: ${missing.join(", ")}` : "All required response headers are present."));
  return checks;
}

export async function runSecurityAudit({ baseUrl = "" } = {}) {
  const checks = [...await staticChecks(), ...await runtimeChecks(baseUrl)];
  const passed = checks.every((check) => check.passed || !failures.has(check.severity));
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    passed,
    summary: {
      checks: checks.length,
      passed: checks.filter((check) => check.passed).length,
      failed: checks.filter((check) => !check.passed).length,
    },
    checks,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : process.argv[index + 1] || "";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await runSecurityAudit({ baseUrl: argument("--url") || process.env.SECURITY_AUDIT_URL || "" });
  for (const check of report.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} [${check.severity.toUpperCase()}] ${check.id}: ${check.message}`);
  }
  console.log(`Security audit: ${report.passed ? "PASSED" : "FAILED"} (${report.summary.passed}/${report.summary.checks})`);
  const reportPath = argument("--report");
  if (reportPath) await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (!report.passed) process.exitCode = 1;
}
