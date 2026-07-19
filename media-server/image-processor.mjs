import { spawn } from "node:child_process";
import { ApiError } from "./api-error.mjs";

const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function detectImageMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) return "image/webp";
  return null;
}

export async function readImageBody(
  readable,
  { maxBytes = DEFAULT_MAX_IMAGE_BYTES, allowedTypes = ["image/png", "image/jpeg", "image/webp"] } = {},
) {
  const chunks = [];
  let size = 0;
  for await (const chunk of readable) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new ApiError(413, "IMAGE_TOO_LARGE", `Зображення не повинно перевищувати ${Math.round(maxBytes / 1024 / 1024)} МБ.`);
    }
    chunks.push(chunk);
  }
  if (!size) throw new ApiError(400, "IMAGE_EMPTY", "Зображення порожнє.");
  const buffer = Buffer.concat(chunks);
  const mimeType = detectImageMimeType(buffer);
  if (!mimeType || !allowedTypes.includes(mimeType)) {
    throw new ApiError(
      400,
      "UNSUPPORTED_IMAGE_TYPE",
      allowedTypes.length === 1
        ? "Завантажте зображення у форматі PNG."
        : "Підтримуються PNG, JPG і WebP.",
    );
  }
  return { buffer, mimeType, size };
}

function run(command, args, { spawnImpl = spawn, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      signal?.removeEventListener?.("abort", abort);
      if (signal?.aborted) {
        const error = new Error("Обробку зображення зупинено.");
        error.name = "AbortError";
        reject(error);
        return;
      }
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(`FFmpeg не зміг обробити зображення: ${stderr.trim()}`));
    });
  });
}

export function buildWebpArgs({ inputPath, outputPath, mode = "promo" }) {
  const filter = mode === "thumbnail"
    ? "scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2:color=black"
    : "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    filter,
    "-c:v",
    "libwebp",
    "-quality",
    mode === "thumbnail" ? "76" : "82",
    "-compression_level",
    "6",
    outputPath,
  ];
}

export async function convertImageToWebp({
  inputPath,
  outputPath,
  mode = "promo",
  ffmpegPath = "ffmpeg",
  spawnImpl = spawn,
  signal,
}) {
  await run(
    ffmpegPath,
    buildWebpArgs({ inputPath, outputPath, mode }),
    { spawnImpl, signal },
  );
}

export async function probeImage({
  inputPath,
  ffprobePath = "ffprobe",
  spawnImpl = spawn,
  signal,
}) {
  const stdout = await run(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      inputPath,
    ],
    { spawnImpl, signal },
  );
  const stream = JSON.parse(stdout)?.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new ApiError(400, "INVALID_IMAGE", "Не вдалося прочитати розміри зображення.");
  }
  return { width, height };
}
