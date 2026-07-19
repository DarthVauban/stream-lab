import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));

export class PostgresDatabase {
  constructor({ connectionString = process.env.DATABASE_URL, logger = console } = {}) {
    this.connectionString = typeof connectionString === "string" ? connectionString.trim() : "";
    this.logger = logger;
    this.pool = null;
  }

  get configured() {
    return Boolean(this.connectionString);
  }

  async init() {
    if (!this.configured) return { configured: false };
    this.pool = new pg.Pool({
      connectionString: this.connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE || 10),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    await this.pool.query("SELECT 1");
    await this.migrate();
    return { configured: true };
  }

  async migrate() {
    const version = "001_foundation";
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = await this.pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version],
    );
    if (applied.rowCount) return;
    const sql = await readFile(path.join(here, "migrations", `${version}.sql`), "utf8");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
        [version],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async readDocument(key) {
    if (!this.pool) return null;
    const result = await this.pool.query(
      "SELECT payload FROM state_documents WHERE key = $1",
      [key],
    );
    return result.rows[0]?.payload ?? null;
  }

  async writeDocument(key, payload) {
    if (!this.pool) return;
    await this.pool.query(
      `INSERT INTO state_documents(key, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [key, JSON.stringify(payload)],
    );
  }

  async appendAudit({
    id = randomUUID(),
    occurredAt = new Date().toISOString(),
    actor = "owner",
    action,
    targetType = "system",
    targetId = null,
    status = "SUCCESS",
    details = {},
    correlationId = null,
  }) {
    if (!this.pool) return null;
    await this.pool.query(
      `INSERT INTO audit_log(
        id, occurred_at, actor, action, target_type, target_id, status, details, correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [id, occurredAt, actor, action, targetType, targetId, status, JSON.stringify(details), correlationId],
    );
    return { id, occurredAt, actor, action, targetType, targetId, status, details, correlationId };
  }

  async listAudit({ limit = 100 } = {}) {
    if (!this.pool) return [];
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    const result = await this.pool.query(
      `SELECT id, occurred_at, actor, action, target_type, target_id, status, details, correlation_id
       FROM audit_log ORDER BY occurred_at DESC LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at.toISOString(),
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      status: row.status,
      details: row.details,
      correlationId: row.correlation_id,
    }));
  }

  async health() {
    if (!this.pool) return { configured: false, connected: false };
    await this.pool.query("SELECT 1");
    return { configured: true, connected: true };
  }

  async close() {
    await this.pool?.end();
    this.pool = null;
  }
}
