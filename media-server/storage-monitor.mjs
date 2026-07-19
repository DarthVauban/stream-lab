import { statfs } from "node:fs/promises";

function percent(value) {
  return Math.min(100, Math.max(0, Number(value.toFixed(1))));
}

export class StorageMonitor {
  constructor({
    path,
    warningPercent = Number(process.env.STORAGE_WARNING_PERCENT || 80),
    criticalPercent = Number(process.env.STORAGE_CRITICAL_PERCENT || 90),
    statfsImpl = statfs,
    now = () => Date.now(),
  } = {}) {
    if (!path) throw new Error("StorageMonitor requires a path.");
    this.path = path;
    this.warningPercent = Number.isFinite(warningPercent) ? warningPercent : 80;
    this.criticalPercent = Number.isFinite(criticalPercent) ? criticalPercent : 90;
    this.statfsImpl = statfsImpl;
    this.now = now;
    this.last = null;
  }

  async snapshot({ refresh = true } = {}) {
    if (!refresh && this.last) return { ...this.last };
    const stats = await this.statfsImpl(this.path, { bigint: true });
    const totalBytes = Number(stats.blocks * stats.bsize);
    const freeBytes = Number(stats.bavail * stats.bsize);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const percentUsed = totalBytes > 0 ? percent((usedBytes / totalBytes) * 100) : 0;
    const level = percentUsed >= this.criticalPercent
      ? "CRITICAL"
      : percentUsed >= this.warningPercent
        ? "WARNING"
        : "OK";
    this.last = {
      totalBytes,
      freeBytes,
      usedBytes,
      percentUsed,
      level,
      warningPercent: this.warningPercent,
      criticalPercent: this.criticalPercent,
      updatedAt: new Date(this.now()).toISOString(),
    };
    return { ...this.last };
  }
}
