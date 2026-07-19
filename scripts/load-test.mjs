import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SAFE_OWNER_ENDPOINTS = [
  "/api/videos",
  "/api/queue",
  "/api/stream/status",
  "/api/system/status",
  "/api/monitoring/status?hours=1",
  "/api/storage/status",
];

export function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function createOwnerSession(baseUrl, username, password) {
  if (!username || !password) return null;
  const response = await fetch(new URL("/api/auth/login", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Load-test login failed with HTTP ${response.status}.`);
  const setCookie = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "";
  const cookie = setCookie.split(";", 1)[0];
  if (!cookie) throw new Error("Load-test login did not return a session cookie.");
  return cookie;
}

export async function runLoadTest({
  baseUrl,
  durationSeconds = 60,
  concurrency = 10,
  maxP95Ms = 500,
  maxErrorRate = 0.01,
  username = "",
  password = "",
  fetchImpl = fetch,
  now = () => performance.now(),
} = {}) {
  const parsedUrl = new URL(baseUrl);
  const durationMs = Math.max(1_000, Number(durationSeconds) * 1_000);
  const workers = Math.max(1, Math.min(200, Number(concurrency) || 10));
  const cookie = await createOwnerSession(parsedUrl, username, password);
  const endpoints = cookie ? ["/api/health", ...SAFE_OWNER_ENDPOINTS] : ["/api/health"];
  const maxLatencySamples = 200_000;
  const latencies = [];
  const sampleErrors = [];
  let requestCount = 0;
  let errorCount = 0;
  let latencySum = 0;
  let minLatency = Number.POSITIVE_INFINITY;
  let maxLatency = 0;
  const statusCounts = {};
  const endpointCounts = {};
  const startedAtMs = now();
  const endsAtMs = startedAtMs + durationMs;

  async function worker(workerId) {
    let iteration = workerId;
    while (now() < endsAtMs) {
      const endpoint = endpoints[iteration % endpoints.length];
      iteration += workers;
      const requestStartedAt = now();
      try {
        const response = await fetchImpl(new URL(endpoint, parsedUrl), {
          headers: cookie ? { Cookie: cookie } : {},
          signal: AbortSignal.timeout(Math.max(2_000, Number(maxP95Ms) * 10)),
        });
        await response.arrayBuffer();
        const elapsed = now() - requestStartedAt;
        requestCount += 1;
        latencySum += elapsed;
        minLatency = Math.min(minLatency, elapsed);
        maxLatency = Math.max(maxLatency, elapsed);
        if (latencies.length < maxLatencySamples) latencies.push(elapsed);
        else {
          const replacement = Math.floor(Math.random() * requestCount);
          if (replacement < maxLatencySamples) latencies[replacement] = elapsed;
        }
        statusCounts[response.status] = (statusCounts[response.status] || 0) + 1;
        endpointCounts[endpoint] = (endpointCounts[endpoint] || 0) + 1;
        if (!response.ok) {
          errorCount += 1;
          if (sampleErrors.length < 20) sampleErrors.push({ endpoint, status: response.status, message: `HTTP ${response.status}` });
        }
      } catch (error) {
        const elapsed = now() - requestStartedAt;
        requestCount += 1;
        errorCount += 1;
        latencySum += elapsed;
        minLatency = Math.min(minLatency, elapsed);
        maxLatency = Math.max(maxLatency, elapsed);
        if (latencies.length < maxLatencySamples) latencies.push(elapsed);
        else {
          const replacement = Math.floor(Math.random() * requestCount);
          if (replacement < maxLatencySamples) latencies[replacement] = elapsed;
        }
        if (sampleErrors.length < 20) {
          sampleErrors.push({ endpoint, status: null, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, index) => worker(index)));
  const elapsedSeconds = Math.max(0.001, (now() - startedAtMs) / 1_000);
  const total = requestCount;
  const errorRate = total ? errorCount / total : 1;
  const p95Ms = percentile(latencies, 0.95);
  const passed = total > 0 && errorRate <= maxErrorRate && p95Ms <= maxP95Ms;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: parsedUrl.origin,
    authenticated: Boolean(cookie),
    durationSeconds: Number(elapsedSeconds.toFixed(2)),
    concurrency: workers,
    passed,
    thresholds: { maxP95Ms, maxErrorRate },
    requests: {
      total,
      perSecond: Number((total / elapsedSeconds).toFixed(2)),
      errors: errorCount,
      errorRate: Number(errorRate.toFixed(6)),
      statusCounts,
      endpointCounts,
    },
    latencyMs: {
      sampled: latencies.length,
      min: Number((Number.isFinite(minLatency) ? minLatency : 0).toFixed(2)),
      average: Number((latencySum / Math.max(1, total)).toFixed(2)),
      p50: Number(percentile(latencies, 0.5).toFixed(2)),
      p95: Number(p95Ms.toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
      max: Number(maxLatency.toFixed(2)),
    },
    sampleErrors,
  };
}

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await runLoadTest({
    baseUrl: argument("--url", process.env.LOAD_TEST_URL || "http://127.0.0.1:3000"),
    durationSeconds: Number(argument("--duration", process.env.LOAD_TEST_DURATION_SECONDS || "60")),
    concurrency: Number(argument("--concurrency", process.env.LOAD_TEST_CONCURRENCY || "10")),
    maxP95Ms: Number(argument("--max-p95", process.env.LOAD_TEST_MAX_P95_MS || "500")),
    maxErrorRate: Number(argument("--max-error-rate", process.env.LOAD_TEST_MAX_ERROR_RATE || "0.01")),
    username: process.env.LOAD_TEST_USERNAME || "",
    password: process.env.LOAD_TEST_PASSWORD || "",
  });
  console.log(JSON.stringify(report, null, 2));
  const reportPath = argument("--report");
  if (reportPath) {
    const resolved = path.resolve(reportPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (!report.passed) process.exitCode = 1;
}
