const ACTIVE_STREAM_STATUSES = new Set(["STARTING", "LIVE", "DEGRADED", "RECONNECTING", "STOPPING"]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function highestStatus(statuses) {
  if (statuses.includes("CRITICAL")) return "CRITICAL";
  if (statuses.includes("BUFFERING_RISK")) return "BUFFERING_RISK";
  return "STABLE";
}

export function evaluateStreamHealth({ stream = {}, youtube = {}, now = Date.now(), previousSample = null } = {}) {
  const status = stream.status || "STOPPED";
  if (status === "STOPPED") {
    return { status: "OFFLINE", reason: "Ефір не запущено.", issues: [] };
  }
  if (status === "ERROR") {
    return {
      status: "CRITICAL",
      reason: stream.lastError || "Стрім завершився з помилкою.",
      issues: ["stream_error"],
    };
  }
  if (status === "RECONNECTING") {
    return {
      status: "CRITICAL",
      reason: "RTMPS-з’єднання втрачено. StreamLab намагається його відновити.",
      issues: ["uplink_reconnecting"],
    };
  }

  const issues = [];
  const statuses = [];
  const metrics = stream.outputMetrics;
  const startedAtMs = Date.parse(stream.startedAt || "");
  const runtimeMs = Number.isFinite(startedAtMs) ? now - startedAtMs : 0;

  if (status === "STARTING") {
    issues.push("stream_starting");
    statuses.push("BUFFERING_RISK");
  }
  if (status === "DEGRADED") {
    issues.push("playout_degraded");
    statuses.push("BUFFERING_RISK");
  }

  if (!metrics && runtimeMs > 30_000) {
    issues.push("metrics_missing");
    statuses.push("CRITICAL");
  } else if (metrics) {
    const capturedAtMs = Date.parse(metrics.capturedAt || "");
    if (Number.isFinite(capturedAtMs) && now - capturedAtMs > 30_000) {
      issues.push("metrics_stale");
      statuses.push("CRITICAL");
    }
    const speed = numberOrNull(metrics.speed);
    if (speed !== null && speed < 0.9) {
      issues.push("speed_critical");
      statuses.push("CRITICAL");
    } else if (speed !== null && speed < 0.98) {
      issues.push("speed_low");
      statuses.push("BUFFERING_RISK");
    }
    const bitrate = numberOrNull(metrics.bitrateKbps);
    const targetBitrate = numberOrNull(stream.videoBitrateKbps);
    if (bitrate !== null && targetBitrate) {
      const ratio = bitrate / targetBitrate;
      if (ratio < 0.55) {
        issues.push("bitrate_critical");
        statuses.push("CRITICAL");
      } else if (ratio < 0.8) {
        issues.push("bitrate_low");
        statuses.push("BUFFERING_RISK");
      }
    }
    const fps = numberOrNull(metrics.fps);
    if (fps !== null && fps < 20) {
      issues.push("fps_critical");
      statuses.push("CRITICAL");
    } else if (fps !== null && fps < 28) {
      issues.push("fps_low");
      statuses.push("BUFFERING_RISK");
    }
    const droppedFrames = numberOrNull(metrics.droppedFrames);
    const previousDroppedFrames = numberOrNull(previousSample?.droppedFrames);
    if (
      droppedFrames !== null &&
      previousDroppedFrames !== null &&
      droppedFrames > previousDroppedFrames
    ) {
      issues.push("frames_dropped");
      statuses.push("BUFFERING_RISK");
    }
  }

  if (youtube.connected && youtube.stream?.healthStatus === "bad") {
    issues.push("youtube_health_bad");
    statuses.push("CRITICAL");
  } else if (youtube.connected && youtube.stream?.healthStatus === "ok") {
    issues.push("youtube_health_warning");
    statuses.push("BUFFERING_RISK");
  }
  if (youtube.connected && youtube.stream?.configurationIssues?.length) {
    const critical = youtube.stream.configurationIssues.some((issue) =>
      ["error", "critical"].includes(String(issue.severity).toLowerCase()),
    );
    issues.push("youtube_configuration_issue");
    statuses.push(critical ? "CRITICAL" : "BUFFERING_RISK");
  }

  const healthStatus = highestStatus(statuses);
  const reasons = {
    STABLE: "Бітрейт, частота кадрів і швидкість кодування в нормі.",
    BUFFERING_RISK: "Один або кілька показників можуть спричинити буферизацію.",
    CRITICAL: "Сигнал потребує уваги: стабільна передача не підтверджена.",
  };
  return { status: healthStatus, reason: reasons[healthStatus], issues };
}

export class MonitoringService {
  constructor({
    controller,
    youtube,
    store,
    now = () => Date.now(),
    pollIntervalMs = 5_000,
    sampleIntervalMs = 60_000,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    onEvent = async () => {},
  } = {}) {
    if (!controller || !store) throw new Error("Для моніторингу потрібні controller і store.");
    this.controller = controller;
    this.youtube = youtube;
    this.store = store;
    this.now = now;
    this.pollIntervalMs = pollIntervalMs;
    this.sampleIntervalMs = sampleIntervalMs;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.onEvent = onEvent;
    this.interval = null;
    this.previous = null;
    this.lastSampleAt = 0;
    this.captureQueue = Promise.resolve();
  }

  async init() {
    const saved = await this.store.init();
    this.lastSampleAt = Date.parse(saved.samples.at(-1)?.capturedAt || "") || 0;
    await this.capture({ forceSample: saved.samples.length === 0 });
    return this.snapshot();
  }

  start() {
    if (this.interval) return;
    this.interval = this.setIntervalImpl(() => {
      void this.capture().catch((error) => {
        console.error("StreamLab monitoring capture failed.", error);
      });
    }, this.pollIntervalMs);
    this.interval?.unref?.();
  }

  async stop() {
    if (this.interval) this.clearIntervalImpl(this.interval);
    this.interval = null;
    await this.captureQueue.catch(() => {});
  }

  currentState() {
    const stream = this.controller.snapshot?.() || {};
    const youtube = this.youtube?.snapshot?.() || {};
    const previousSample = this.store.read().samples.at(-1) || null;
    const health = evaluateStreamHealth({ stream, youtube, now: this.now(), previousSample });
    return { stream, youtube, health };
  }

  makeSample(current, capturedAt = new Date(this.now()).toISOString()) {
    const metrics = current.stream.outputMetrics || {};
    return {
      capturedAt,
      streamStatus: current.stream.status || "STOPPED",
      healthStatus: current.health.status,
      videoId: current.stream.videoId || null,
      videoName: current.stream.videoName || null,
      bitrateKbps: numberOrNull(metrics.bitrateKbps),
      targetBitrateKbps: numberOrNull(current.stream.videoBitrateKbps),
      fps: numberOrNull(metrics.fps),
      speed: numberOrNull(metrics.speed),
      droppedFrames: numberOrNull(metrics.droppedFrames),
      duplicateFrames: numberOrNull(metrics.duplicateFrames),
      reconnectAttempt: numberOrNull(current.stream.reconnectAttempt) ?? 0,
      viewers: numberOrNull(current.youtube.metrics?.viewers) ?? 0,
      youtubeHealth: current.youtube.stream?.healthStatus || null,
    };
  }

  async event(type, severity, message, occurredAt) {
    const event = await this.store.appendEvent({ type, severity, message, occurredAt });
    if (event) await this.onEvent(event);
    return event;
  }

  capture({ forceSample = false } = {}) {
    const operation = this.captureQueue.catch(() => {}).then(async () => {
      const current = this.currentState();
      const capturedAt = new Date(this.now()).toISOString();
      const previous = this.previous;
      const currentActive = ACTIVE_STREAM_STATUSES.has(current.stream.status);
      const previousActive = ACTIVE_STREAM_STATUSES.has(previous?.stream.status);

      if (previous) {
        if (!previousActive && currentActive) {
          await this.store.increment("streamStarts");
          await this.event("STREAM_STARTED", "success", "Трансляцію запущено.", capturedAt);
        } else if (previousActive && current.stream.status === "STOPPED") {
          await this.event("STREAM_STOPPED", "info", "Трансляцію зупинено.", capturedAt);
        }
        if (current.stream.status === "RECONNECTING" && previous.stream.status !== "RECONNECTING") {
          await this.store.increment("uplinkRestarts");
          await this.event(
            "UPLINK_RECONNECTING",
            "critical",
            "RTMPS-з’єднання втрачено. Запущено автоматичне відновлення.",
            capturedAt,
          );
        }
        if (previous.stream.status === "RECONNECTING" && current.stream.status === "LIVE") {
          await this.event("UPLINK_RECOVERED", "success", "RTMPS-з’єднання відновлено.", capturedAt);
        }
        if (
          previous.stream.videoId &&
          current.stream.videoId &&
          previous.stream.videoId !== current.stream.videoId
        ) {
          await this.event(
            "VIDEO_CHANGED",
            "info",
            `Розпочато відтворення: ${current.stream.videoName || "наступне відео"}.`,
            capturedAt,
          );
        }
        if (previous.health.status !== current.health.status) {
          if (["BUFFERING_RISK", "CRITICAL"].includes(current.health.status)) {
            await this.event(
              "STREAM_HEALTH_CHANGED",
              current.health.status === "CRITICAL" ? "critical" : "warning",
              current.health.reason,
              capturedAt,
            );
          } else if (
            current.health.status === "STABLE" &&
            ["BUFFERING_RISK", "CRITICAL"].includes(previous.health.status)
          ) {
            await this.event("STREAM_HEALTH_RECOVERED", "success", current.health.reason, capturedAt);
          }
        }
      }

      if (forceSample || this.now() - this.lastSampleAt >= this.sampleIntervalMs) {
        await this.store.appendSample(this.makeSample(current, capturedAt));
        this.lastSampleAt = this.now();
      }
      this.previous = current;
      return current;
    });
    this.captureQueue = operation;
    return operation;
  }

  snapshot({ hours = 24 } = {}) {
    const rangeHours = Math.max(1, Math.min(168, Number(hours) || 24));
    const current = this.currentState();
    const history = this.store.history({ hours: rangeHours });
    const events = this.store.events({ hours: Math.max(rangeHours, 24), limit: 100 });
    const saved = this.store.read();
    const startedAtMs = Date.parse(current.stream.startedAt || "");
    const sessionSince = Number.isFinite(startedAtMs) ? startedAtMs : this.now() - rangeHours * 3_600_000;
    const sessionSamples = saved.samples.filter((item) => Date.parse(item.capturedAt) >= sessionSince);
    const sessionEvents = saved.events.filter((item) => Date.parse(item.occurredAt) >= sessionSince);
    const output = current.stream.outputMetrics || {};
    return {
      status: current.health.status,
      reason: current.health.reason,
      issues: [...current.health.issues],
      updatedAt: new Date(this.now()).toISOString(),
      rangeHours,
      current: {
        streamStatus: current.stream.status || "STOPPED",
        bitrateKbps: numberOrNull(output.bitrateKbps),
        targetBitrateKbps: numberOrNull(current.stream.videoBitrateKbps),
        fps: numberOrNull(output.fps),
        speed: numberOrNull(output.speed),
        droppedFrames: numberOrNull(output.droppedFrames) ?? 0,
        duplicateFrames: numberOrNull(output.duplicateFrames) ?? 0,
        reconnectAttempt: numberOrNull(current.stream.reconnectAttempt) ?? 0,
        metricsCapturedAt: output.capturedAt || null,
        youtubeHealth: current.youtube.stream?.healthStatus || null,
        viewers: numberOrNull(current.youtube.metrics?.viewers) ?? 0,
      },
      session: {
        startedAt: current.stream.startedAt || null,
        uptimeMs: ACTIVE_STREAM_STATUSES.has(current.stream.status) && Number.isFinite(startedAtMs)
          ? Math.max(0, this.now() - startedAtMs)
          : 0,
        restarts: sessionEvents.filter((item) => item.type === "UPLINK_RECONNECTING").length,
        peakViewers: Math.max(
          numberOrNull(current.youtube.metrics?.viewers) ?? 0,
          ...sessionSamples.map((item) => item.viewers || 0),
        ),
        totalStreamStarts: saved.counters.streamStarts,
        totalUplinkRestarts: saved.counters.uplinkRestarts,
      },
      history,
      events,
    };
  }
}
