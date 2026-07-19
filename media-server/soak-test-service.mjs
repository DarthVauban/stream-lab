import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-error.mjs";

const ACTIVE_STREAM_STATUSES = new Set(["STARTING", "LIVE", "DEGRADED", "RECONNECTING"]);
const TEMP_FILE_PATTERN = /(?:\.part|\.tmp(?:\.|$)|\.processing\.tmp\.mp4$|\.thumbnail\.upload\.png$)/i;

function emptyState() {
  return { schemaVersion: 1, current: null, history: [] };
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function temporaryStorage(rootDir) {
  let files = 0;
  let bytes = 0;
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && TEMP_FILE_PATTERN.test(entry.name)) {
        files += 1;
        bytes += (await stat(target)).size;
      }
    }
  }
  await visit(rootDir);
  return { files, bytes };
}

function defaultRequirements(value = {}) {
  return {
    activeStream: value.activeStream !== false,
    videoTransition: value.videoTransition !== false,
    fallback: value.fallback !== false,
    reconnect: value.reconnect !== false,
    promo: value.promo !== false,
    telegram: value.telegram !== false,
  };
}

function publicRun(run) {
  if (!run) return null;
  const safe = structuredClone(run);
  delete safe.observedEventIds;
  return safe;
}

export class SoakTestService {
  constructor({
    rootDir,
    getSnapshot,
    now = () => Date.now(),
    intervalMs = Number(process.env.SOAK_TEST_SAMPLE_INTERVAL_MS || 60_000),
    minimumDurationHours = 72,
    maxRssGrowthPercent = Number(process.env.SOAK_TEST_MAX_RSS_GROWTH_PERCENT || 30),
    maxTempGrowthBytes = Number(process.env.SOAK_TEST_MAX_TEMP_GROWTH_BYTES || 536_870_912),
    logger = console,
  } = {}) {
    if (!rootDir || typeof getSnapshot !== "function") {
      throw new Error("SoakTestService requires rootDir and getSnapshot.");
    }
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "soak-test.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.getSnapshot = getSnapshot;
    this.now = now;
    this.intervalMs = Math.max(1, Number(intervalMs) || 60_000);
    this.minimumDurationHours = Math.max(0.000001, Number(minimumDurationHours) || 72);
    this.maxRssGrowthPercent = Math.max(0, Number(maxRssGrowthPercent) || 30);
    this.maxTempGrowthBytes = Math.max(0, Number(maxTempGrowthBytes) || 536_870_912);
    this.logger = logger;
    this.state = emptyState();
    this.timer = null;
    this.capturePromise = null;
    this.persistQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      if (saved?.schemaVersion === 1) {
        this.state = {
          schemaVersion: 1,
          current: saved.current || null,
          history: Array.isArray(saved.history) ? saved.history.slice(-10) : [],
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await this.persist();
    if (this.state.current?.status === "RUNNING") {
      await this.capture().catch((error) => this.logger.error("StreamLab soak test resume failed.", error));
      if (this.state.current?.status === "RUNNING") this.schedule();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      current: publicRun(this.state.current),
      history: this.state.history.map(publicRun),
      requiredDurationHours: this.minimumDurationHours,
      sampleIntervalMs: this.intervalMs,
      thresholds: {
        availabilityPercent: 99.5,
        maxRssGrowthPercent: this.maxRssGrowthPercent,
        maxTempGrowthBytes: this.maxTempGrowthBytes,
      },
    };
  }

  persist() {
    const operation = this.persistQueue.catch(() => {}).then(async () => {
      await writeFile(this.tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(this.tempPath, this.filePath);
    });
    this.persistQueue = operation;
    return operation;
  }

  async start({ durationHours = 72, requirements } = {}) {
    if (this.state.current?.status === "RUNNING") {
      throw new ApiError(409, "SOAK_TEST_ALREADY_RUNNING", "72-годинний soak test уже виконується.");
    }
    const duration = Number(durationHours);
    if (!Number.isFinite(duration) || duration < this.minimumDurationHours || duration > 168) {
      throw new ApiError(400, "INVALID_SOAK_DURATION", `Тривалість soak test має бути від ${this.minimumDurationHours} до 168 годин.`);
    }
    const firstSnapshot = await this.getSnapshot();
    const required = defaultRequirements(requirements);
    if (required.activeStream && !ACTIVE_STREAM_STATUSES.has(firstSnapshot.stream?.status)) {
      throw new ApiError(409, "STREAM_REQUIRED_FOR_SOAK_TEST", "Спочатку запустіть трансляцію, а потім починайте 72-годинний soak test.");
    }
    const temp = await temporaryStorage(this.rootDir);
    const startedAtMs = this.now();
    const promoImpressions = (firstSnapshot.promos?.campaigns || []).reduce((sum, item) => sum + finite(item.impressions), 0);
    this.state.current = {
      id: randomUUID(),
      status: "RUNNING",
      startedAt: new Date(startedAtMs).toISOString(),
      endsAt: new Date(startedAtMs + duration * 3_600_000).toISOString(),
      completedAt: null,
      durationHours: duration,
      requirements: required,
      baseline: {
        processRssBytes: finite(firstSnapshot.system?.memory?.processRssBytes),
        tempFiles: temp.files,
        tempBytes: temp.bytes,
        promoImpressions,
      },
      latest: null,
      samples: [],
      observedEventIds: [],
      coverage: {
        videoTransitions: 0,
        fallbackObserved: Boolean(firstSnapshot.stream?.isFallback),
        reconnectAttempts: 0,
        reconnectRecoveries: 0,
        promoImpressions: 0,
        telegramCommands: firstSnapshot.telegram?.webhook?.lastCommandAt && Date.parse(firstSnapshot.telegram.webhook.lastCommandAt) >= startedAtMs ? 1 : 0,
      },
      counters: { total: 0, healthy: 0, unhealthy: 0, databaseFailures: 0, realtimeFailures: 0, streamFailures: 0 },
      peaks: { processRssBytes: finite(firstSnapshot.system?.memory?.processRssBytes), tempFiles: temp.files, tempBytes: temp.bytes },
      result: null,
    };
    await this.persist();
    await this.capture();
    if (this.state.current?.status === "RUNNING") this.schedule();
    return this.snapshot();
  }

  schedule() {
    if (this.timer || this.state.current?.status !== "RUNNING") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.capture()
        .catch((error) => this.logger.error("StreamLab soak test sample failed.", error))
        .finally(() => this.schedule());
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async capture() {
    if (this.capturePromise) return this.capturePromise;
    this.capturePromise = this.captureOnce().finally(() => {
      this.capturePromise = null;
    });
    return this.capturePromise;
  }

  async captureOnce() {
    const run = this.state.current;
    if (!run || run.status !== "RUNNING") return this.snapshot();
    const [snapshot, temp] = await Promise.all([this.getSnapshot(), temporaryStorage(this.rootDir)]);
    const capturedAtMs = this.now();
    const databaseHealthy = !snapshot.database?.configured || snapshot.database?.connected === true;
    const realtimeHealthy = !snapshot.realtime?.configured || snapshot.realtime?.connected === true;
    const monitoringStatus = snapshot.monitoring?.status;
    const streamHealthy = !run.requirements.activeStream || (
      monitoringStatus
        ? !["CRITICAL", "OFFLINE"].includes(monitoringStatus)
        : ACTIVE_STREAM_STATUSES.has(snapshot.stream?.status)
    );
    const healthy = databaseHealthy && realtimeHealthy && streamHealthy;
    const processRssBytes = finite(snapshot.system?.memory?.processRssBytes);
    const sample = {
      capturedAt: new Date(capturedAtMs).toISOString(),
      healthy,
      streamStatus: snapshot.stream?.status || "UNKNOWN",
      streamVideoId: snapshot.stream?.videoId || null,
      isFallback: Boolean(snapshot.stream?.isFallback),
      databaseConnected: snapshot.database?.connected ?? !snapshot.database?.configured,
      realtimeConnected: snapshot.realtime?.connected ?? !snapshot.realtime?.configured,
      processRssBytes,
      processHeapUsedBytes: finite(snapshot.system?.memory?.processHeapUsedBytes),
      tempFiles: temp.files,
      tempBytes: temp.bytes,
    };
    run.samples.push(sample);
    run.samples = run.samples.slice(-12_000);
    run.latest = sample;
    run.counters.total += 1;
    run.counters[healthy ? "healthy" : "unhealthy"] += 1;
    if (!databaseHealthy) run.counters.databaseFailures += 1;
    if (!realtimeHealthy) run.counters.realtimeFailures += 1;
    if (!streamHealthy) run.counters.streamFailures += 1;
    run.peaks.processRssBytes = Math.max(run.peaks.processRssBytes, processRssBytes);
    run.peaks.tempFiles = Math.max(run.peaks.tempFiles, temp.files);
    run.peaks.tempBytes = Math.max(run.peaks.tempBytes, temp.bytes);
    if (sample.isFallback) run.coverage.fallbackObserved = true;

    const knownEvents = new Set(run.observedEventIds);
    for (const event of snapshot.monitoring?.events || []) {
      if (!event?.id || knownEvents.has(event.id) || Date.parse(event.occurredAt) < Date.parse(run.startedAt)) continue;
      knownEvents.add(event.id);
      if (event.type === "VIDEO_CHANGED") run.coverage.videoTransitions += 1;
      if (event.type === "UPLINK_RECONNECTING") run.coverage.reconnectAttempts += 1;
      if (event.type === "UPLINK_RECOVERED") run.coverage.reconnectRecoveries += 1;
    }
    run.observedEventIds = [...knownEvents].slice(-5_000);
    const impressions = (snapshot.promos?.campaigns || []).reduce((sum, item) => sum + finite(item.impressions), 0);
    run.coverage.promoImpressions = Math.max(0, impressions - run.baseline.promoImpressions);
    const commandAt = snapshot.telegram?.webhook?.lastCommandAt;
    if (commandAt && Date.parse(commandAt) >= Date.parse(run.startedAt)) run.coverage.telegramCommands = 1;
    await this.persist();

    if (capturedAtMs >= Date.parse(run.endsAt)) await this.complete();
    return this.snapshot();
  }

  async complete() {
    const run = this.state.current;
    if (!run || run.status !== "RUNNING") return this.snapshot();
    const samples = run.samples;
    const windowSize = Math.max(1, Math.min(60, Math.floor(samples.length * 0.1)));
    const firstRss = average(samples.slice(0, windowSize).map((sample) => sample.processRssBytes).filter(Boolean));
    const lastRss = average(samples.slice(-windowSize).map((sample) => sample.processRssBytes).filter(Boolean));
    const rssGrowthPercent = firstRss > 0 ? ((lastRss - firstRss) / firstRss) * 100 : 0;
    const tempGrowthBytes = finite(run.latest?.tempBytes) - run.baseline.tempBytes;
    const expectedSamples = Math.max(1, Math.floor((run.durationHours * 3_600_000) / this.intervalMs) + 1);
    const availabilityDenominator = Math.max(expectedSamples, run.counters.total);
    const availabilityPercent = (run.counters.healthy / availabilityDenominator) * 100;
    const checks = [
      { id: "sample-continuity", passed: run.counters.total >= expectedSamples * 0.995, value: run.counters.total, expected: `>= ${Math.ceil(expectedSamples * 0.995)}` },
      { id: "availability", passed: availabilityPercent >= 99.5, value: Number(availabilityPercent.toFixed(3)), expected: ">= 99.5%" },
      { id: "memory-growth", passed: rssGrowthPercent <= this.maxRssGrowthPercent, value: Number(rssGrowthPercent.toFixed(2)), expected: `<= ${this.maxRssGrowthPercent}%` },
      { id: "temp-growth", passed: tempGrowthBytes <= this.maxTempGrowthBytes, value: tempGrowthBytes, expected: `<= ${this.maxTempGrowthBytes} bytes` },
      { id: "video-transition", passed: !run.requirements.videoTransition || run.coverage.videoTransitions > 0, value: run.coverage.videoTransitions, expected: "> 0" },
      { id: "fallback", passed: !run.requirements.fallback || run.coverage.fallbackObserved, value: run.coverage.fallbackObserved, expected: true },
      { id: "reconnect", passed: !run.requirements.reconnect || run.coverage.reconnectRecoveries > 0, value: run.coverage.reconnectRecoveries, expected: "> 0" },
      { id: "promo", passed: !run.requirements.promo || run.coverage.promoImpressions > 0, value: run.coverage.promoImpressions, expected: "> 0" },
      { id: "telegram", passed: !run.requirements.telegram || run.coverage.telegramCommands > 0, value: run.coverage.telegramCommands, expected: "> 0" },
    ];
    run.completedAt = new Date(this.now()).toISOString();
    run.result = {
      passed: checks.every((check) => check.passed),
      availabilityPercent: Number(availabilityPercent.toFixed(3)),
      rssGrowthPercent: Number(rssGrowthPercent.toFixed(2)),
      tempGrowthBytes,
      checks,
    };
    run.status = run.result.passed ? "PASSED" : "FAILED";
    const archived = structuredClone(run);
    delete archived.observedEventIds;
    this.state.history.push(archived);
    this.state.history = this.state.history.slice(-10);
    await this.persist();
    return this.snapshot();
  }

  async cancel() {
    const run = this.state.current;
    if (!run || run.status !== "RUNNING") {
      throw new ApiError(409, "SOAK_TEST_NOT_RUNNING", "Активного soak test немає.");
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    run.status = "CANCELLED";
    run.completedAt = new Date(this.now()).toISOString();
    run.result = { passed: false, cancelled: true, checks: [] };
    const archived = structuredClone(run);
    delete archived.observedEventIds;
    this.state.history.push(archived);
    this.state.history = this.state.history.slice(-10);
    await this.persist();
    return this.snapshot();
  }

  async close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.capturePromise?.catch(() => {});
    await this.persistQueue.catch(() => {});
  }
}
