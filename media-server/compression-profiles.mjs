export const COMPRESSION_PROFILES = Object.freeze({
  ECONOMY: Object.freeze({
    id: "ECONOMY",
    label: "Економний",
    description: "Менший файл і швидша підготовка.",
    videoBitrate: "4M",
    audioBitrate: "128k",
    preset: "veryfast",
  }),
  STANDARD: Object.freeze({
    id: "STANDARD",
    label: "Стандартний",
    description: "Баланс якості, розміру та швидкості.",
    videoBitrate: "6M",
    audioBitrate: "160k",
    preset: "veryfast",
  }),
  QUALITY: Object.freeze({
    id: "QUALITY",
    label: "Якісний",
    description: "Вища якість з більшим розміром файлу.",
    videoBitrate: "8M",
    audioBitrate: "192k",
    preset: "fast",
  }),
});

export function normalizeCompressionProfile(value, fallback = "STANDARD") {
  const id = typeof value === "string" ? value.trim().toUpperCase() : "";
  return COMPRESSION_PROFILES[id]?.id || COMPRESSION_PROFILES[fallback]?.id || "STANDARD";
}

export function compressionProfile(value) {
  return COMPRESSION_PROFILES[normalizeCompressionProfile(value)];
}

export function listCompressionProfiles() {
  return Object.values(COMPRESSION_PROFILES).map((profile) => ({ ...profile }));
}
