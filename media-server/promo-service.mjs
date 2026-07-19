import { randomUUID } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { ApiError } from "./api-error.mjs";
import { convertImageToWebp, probeImage } from "./image-processor.mjs";

const WEEKDAYS = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6],
]);

function dayInTimezone(timestamp, timezone) {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(new Date(timestamp));
    return WEEKDAYS.get(name) ?? new Date(timestamp).getUTCDay();
  } catch {
    return new Date(timestamp).getUTCDay();
  }
}

export class PromoService {
  constructor({
    store,
    ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
    ffprobePath = process.env.FFPROBE_PATH || "ffprobe",
    convertImpl = convertImageToWebp,
    probeImpl = probeImage,
    onEvent = () => {},
    onOverlayChange = () => {},
    isStreamActive = () => false,
    now = () => Date.now(),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    logger = console,
  } = {}) {
    if (!store) throw new Error("PromoService requires PromoStore.");
    this.store = store;
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
    this.convertImpl = convertImpl;
    this.probeImpl = probeImpl;
    this.onEvent = onEvent;
    this.onOverlayChange = onOverlayChange;
    this.isStreamActive = isStreamActive;
    this.now = now;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.logger = logger;
    this.active = null;
    this.activeTimer = null;
    this.schedulerTimer = null;
    this.tickPromise = null;
  }

  async init() {
    await this.store.init();
    return this.snapshot();
  }

  start() {
    if (this.schedulerTimer) return;
    this.schedulerTimer = this.setIntervalImpl(() => {
      void this.tick().catch((error) => this.logger.error("StreamLab promo scheduler failed.", error));
    }, 1_000);
    this.schedulerTimer.unref?.();
  }

  async createAsset({ name, tags, buffer, sourceMimeType }) {
    const id = randomUUID();
    const inputPath = this.store.uploadPath(id);
    const convertedPath = this.store.convertedPath(id);
    const finalPath = this.store.finalPath(id);
    try {
      await writeFile(inputPath, buffer, { flag: "wx" });
      await this.convertImpl({
        inputPath,
        outputPath: convertedPath,
        mode: "promo",
        ffmpegPath: this.ffmpegPath,
      });
      const dimensions = await this.probeImpl({ inputPath: convertedPath, ffprobePath: this.ffprobePath });
      await rename(convertedPath, finalPath);
      const fileStatus = await stat(finalPath);
      const ratio = dimensions.width / dimensions.height;
      const width = Math.min(640, dimensions.width);
      const height = Math.max(32, Math.round(width / ratio));
      const asset = await this.store.createAsset({
        id,
        name,
        tags,
        fileName: `${id}.webp`,
        sourceMimeType,
        size: fileStatus.size,
        width: dimensions.width,
        height: dimensions.height,
        placement: { width, height },
      });
      await this.onEvent("PROMO_ASSET_CREATED", { assetId: id });
      return asset;
    } catch (error) {
      await Promise.all([
        rm(inputPath, { force: true }).catch(() => {}),
        rm(convertedPath, { force: true }).catch(() => {}),
        rm(finalPath, { force: true }).catch(() => {}),
      ]);
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, "PROMO_CONVERSION_FAILED", "Не вдалося конвертувати промоматеріал у WebP.");
    } finally {
      await rm(inputPath, { force: true }).catch(() => {});
    }
  }

  async updateAsset(id, changes) {
    const asset = await this.store.updateAsset(id, changes);
    if (this.active?.assetId === id) {
      this.active = { ...this.active, placement: asset.placement };
      await this.applyOverlay();
    }
    await this.onEvent("PROMO_ASSET_UPDATED", { assetId: id });
    return asset;
  }

  async deleteAsset(id) {
    if (this.active?.assetId === id) await this.hide({ source: "SYSTEM" });
    const asset = await this.store.removeAsset(id);
    await rm(this.store.assetPath(asset), { force: true });
    await this.onEvent("PROMO_ASSET_DELETED", { assetId: id });
    return asset;
  }

  activeOverlay() {
    if (!this.active) return [];
    const asset = this.store.requireAsset(this.active.assetId);
    return [{
      id: asset.id,
      filePath: this.store.assetPath(asset),
      placement: { ...asset.placement },
    }];
  }

  async applyOverlay() {
    await this.onOverlayChange(this.activeOverlay());
  }

  async show(assetId, { durationSeconds = 10, source = "SPA", campaignId = null } = {}) {
    if (!this.isStreamActive()) {
      throw new ApiError(409, "STREAM_NOT_ACTIVE", "Запустіть трансляцію перед показом промоматеріалу.");
    }
    const asset = this.store.requireAsset(assetId);
    const duration = Math.round(Math.min(3_600, Math.max(1, Number(durationSeconds) || 10)));
    if (this.activeTimer) this.clearTimeoutImpl(this.activeTimer);
    const requestedAtMs = this.now();
    this.active = {
      assetId: asset.id,
      campaignId,
      source,
      startedAt: new Date(requestedAtMs).toISOString(),
      endsAt: new Date(requestedAtMs + duration * 1_000).toISOString(),
      durationSeconds: duration,
      placement: { ...asset.placement },
    };
    try {
      await this.applyOverlay();
    } catch (error) {
      this.active = null;
      throw error;
    }
    const startedAtMs = this.now();
    this.active = {
      ...this.active,
      startedAt: new Date(startedAtMs).toISOString(),
      endsAt: new Date(startedAtMs + duration * 1_000).toISOString(),
    };
    await this.store.markShown({
      assetId,
      campaignId,
      source,
      startedAt: this.active.startedAt,
      durationSeconds: duration,
    });
    await this.onEvent("PROMO_SHOWN", { ...this.active });
    this.activeTimer = this.setTimeoutImpl(() => {
      this.activeTimer = null;
      void this.hide({ source: "TIMER" }).catch((error) => this.logger.error("StreamLab promo hide failed.", error));
    }, duration * 1_000);
    this.activeTimer.unref?.();
    return this.snapshot();
  }

  async hide({ source = "SPA" } = {}) {
    if (this.activeTimer) this.clearTimeoutImpl(this.activeTimer);
    this.activeTimer = null;
    const previous = this.active;
    this.active = null;
    if (previous && this.isStreamActive()) await this.applyOverlay();
    if (previous) await this.onEvent("PROMO_HIDDEN", { ...previous, hiddenBy: source });
    return this.snapshot();
  }

  createCampaign(input) {
    return this.store.createCampaign(input);
  }

  updateCampaign(id, input) {
    return this.store.updateCampaign(id, input);
  }

  removeCampaign(id) {
    return this.store.removeCampaign(id);
  }

  isDue(campaign, timestamp) {
    if (!["ACTIVE", "SCHEDULED"].includes(campaign.status)) return false;
    if (campaign.startAt && new Date(campaign.startAt).getTime() > timestamp) return false;
    if (campaign.endAt && new Date(campaign.endAt).getTime() <= timestamp) return false;
    if (!campaign.daysOfWeek.includes(dayInTimezone(timestamp, campaign.timezone))) return false;
    const lastShownAt = campaign.lastShownAt ? new Date(campaign.lastShownAt).getTime() : 0;
    return !lastShownAt || timestamp - lastShownAt >= campaign.intervalMinutes * 60_000;
  }

  async tick() {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      if (this.active || !this.isStreamActive()) return;
      const timestamp = this.now();
      const due = this.store.listCampaigns()
        .filter((campaign) => this.isDue(campaign, timestamp))
        .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0];
      if (!due) return;
      if (due.status === "SCHEDULED") await this.store.updateCampaign(due.id, { status: "ACTIVE" });
      await this.show(due.assetId, {
        durationSeconds: due.durationSeconds,
        source: "SCHEDULER",
        campaignId: due.id,
      });
    })().finally(() => {
      this.tickPromise = null;
    });
    return this.tickPromise;
  }

  snapshot() {
    const base = this.store.snapshot();
    const active = this.active
      ? { ...structuredClone(this.active), asset: base.assets.find((asset) => asset.id === this.active.assetId) || null }
      : null;
    return { ...base, active };
  }

  async stop() {
    if (this.schedulerTimer) this.clearIntervalImpl(this.schedulerTimer);
    if (this.activeTimer) this.clearTimeoutImpl(this.activeTimer);
    this.schedulerTimer = null;
    this.activeTimer = null;
    await this.tickPromise?.catch(() => {});
  }
}
