import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createClient } from "redis";

const CHANNEL = "streamlab:events";

export class RealtimeHub {
  constructor({ redisUrl = process.env.REDIS_URL, logger = console } = {}) {
    this.redisUrl = typeof redisUrl === "string" ? redisUrl.trim() : "";
    this.logger = logger;
    this.origin = randomUUID();
    this.events = new EventEmitter();
    this.publisher = null;
    this.subscriber = null;
    this.redisConnected = false;
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
        if (event.origin !== this.origin) this.events.emit("event", event);
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

  async publish(type, payload = {}) {
    const event = {
      id: randomUUID(),
      type,
      payload,
      occurredAt: new Date().toISOString(),
      origin: this.origin,
    };
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
