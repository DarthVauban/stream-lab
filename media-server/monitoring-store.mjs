import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_SAMPLES = 10_080;
const MAX_EVENTS = 2_000;

function emptyState() {
  return {
    samples: [],
    events: [],
    counters: {
      streamStarts: 0,
      uplinkRestarts: 0,
    },
  };
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeSample(value) {
  if (!value || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) {
    return null;
  }
  return {
    capturedAt: value.capturedAt,
    streamStatus: typeof value.streamStatus === "string" ? value.streamStatus : "STOPPED",
    healthStatus: typeof value.healthStatus === "string" ? value.healthStatus : "OFFLINE",
    videoId: typeof value.videoId === "string" ? value.videoId : null,
    videoName: typeof value.videoName === "string" ? value.videoName : null,
    bitrateKbps: optionalNumber(value.bitrateKbps),
    targetBitrateKbps: optionalNumber(value.targetBitrateKbps),
    fps: optionalNumber(value.fps),
    speed: optionalNumber(value.speed),
    droppedFrames: optionalNumber(value.droppedFrames),
    duplicateFrames: optionalNumber(value.duplicateFrames),
    reconnectAttempt: optionalNumber(value.reconnectAttempt) ?? 0,
    viewers: optionalNumber(value.viewers) ?? 0,
    youtubeHealth: typeof value.youtubeHealth === "string" ? value.youtubeHealth : null,
  };
}

function normalizeEvent(value) {
  if (!value || typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))) {
    return null;
  }
  return {
    id: typeof value.id === "string" && value.id ? value.id : randomUUID(),
    occurredAt: value.occurredAt,
    type: typeof value.type === "string" ? value.type : "SYSTEM",
    severity: ["info", "success", "warning", "critical"].includes(value.severity)
      ? value.severity
      : "info",
    message: typeof value.message === "string" ? value.message.slice(0, 500) : "Подія StreamLab",
  };
}

function normalizeState(value) {
  const state = emptyState();
  state.samples = (Array.isArray(value?.samples) ? value.samples : [])
    .map(normalizeSample)
    .filter(Boolean)
    .slice(-MAX_SAMPLES);
  state.events = (Array.isArray(value?.events) ? value.events : [])
    .map(normalizeEvent)
    .filter(Boolean)
    .slice(-MAX_EVENTS);
  state.counters.streamStarts = Math.max(0, Number(value?.counters?.streamStarts) || 0);
  state.counters.uplinkRestarts = Math.max(0, Number(value?.counters?.uplinkRestarts) || 0);
  return state;
}

export class MonitoringStore {
  constructor({ rootDir, now = () => Date.now(), repository = null } = {}) {
    if (!rootDir) throw new Error("Для моніторингу не вказано rootDir.");
    this.rootDir = rootDir;
    this.filePath = path.join(rootDir, "monitoring.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.now = now;
    this.repository = repository;
    this.documentKey = "monitoring";
    this.state = emptyState();
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true });
    let parsed = await this.repository?.readDocument?.(this.documentKey);
    if (!parsed) {
      try {
        parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.state = normalizeState(parsed);
    await this.persist();
    return this.read();
  }

  read() {
    return structuredClone(this.state);
  }

  persist() {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const payload = JSON.stringify({ schemaVersion: 1, ...this.state }, null, 2);
      await writeFile(this.tempPath, payload, "utf8");
      await rename(this.tempPath, this.filePath);
      await this.repository?.writeDocument?.(this.documentKey, JSON.parse(payload));
    });
    this.mutationQueue = operation;
    return operation;
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const result = action(this.state);
      const payload = JSON.stringify({ schemaVersion: 1, ...this.state }, null, 2);
      await writeFile(this.tempPath, payload, "utf8");
      await rename(this.tempPath, this.filePath);
      await this.repository?.writeDocument?.(this.documentKey, JSON.parse(payload));
      return result;
    });
    this.mutationQueue = operation;
    return operation;
  }

  appendSample(input) {
    const sample = normalizeSample(input);
    if (!sample) return Promise.resolve(null);
    return this.mutate((state) => {
      const previous = state.samples.at(-1);
      if (
        previous &&
        Date.parse(sample.capturedAt) - Date.parse(previous.capturedAt) < 45_000
      ) {
        state.samples[state.samples.length - 1] = sample;
      } else {
        state.samples.push(sample);
      }
      state.samples = state.samples.slice(-MAX_SAMPLES);
      return { ...sample };
    });
  }

  appendEvent(input) {
    const event = normalizeEvent({
      ...input,
      id: input?.id ?? randomUUID(),
      occurredAt: input?.occurredAt ?? new Date(this.now()).toISOString(),
    });
    if (!event) return Promise.resolve(null);
    return this.mutate((state) => {
      state.events.push(event);
      state.events = state.events.slice(-MAX_EVENTS);
      return { ...event };
    });
  }

  increment(counter) {
    if (!Object.hasOwn(this.state.counters, counter)) return Promise.resolve();
    return this.mutate((state) => {
      state.counters[counter] += 1;
    });
  }

  history({ hours = 24, limit = 160 } = {}) {
    const rangeHours = Math.max(1, Math.min(168, Number(hours) || 24));
    const since = this.now() - rangeHours * 3_600_000;
    const filtered = this.state.samples.filter((item) => Date.parse(item.capturedAt) >= since);
    if (filtered.length <= limit) return structuredClone(filtered);
    const step = filtered.length / limit;
    return Array.from({ length: limit }, (_, index) => ({
      ...filtered[Math.min(filtered.length - 1, Math.floor(index * step))],
    }));
  }

  events({ hours = 168, limit = 100 } = {}) {
    const rangeHours = Math.max(1, Math.min(168, Number(hours) || 168));
    const since = this.now() - rangeHours * 3_600_000;
    return this.state.events
      .filter((item) => Date.parse(item.occurredAt) >= since)
      .slice(-Math.max(1, Math.min(200, Number(limit) || 100)))
      .reverse()
      .map((item) => ({ ...item }));
  }
}
