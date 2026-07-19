import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./api-error.mjs";

const ZONES = new Set([
  "top-left", "top-center", "top-right",
  "center-left", "center", "center-right",
  "bottom-left", "bottom-center", "bottom-right", "fullscreen",
  "custom",
]);
const ANIMATIONS = new Set(["none", "fade", "slide", "scale", "pop"]);
const CAMPAIGN_STATUSES = new Set(["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]);

function numberInRange(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

export function normalizePromoPlacement(value = {}) {
  const width = Math.round(numberInRange(value.width, 384, 32, 1_920));
  const height = Math.round(numberInRange(value.height, 216, 32, 1_080));
  return {
    x: Math.round(numberInRange(value.x, 1_476, 0, Math.max(0, 1_920 - width))),
    y: Math.round(numberInRange(value.y, 54, 0, Math.max(0, 1_080 - height))),
    width,
    height,
    opacity: Number(numberInRange(value.opacity, 1, 0.05, 1).toFixed(2)),
    zIndex: Math.round(numberInRange(value.zIndex, 1, 0, 20)),
    zone: ZONES.has(value.zone) ? value.zone : "top-right",
    animation: ANIMATIONS.has(value.animation) ? value.animation : "fade",
  };
}

function cleanTags(value) {
  const tags = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(tags.map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

function normalizeAsset(value) {
  if (typeof value?.id !== "string" || typeof value.fileName !== "string") return null;
  return {
    id: value.id,
    name: String(value.name || "Промоматеріал").trim().slice(0, 120),
    fileName: path.basename(value.fileName),
    sourceMimeType: typeof value.sourceMimeType === "string" ? value.sourceMimeType : "image/png",
    mimeType: "image/webp",
    size: Math.max(0, Number(value.size) || 0),
    width: Math.max(1, Number(value.width) || 1),
    height: Math.max(1, Number(value.height) || 1),
    tags: cleanTags(value.tags),
    placement: normalizePromoPlacement(value.placement),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    impressions: Math.max(0, Number(value.impressions) || 0),
    lastShownAt: typeof value.lastShownAt === "string" ? value.lastShownAt : null,
  };
}

function normalizeCampaign(value) {
  if (typeof value?.id !== "string" || typeof value.assetId !== "string") return null;
  return {
    id: value.id,
    name: String(value.name || "Промокампанія").trim().slice(0, 120),
    assetId: value.assetId,
    status: CAMPAIGN_STATUSES.has(value.status) ? value.status : "DRAFT",
    startAt: typeof value.startAt === "string" && value.startAt ? value.startAt : null,
    endAt: typeof value.endAt === "string" && value.endAt ? value.endAt : null,
    intervalMinutes: Math.round(numberInRange(value.intervalMinutes, 30, 1, 1_440)),
    durationSeconds: Math.round(numberInRange(value.durationSeconds, 10, 1, 3_600)),
    daysOfWeek: (Array.isArray(value.daysOfWeek) ? value.daysOfWeek : [0, 1, 2, 3, 4, 5, 6])
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    timezone: typeof value.timezone === "string" ? value.timezone.slice(0, 80) : "Europe/Kyiv",
    priority: Math.round(numberInRange(value.priority, 0, 0, 100)),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    lastShownAt: typeof value.lastShownAt === "string" ? value.lastShownAt : null,
    impressions: Math.max(0, Number(value.impressions) || 0),
  };
}

function publicAsset(asset) {
  const version = asset.updatedAt || asset.createdAt;
  return { ...structuredClone(asset), fileUrl: `/api/promo-assets/${asset.id}/file?v=${encodeURIComponent(version)}` };
}

export class PromoStore {
  constructor({ rootDir, repository = null } = {}) {
    if (!rootDir) throw new Error("PromoStore requires rootDir.");
    this.rootDir = rootDir;
    this.assetsDir = path.join(rootDir, "promo-assets");
    this.filePath = path.join(rootDir, "promos.json");
    this.tempPath = `${this.filePath}.tmp`;
    this.repository = repository;
    this.documentKey = "promos";
    this.assets = [];
    this.campaigns = [];
    this.impressions = [];
    this.mutationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.assetsDir, { recursive: true });
    let parsed = await this.repository?.readDocument?.(this.documentKey);
    if (!parsed) {
      try {
        parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.assets = (Array.isArray(parsed?.assets) ? parsed.assets : []).map(normalizeAsset).filter(Boolean);
    this.campaigns = (Array.isArray(parsed?.campaigns) ? parsed.campaigns : []).map(normalizeCampaign).filter(Boolean);
    this.impressions = (Array.isArray(parsed?.impressions) ? parsed.impressions : [])
      .filter((item) => typeof item?.id === "string" && typeof item?.assetId === "string")
      .slice(-5_000);
    await this.persist();
    return this.snapshot();
  }

  payload() {
    return { schemaVersion: 1, assets: this.assets, campaigns: this.campaigns, impressions: this.impressions };
  }

  async persist() {
    const state = this.payload();
    await writeFile(this.tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(this.tempPath, this.filePath);
    await this.repository?.writeDocument?.(this.documentKey, state);
  }

  mutate(action) {
    const operation = this.mutationQueue.catch(() => {}).then(async () => {
      const result = action();
      await this.persist();
      return result;
    });
    this.mutationQueue = operation;
    return operation;
  }

  requireAsset(id) {
    const asset = this.assets.find((item) => item.id === id);
    if (!asset) throw new ApiError(404, "PROMO_ASSET_NOT_FOUND", "Промоматеріал не знайдено.");
    return asset;
  }

  requireCampaign(id) {
    const campaign = this.campaigns.find((item) => item.id === id);
    if (!campaign) throw new ApiError(404, "PROMO_CAMPAIGN_NOT_FOUND", "Промокампанію не знайдено.");
    return campaign;
  }

  assetPath(assetOrId) {
    const asset = typeof assetOrId === "string" ? this.requireAsset(assetOrId) : assetOrId;
    return path.join(this.assetsDir, path.basename(asset.fileName));
  }

  uploadPath(id) {
    return path.join(this.assetsDir, `${id}.upload.tmp`);
  }

  convertedPath(id) {
    return path.join(this.assetsDir, `${id}.tmp.webp`);
  }

  finalPath(id) {
    return path.join(this.assetsDir, `${id}.webp`);
  }

  listAssets() {
    return this.assets.map(publicAsset).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  createAsset(input) {
    return this.mutate(() => {
      const now = new Date().toISOString();
      const asset = normalizeAsset({
        ...input,
        id: input.id || randomUUID(),
        fileName: input.fileName,
        createdAt: now,
        updatedAt: now,
      });
      if (!asset) throw new ApiError(400, "INVALID_PROMO_ASSET", "Некоректний промоматеріал.");
      this.assets.push(asset);
      return publicAsset(asset);
    });
  }

  updateAsset(id, changes) {
    return this.mutate(() => {
      const asset = this.requireAsset(id);
      if (typeof changes.name === "string" && changes.name.trim()) asset.name = changes.name.trim().slice(0, 120);
      if (changes.tags !== undefined) asset.tags = cleanTags(changes.tags);
      if (changes.placement) asset.placement = normalizePromoPlacement({ ...asset.placement, ...changes.placement });
      asset.updatedAt = new Date().toISOString();
      return publicAsset(asset);
    });
  }

  removeAsset(id) {
    return this.mutate(() => {
      if (this.campaigns.some((campaign) => campaign.assetId === id && campaign.status !== "ARCHIVED")) {
        throw new ApiError(409, "PROMO_ASSET_IN_USE", "Спочатку видаліть або архівуйте пов’язані кампанії.");
      }
      const index = this.assets.findIndex((item) => item.id === id);
      if (index < 0) throw new ApiError(404, "PROMO_ASSET_NOT_FOUND", "Промоматеріал не знайдено.");
      return this.assets.splice(index, 1)[0];
    });
  }

  listCampaigns() {
    return this.campaigns.map((campaign) => ({ ...structuredClone(campaign) }));
  }

  createCampaign(input) {
    return this.mutate(() => {
      this.requireAsset(input.assetId);
      const now = new Date().toISOString();
      const campaign = normalizeCampaign({ ...input, id: randomUUID(), createdAt: now, updatedAt: now });
      this.campaigns.push(campaign);
      return structuredClone(campaign);
    });
  }

  updateCampaign(id, changes) {
    return this.mutate(() => {
      const current = this.requireCampaign(id);
      const next = normalizeCampaign({ ...current, ...changes, id: current.id, updatedAt: new Date().toISOString() });
      this.requireAsset(next.assetId);
      Object.assign(current, next);
      return structuredClone(current);
    });
  }

  removeCampaign(id) {
    return this.mutate(() => {
      const index = this.campaigns.findIndex((item) => item.id === id);
      if (index < 0) throw new ApiError(404, "PROMO_CAMPAIGN_NOT_FOUND", "Промокампанію не знайдено.");
      return this.campaigns.splice(index, 1)[0];
    });
  }

  markShown({ assetId, campaignId = null, source = "SPA", startedAt, durationSeconds }) {
    return this.mutate(() => {
      const asset = this.requireAsset(assetId);
      asset.impressions += 1;
      asset.lastShownAt = startedAt;
      asset.updatedAt = startedAt;
      if (campaignId) {
        const campaign = this.requireCampaign(campaignId);
        campaign.impressions += 1;
        campaign.lastShownAt = startedAt;
        campaign.updatedAt = startedAt;
      }
      const impression = {
        id: randomUUID(),
        assetId,
        campaignId,
        source,
        startedAt,
        durationSeconds,
      };
      this.impressions.push(impression);
      this.impressions = this.impressions.slice(-5_000);
      return structuredClone(impression);
    });
  }

  snapshot() {
    return {
      assets: this.listAssets(),
      campaigns: this.listCampaigns(),
      impressions: structuredClone(this.impressions.slice(-50).reverse()),
    };
  }
}
