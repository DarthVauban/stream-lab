import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createClient } from "redis";

const CHANNEL = "streamlab:events";

export class RealtimeHub {
  constructor({ redisUrl = process.env.REDIS_URL, logger = console, maxHistory = 1_000 } = {}) {
    this.redisUrl = typeof redisUrl === "string" ? redisUrl.trim() : "";
    this.logger = logger;
    this.origin = randomUUID();
    this.events = new EventEmitter();
    this.publisher = null;
    this.subscriber = null;
    this.redisConnected = false;
    this.maxHistory = Math.max(10, Math.min(10_000, Number(maxHistory) || 1_000));
    this.history = [];
  }

  async init() {
    if (!this.redisUrl) return this.snapshot();
    this.publisher = createClient({ url: this.redisUrl });
    this.subscriber = this.publisher.duplicate();
    const onError = (error) => this.logger.error("StreamLab Redis error:", error);
    this.publisher.on("error", onError);
    this.subscriber.on("error", onError);
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    await this.subscriber.subscribe(CHANNEL, (message) => {
      try {
        const event = JSON.parse(message);
        if (event.origin !== this.origin) {
          this.remember(event);
          this.events.emit("event", event);
        }
      } catch (error) {
        this.logger.error("Invalid StreamLab realtime event:", error);
      }
    });
    this.redisConnected = true;
    return this.snapshot();
  }

  snapshot() {
    return { configured: Boolean(this.redisUrl), connected: this.redisConnected };
  }

  subscribe(listener) {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  remember(event) {
    if (!event?.id || this.history.some((item) => item.id === event.id)) return;
    this.history.push(event);
    this.history = this.history.slice(-this.maxHistory);
  }

  replaySince(lastEventId) {
    if (!lastEventId) return [];
    const index = this.history.findIndex((event) => event.id === lastEventId);
    if (index === -1) return null;
    return this.history.slice(index + 1).map((event) => structuredClone(event));
  }

  async publish(type, payload = {}) {
    const event = {
      id: randomUUID(),
      type,
      payload,
      occurredAt: new Date().toISOString(),
      origin: this.origin,
    };
    this.remember(event);
    this.events.emit("event", event);
    if (this.publisher?.isReady) await this.publisher.publish(CHANNEL, JSON.stringify(event));
    return event;
  }

  async health() {
    if (!this.publisher?.isReady) return this.snapshot();
    await this.publisher.ping();
    return this.snapshot();
  }

  async close() {
    if (this.subscriber?.isOpen) await this.subscriber.quit();
    if (this.publisher?.isOpen) await this.publisher.quit();
    this.redisConnected = false;
  }
}
