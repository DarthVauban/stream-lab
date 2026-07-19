import os from "node:os";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const MAX_HISTORY = 90;

function rounded(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    const times = Object.values(cpu?.times || {}).map(Number);
    idle += Number(cpu?.times?.idle) || 0;
    total += times.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  }
  return { idle, total };
}

export function calculateCpuUsage(previous, current) {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
  return rounded(Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100)));
}

export function parseNetworkCounters(payload) {
  let receivedBytes = 0;
  let transmittedBytes = 0;
  for (const line of String(payload || "").split(/\r?\n/)) {
    if (!line.includes(":")) continue;
    const [rawName, rawCounters] = line.split(":", 2);
    const name = rawName.trim();
    if (!name || name === "lo") continue;
    const counters = rawCounters.trim().split(/\s+/).map(Number);
    if (counters.length < 9) continue;
    receivedBytes += Number.isFinite(counters[0]) ? counters[0] : 0;
    transmittedBytes += Number.isFinite(counters[8]) ? counters[8] : 0;
  }
  return { receivedBytes, transmittedBytes };
}

async function readNetworkCounters(readFileImpl = readFile) {
  try {
    return parseNetworkCounters(await readFileImpl("/proc/net/dev", "utf8"));
  } catch {
    return null;
  }
}

async function readTemperature({ readdirImpl = readdir, readFileImpl = readFile } = {}) {
  try {
    const root = "/sys/class/thermal";
    const entries = await readdirImpl(root, { withFileTypes: true });
    const values = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("thermal_zone")) continue;
      const raw = Number.parseFloat(await readFileImpl(path.join(root, entry.name, "temp"), "utf8"));
      const celsius = raw > 1_000 ? raw / 1_000 : raw;
      if (Number.isFinite(celsius) && celsius > -50 && celsius < 200) values.push(celsius);
    }
    return values.length ? rounded(Math.max(...values)) : null;
  } catch {
    return null;
  }
}

export class SystemMonitor {
  constructor({
    storage,
    intervalMs = Number(process.env.SYSTEM_MONITOR_INTERVAL_MS || 2_000),
    osImpl = os,
    processImpl = process,
    now = () => Date.now(),
    networkProvider = () => readNetworkCounters(),
    temperatureProvider = () => readTemperature(),
    onSnapshot = () => {},
    logger = console,
  } = {}) {
    if (!storage) throw new Error("SystemMonitor requires StorageMonitor.");
    this.storage = storage;
    this.intervalMs = Math.max(1_000, Math.min(30_000, Number(intervalMs) || 2_000));
    this.os = osImpl;
    this.process = processImpl;
    this.now = now;
    this.networkProvider = networkProvider;
    this.temperatureProvider = temperatureProvider;
    this.onSnapshot = onSnapshot;
    this.logger = logger;
    this.previousCpu = null;
    this.previousNetwork = null;
    this.previousAt = null;
    this.last = null;
    this.history = [];
    this.timer = null;
    this.capturePromise = null;
  }

  async init() {
    this.previousCpu = cpuTotals(this.os.cpus());
    this.previousNetwork = await this.networkProvider();
    this.previousAt = this.now();
    await this.capture();
    return this.snapshot();
  }

  async capture() {
    if (this.capturePromise) return this.capturePromise;
    this.capturePromise = this.captureOnce().finally(() => {
      this.capturePromise = null;
    });
    return this.capturePromise;
  }

  async captureOnce() {
    const capturedAtMs = this.now();
    const cpus = this.os.cpus();
    const currentCpu = cpuTotals(cpus);
    const cpuUsagePercent = calculateCpuUsage(this.previousCpu, currentCpu);
    const currentNetwork = await this.networkProvider();
    const elapsedSeconds = Math.max(0.001, (capturedAtMs - (this.previousAt ?? capturedAtMs)) / 1_000);
    const network = currentNetwork && this.previousNetwork
      ? {
          receivedBytesPerSecond: Math.max(
            0,
            Math.round((currentNetwork.receivedBytes - this.previousNetwork.receivedBytes) / elapsedSeconds),
          ),
          transmittedBytesPerSecond: Math.max(
            0,
            Math.round((currentNetwork.transmittedBytes - this.previousNetwork.transmittedBytes) / elapsedSeconds),
          ),
          receivedBytes: currentNetwork.receivedBytes,
          transmittedBytes: currentNetwork.transmittedBytes,
        }
      : {
          receivedBytesPerSecond: null,
          transmittedBytesPerSecond: null,
          receivedBytes: currentNetwork?.receivedBytes ?? null,
          transmittedBytes: currentNetwork?.transmittedBytes ?? null,
        };
    const totalMemoryBytes = Number(this.os.totalmem()) || 0;
    const freeMemoryBytes = Math.max(0, Number(this.os.freemem()) || 0);
    const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
    const processMemory = this.process.memoryUsage?.() || {};
    const [disk, temperatureCelsius] = await Promise.all([
      this.storage.snapshot(),
      this.temperatureProvider(),
    ]);
    const capturedAt = new Date(capturedAtMs).toISOString();
    const sample = {
      capturedAt,
      cpuUsagePercent,
      memoryUsagePercent: totalMemoryBytes > 0 ? rounded((usedMemoryBytes / totalMemoryBytes) * 100) : null,
      receivedBytesPerSecond: network.receivedBytesPerSecond,
      transmittedBytesPerSecond: network.transmittedBytesPerSecond,
    };
    this.history.push(sample);
    this.history = this.history.slice(-MAX_HISTORY);
    this.last = {
      updatedAt: capturedAt,
      intervalMs: this.intervalMs,
      cpu: {
        usagePercent: cpuUsagePercent,
        cores: cpus.length,
        model: cpus[0]?.model?.trim() || "Unknown CPU",
        speedMhz: rounded(
          cpus.reduce((sum, cpu) => sum + (Number(cpu.speed) || 0), 0) / Math.max(1, cpus.length),
          0,
        ),
        loadAverage: this.os.loadavg().map((value) => rounded(value, 2)),
        temperatureCelsius,
      },
      memory: {
        totalBytes: totalMemoryBytes,
        usedBytes: usedMemoryBytes,
        freeBytes: freeMemoryBytes,
        usagePercent: sample.memoryUsagePercent,
        processRssBytes: Number(processMemory.rss) || 0,
        processHeapUsedBytes: Number(processMemory.heapUsed) || 0,
        availableToProcessBytes: Number(this.process.availableMemory?.()) || null,
      },
      disk,
      network,
      system: {
        hostname: this.os.hostname(),
        platform: this.os.platform(),
        release: this.os.release(),
        architecture: this.os.arch(),
        uptimeSeconds: Math.max(0, Math.floor(this.os.uptime())),
        nodeVersion: this.process.version || null,
      },
      history: this.history.map((item) => ({ ...item })),
    };
    this.previousCpu = currentCpu;
    this.previousNetwork = currentNetwork;
    this.previousAt = capturedAtMs;
    await this.onSnapshot(this.snapshot());
    return this.snapshot();
  }

  snapshot() {
    return this.last ? structuredClone(this.last) : null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.capture().catch((error) => this.logger.error("StreamLab system monitoring failed.", error));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.capturePromise?.catch(() => {});
  }
}
