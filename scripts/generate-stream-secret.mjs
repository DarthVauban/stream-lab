import { randomBytes } from "node:crypto";

console.log(`STREAM_CONFIG_SECRET='${randomBytes(32).toString("base64url")}'`);
