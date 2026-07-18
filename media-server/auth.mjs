import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { ApiError } from "./api-error.mjs";

const COOKIE_NAME = "streamlab_session";
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;
const HASH_KEY_LENGTH = 64;
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function readHash(passwordHash) {
  const [algorithm, cost, blockSize, parallelization, salt, expected] = String(
    passwordHash ?? "",
  ).split("$");
  if (
    algorithm !== "scrypt" ||
    Number(cost) !== SCRYPT_COST ||
    Number(blockSize) !== SCRYPT_BLOCK_SIZE ||
    Number(parallelization) !== SCRYPT_PARALLELIZATION ||
    !salt ||
    !expected
  ) {
    throw new Error("OWNER_PASSWORD_HASH має некоректний формат.");
  }
  return { salt, expected };
}

export function hashPassword(password, salt = randomBytes(16).toString("base64url")) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Пароль OWNER повинен містити щонайменше 12 символів.");
  }
  const derived = scryptSync(password, salt, HASH_KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt}$${derived.toString("base64url")}`;
}

function verifyPassword(password, passwordHash) {
  const { salt, expected } = readHash(passwordHash);
  const actual = scryptSync(String(password ?? ""), salt, HASH_KEY_LENGTH, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });
  return safeEqual(actual, fromBase64Url(expected));
}

export function createOwnerAuth({
  username = process.env.OWNER_USERNAME || "owner",
  passwordHash = process.env.OWNER_PASSWORD_HASH,
  sessionSecret = process.env.SESSION_SECRET,
  cookieSecure = process.env.AUTH_COOKIE_SECURE === "true",
  sessionTtlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS),
  now = () => Date.now(),
} = {}) {
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(username)) {
    throw new Error("OWNER_USERNAME має некоректний формат.");
  }
  readHash(passwordHash);
  if (typeof sessionSecret !== "string" || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET повинен містити щонайменше 32 символи.");
  }
  if (!Number.isFinite(sessionTtlSeconds) || sessionTtlSeconds < 300) {
    throw new Error("AUTH_SESSION_TTL_SECONDS повинен бути не меншим за 300.");
  }

  const attempts = new Map();
  const maxAttempts = 5;
  const attemptWindowMs = 15 * 60 * 1000;

  function sign(encodedPayload) {
    return createHmac("sha256", sessionSecret).update(encodedPayload).digest("base64url");
  }

  function cookie(value, maxAge = sessionTtlSeconds) {
    const parts = [
      `${COOKIE_NAME}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${maxAge}`,
    ];
    if (cookieSecure) parts.push("Secure");
    return parts.join("; ");
  }

  function createSession() {
    const issuedAt = Math.floor(now() / 1000);
    const payload = {
      sub: username,
      iat: issuedAt,
      exp: issuedAt + sessionTtlSeconds,
      csrf: randomBytes(24).toString("base64url"),
    };
    const encoded = toBase64Url(JSON.stringify(payload));
    return {
      token: `${encoded}.${sign(encoded)}`,
      owner: username,
      csrfToken: payload.csrf,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  function authenticate(request) {
    const token = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    if (!token) return null;
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded))) return null;
    try {
      const payload = JSON.parse(fromBase64Url(encoded).toString("utf8"));
      if (
        payload.sub !== username ||
        !Number.isFinite(payload.exp) ||
        payload.exp <= Math.floor(now() / 1000) ||
        typeof payload.csrf !== "string"
      ) {
        return null;
      }
      return {
        owner: payload.sub,
        csrfToken: payload.csrf,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      };
    } catch {
      return null;
    }
  }

  function assertAuthenticated(request, { requireCsrf = false } = {}) {
    const session = authenticate(request);
    if (!session) {
      throw new ApiError(401, "AUTH_REQUIRED", "Увійдіть як OWNER, щоб продовжити.");
    }
    if (requireCsrf && !safeEqual(request.headers["x-csrf-token"] ?? "", session.csrfToken)) {
      throw new ApiError(403, "INVALID_CSRF_TOKEN", "Захисний токен застарів. Увійдіть повторно.");
    }
    return session;
  }

  function login(clientId, inputUsername, password) {
    const currentTime = now();
    const attempt = attempts.get(clientId);
    if (attempt && attempt.resetAt > currentTime && attempt.count >= maxAttempts) {
      const retryAfter = Math.max(1, Math.ceil((attempt.resetAt - currentTime) / 1000));
      const error = new ApiError(429, "LOGIN_RATE_LIMITED", `Забагато спроб. Повторіть через ${retryAfter} с.`);
      error.retryAfter = retryAfter;
      throw error;
    }

    let passwordMatches = false;
    try {
      passwordMatches = verifyPassword(password, passwordHash);
    } catch {
      passwordMatches = false;
    }
    if (!safeEqual(String(inputUsername ?? ""), username) || !passwordMatches) {
      const next = attempt && attempt.resetAt > currentTime
        ? { count: attempt.count + 1, resetAt: attempt.resetAt }
        : { count: 1, resetAt: currentTime + attemptWindowMs };
      attempts.set(clientId, next);
      throw new ApiError(401, "INVALID_CREDENTIALS", "Неправильний логін або пароль.");
    }

    attempts.delete(clientId);
    const session = createSession();
    return { ...session, setCookie: cookie(session.token) };
  }

  return {
    authenticate,
    assertAuthenticated,
    login,
    clearCookie: cookie("", 0),
  };
}
