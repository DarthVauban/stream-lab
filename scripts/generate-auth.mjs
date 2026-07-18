import { randomBytes } from "node:crypto";
import { hashPassword } from "../media-server/auth.mjs";

const password = process.env.OWNER_PASSWORD;

if (!password) {
  console.error("Задайте OWNER_PASSWORD у поточному терміналі й повторіть команду.");
  process.exit(1);
}

console.log(`OWNER_PASSWORD_HASH='${hashPassword(password)}'`);
console.log(`SESSION_SECRET='${randomBytes(32).toString("base64url")}'`);
console.log(`STREAM_CONFIG_SECRET='${randomBytes(32).toString("base64url")}'`);
