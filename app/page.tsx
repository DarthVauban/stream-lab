"use client";

import {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;
const ALLOWED_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "m4v"]);

type Video = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  preparedSize: number | null;
  uploadedBytes: number;
  status: "UPLOADING" | "ANALYZING" | "PROCESSING" | "READY" | "FAILED";
  createdAt: string;
  completedAt: string | null;
  processingProgress: number;
  processingError: string | null;
  processingStartedAt: string | null;
  processedAt: string | null;
  media: {
    durationSeconds: number;
    width: number | null;
    height: number | null;
    fps: number | null;
    videoCodec: string | null;
    audioCodec: string | null;
  } | null;
  compressionProfile: "ECONOMY" | "STANDARD" | "QUALITY";
  fingerprint: string | null;
  thumbnailUrl: string | null;
  thumbnailPositionSeconds: number | null;
  thumbnailUpdatedAt: string | null;
  thumbnailStatus: "NONE" | "GENERATING" | "READY" | "FAILED";
  thumbnailError: string | null;
};

type StreamStatus = {
  status: "STOPPED" | "STARTING" | "LIVE" | "DEGRADED" | "RECONNECTING" | "STOPPING" | "ERROR";
  videoId: string | null;
  videoName: string | null;
  queueItemId: string | null;
  playlistLength: number;
  positionMs: number;
  durationMs: number;
  remainingMs: number | null;
  nextQueueItemId: string | null;
  nextVideoName: string | null;
  isFallback: boolean;
  videoBitrateKbps: number;
  startedAt: string | null;
  stoppedAt: string | null;
  lastError: string | null;
  lastFailure: string | null;
  reconnectAttempt: number;
  nextRetryAt: string | null;
  autoResumeEnabled: boolean;
  restoredAfterRestart: boolean;
  logs: string[];
};

type StreamSettings = {
  videoBitrateKbps: number;
  fallbackVideoId: string | null;
  compressionProfile: "ECONOMY" | "STANDARD" | "QUALITY";
  updatedAt: string | null;
};

type CompressionProfile = {
  id: "ECONOMY" | "STANDARD" | "QUALITY";
  label: string;
  description: string;
  videoBitrate: string;
  audioBitrate: string;
  preset: string;
};

type StorageStatus = {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percentUsed: number;
  level: "OK" | "WARNING" | "CRITICAL";
  warningPercent: number;
  criticalPercent: number;
  updatedAt: string;
};

type SystemStatus = {
  updatedAt: string;
  intervalMs: number;
  cpu: {
    usagePercent: number | null;
    cores: number;
    model: string;
    speedMhz: number | null;
    loadAverage: number[];
    temperatureCelsius: number | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    usagePercent: number | null;
    processRssBytes: number;
    processHeapUsedBytes: number;
    availableToProcessBytes: number | null;
  };
  disk: StorageStatus;
  network: {
    receivedBytesPerSecond: number | null;
    transmittedBytesPerSecond: number | null;
    receivedBytes: number | null;
    transmittedBytes: number | null;
  };
  system: {
    hostname: string;
    platform: string;
    release: string;
    architecture: string;
    uptimeSeconds: number;
    nodeVersion: string | null;
  };
  history: Array<{
    capturedAt: string;
    cpuUsagePercent: number | null;
    memoryUsagePercent: number | null;
    receivedBytesPerSecond: number | null;
    transmittedBytesPerSecond: number | null;
  }>;
};

type StreamPresetSummary = {
  id: string;
  name: string;
  streamUrl: string;
  streamKeyMasked: string;
  createdAt: string;
  updatedAt: string;
};

type StreamPresetDetails = Omit<StreamPresetSummary, "streamKeyMasked"> & {
  streamKey: string;
};

type Health = {
  ok: boolean;
  ffmpeg: { available: boolean; version: string | null; message: string | null };
  processing: { activeVideoId: string | null; queued: number; lastError: string | null } | null;
  queue: { items: number };
  database: { configured: boolean; connected: boolean };
  realtime: { configured: boolean; connected: boolean };
  storage: StorageStatus | null;
  system: SystemStatus | null;
};

type QueueItem = {
  id: string;
  videoId: string;
  position: number;
  addedAt: string;
  video: Video | null;
};

type QueueState = {
  mode: "LOOP_ALL";
  version: number;
  updatedAt: string | null;
  items: QueueItem[];
};

type Playlist = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string | null;
  items: QueueItem[];
};

type AuthSession =
  | { authenticated: false }
  | { authenticated: true; owner: string; csrfToken: string; expiresAt: string };

type WorkspaceTab = "library" | "playlists" | "queue" | "stream" | "promos" | "monitoring" | "youtube" | "profile";
type MonitoringRange = 1 | 24 | 168;
type MonitoringHealthState = "STABLE" | "BUFFERING_RISK" | "CRITICAL" | "OFFLINE";

type MonitoringStatus = {
  status: MonitoringHealthState;
  reason: string;
  issues: string[];
  updatedAt: string;
  rangeHours: number;
  current: {
    streamStatus: StreamStatus["status"];
    bitrateKbps: number | null;
    targetBitrateKbps: number | null;
    fps: number | null;
    speed: number | null;
    droppedFrames: number;
    duplicateFrames: number;
    reconnectAttempt: number;
    metricsCapturedAt: string | null;
    youtubeHealth: string | null;
    viewers: number;
  };
  session: {
    startedAt: string | null;
    uptimeMs: number;
    restarts: number;
    peakViewers: number;
    totalStreamStarts: number;
    totalUplinkRestarts: number;
  };
  history: Array<{
    capturedAt: string;
    streamStatus: StreamStatus["status"];
    healthStatus: MonitoringHealthState;
    bitrateKbps: number | null;
    targetBitrateKbps: number | null;
    fps: number | null;
    speed: number | null;
    droppedFrames: number | null;
    duplicateFrames: number | null;
    reconnectAttempt: number;
    viewers: number;
    youtubeHealth: string | null;
  }>;
  events: Array<{
    id: string;
    occurredAt: string;
    type: string;
    severity: "info" | "success" | "warning" | "critical";
    message: string;
  }>;
};

type AuditEntry = {
  id: string;
  occurredAt: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  status: "SUCCESS" | "FAILED";
};

type YouTubeBroadcast = {
  id: string;
  title: string;
  scheduledStartAt: string | null;
  actualStartAt: string | null;
  lifeCycleStatus: string;
  privacyStatus: string;
  boundStreamId: string | null;
  liveChatId: string | null;
};

type YouTubeStatus = {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  channel: {
    id: string;
    title: string;
    thumbnailUrl: string | null;
    subscribers: number | null;
    totalViews: number;
    videos: number;
  } | null;
  broadcasts: YouTubeBroadcast[];
  selected: YouTubeBroadcast | null;
  stream: {
    id: string;
    title: string;
    streamStatus: string;
    healthStatus: "good" | "ok" | "bad" | "noData" | string;
    lastHealthUpdateAt: string | null;
    configurationIssues: Array<{
      type: string;
      severity: string;
      reason: string;
      description: string;
    }>;
    resolution: string | null;
    frameRate: string | null;
    ingestionReady: boolean;
  } | null;
  metrics: {
    viewers: number;
    views: number;
    likes: number;
    actualStartAt: string | null;
    scheduledStartAt: string | null;
  } | null;
  analytics: {
    available: boolean;
    reconnectRequired: boolean;
    views?: number;
    estimatedMinutesWatched?: number;
    averageViewDurationSeconds?: number;
    likes?: number;
    subscribersGained?: number;
    subscribersLost?: number;
    updatedAt: string | null;
  } | null;
  dailyReport: {
    generatedAt: string;
    broadcastId: string | null;
    samples: number;
    peakViewers: number;
    viewsDelta: number;
    likesDelta: number;
  } | null;
  history: Array<{
    capturedAt: string;
    broadcastId: string;
    viewers: number;
    views: number;
    likes: number;
    health: string;
  }>;
  quota: {
    date: string;
    used: number;
    limit: number;
    remaining: number;
    updatedAt: string | null;
  };
  polling: {
    automatic: boolean;
    metricsSeconds: number;
    streamSeconds: number;
    broadcastSeconds: number;
    subscribersMinutes: number;
    analyticsMinutes: number;
    dailyReportHours: number;
    estimatedDailyUnits: number;
  };
  lastUpdatedAt: string | null;
  lastError: string | null;
};

type PromoPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  zIndex: number;
  zone: string;
  animation: "none" | "fade" | "slide" | "scale" | "pop";
};

type PromoAsset = {
  id: string;
  name: string;
  fileUrl: string;
  sourceMimeType: string;
  mimeType: "image/webp";
  size: number;
  width: number;
  height: number;
  tags: string[];
  placement: PromoPlacement;
  createdAt: string;
  updatedAt: string | null;
  impressions: number;
  lastShownAt: string | null;
};

type PromoCampaign = {
  id: string;
  name: string;
  assetId: string;
  status: "DRAFT" | "SCHEDULED" | "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED";
  startAt: string | null;
  endAt: string | null;
  intervalMinutes: number;
  durationSeconds: number;
  daysOfWeek: number[];
  timezone: string;
  priority: number;
  createdAt: string;
  updatedAt: string | null;
  lastShownAt: string | null;
  impressions: number;
};

type PromoStatus = {
  assets: PromoAsset[];
  campaigns: PromoCampaign[];
  impressions: Array<{
    id: string;
    assetId: string;
    campaignId: string | null;
    source: string;
    startedAt: string;
    durationSeconds: number;
  }>;
  active: {
    assetId: string;
    campaignId: string | null;
    source: string;
    startedAt: string;
    endsAt: string;
    durationSeconds: number;
    asset: PromoAsset | null;
  } | null;
};

type TelegramStatus = {
  connected: boolean;
  connectedAt: string | null;
  tokenMasked: string | null;
  bot: {
    id: number;
    username: string | null;
    displayName: string | null;
  } | null;
};

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}, csrfToken = ""): Promise<T> {
  const headers = new Headers(init.headers);
  if (csrfToken && !["GET", "HEAD"].includes(init.method || "GET")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiRequestError(
      body?.error?.message || "Сервер не зміг виконати запит.",
      response.status,
    );
  }
  return body as T;
}

function humanSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatRate(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  return `${humanSize(bytes)}/с`;
}

function formatDuration(startedAt: string | null, currentTime: number) {
  if (!startedAt) return "—";
  if (!currentTime) return "00:00:00";
  const seconds = Math.max(0, Math.floor((currentTime - new Date(startedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours, minutes, rest].map((value) => String(value).padStart(2, "0")).join(":");
}

function formatRetry(nextRetryAt: string | null, currentTime: number) {
  if (!nextRetryAt || !currentTime) return "очікуємо";
  const seconds = Math.max(0, Math.ceil((new Date(nextRetryAt).getTime() - currentTime) / 1000));
  return seconds > 0 ? `через ${seconds} с` : "зараз";
}

function formatMediaTime(milliseconds: number | null) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = hours > 0 ? [hours, minutes, rest] : [minutes, rest];
  return parts.map((value) => String(value).padStart(2, "0")).join(":");
}

function statusLabel(status: StreamStatus["status"]) {
  return {
    STOPPED: "Зупинено",
    STARTING: "Запуск",
    LIVE: "В ефірі",
    DEGRADED: "Сигнал нестабільний",
    RECONNECTING: "Відновлення",
    STOPPING: "Зупинка",
    ERROR: "Помилка",
  }[status];
}

function youtubeHealthLabel(status: string | undefined) {
  return {
    good: "Сигнал добрий",
    ok: "Є попередження",
    bad: "Потрібна увага",
    noData: "Очікуємо сигнал",
  }[status || "noData"] || "Стан невідомий";
}

function youtubeBroadcastStatus(status: string) {
  return {
    live: "в ефірі",
    liveStarting: "запускається",
    testing: "тестування",
    testStarting: "запуск тесту",
    ready: "готова",
    created: "запланована",
  }[status] || status;
}

function monitoringStatusLabel(status: MonitoringHealthState | undefined) {
  return {
    STABLE: "Стабільно",
    BUFFERING_RISK: "Ризик буферизації",
    CRITICAL: "Критично",
    OFFLINE: "Ефір зупинено",
  }[status || "OFFLINE"];
}

function formatMetric(value: number | null | undefined, suffix = "", digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("uk-UA", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${suffix}`;
}

function formatEventTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function videoStatusLabel(video: Video) {
  if (video.status === "ANALYZING") return "аналіз файлу";
  if (video.status === "PROCESSING") return `підготовка ${video.processingProgress}%`;
  if (video.status === "FAILED") return "помилка обробки";
  return "готово до ефіру";
}

function videoMeta(video: Video) {
  if (!video.media) return humanSize(video.size);
  const minutes = Math.floor(video.media.durationSeconds / 60);
  const seconds = Math.floor(video.media.durationSeconds % 60);
  const duration = `${minutes}:${String(seconds).padStart(2, "0")}`;
  const resolution = video.media.width && video.media.height
    ? `${video.media.width}×${video.media.height}`
    : null;
  return [humanSize(video.preparedSize ?? video.size), duration, resolution].filter(Boolean).join(" · ");
}

const emptyStream: StreamStatus = {
  status: "STOPPED",
  videoId: null,
  videoName: null,
  queueItemId: null,
  playlistLength: 0,
  positionMs: 0,
  durationMs: 0,
  remainingMs: null,
  nextQueueItemId: null,
  nextVideoName: null,
  isFallback: false,
  videoBitrateKbps: 8000,
  startedAt: null,
  stoppedAt: null,
  lastError: null,
  lastFailure: null,
  reconnectAttempt: 0,
  nextRetryAt: null,
  autoResumeEnabled: false,
  restoredAfterRestart: false,
  logs: [],
};

const emptyQueue: QueueState = {
  mode: "LOOP_ALL",
  version: 0,
  updatedAt: null,
  items: [],
};

export default function Home() {
  const [authState, setAuthState] = useState<"loading" | "anonymous" | "authenticated">("loading");
  const [owner, setOwner] = useState("");
  const [csrfToken, setCsrfToken] = useState("");
  const [loginUsername, setLoginUsername] = useState("owner");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [activeUploads, setActiveUploads] = useState<Video[]>([]);
  const [stream, setStream] = useState<StreamStatus>(emptyStream);
  const [queue, setQueue] = useState<QueueState>(emptyQueue);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [selectedPlaylistId, setSelectedPlaylistId] = useState("");
  const [playlistName, setPlaylistName] = useState("");
  const [playlistAction, setPlaylistAction] = useState("");
  const [streamSettings, setStreamSettings] = useState<StreamSettings | null>(null);
  const [bitrateDraft, setBitrateDraft] = useState(8000);
  const [fallbackVideoDraft, setFallbackVideoDraft] = useState("");
  const [compressionProfiles, setCompressionProfiles] = useState<CompressionProfile[]>([]);
  const [compressionProfileDraft, setCompressionProfileDraft] = useState<CompressionProfile["id"]>("STANDARD");
  const [settingsAction, setSettingsAction] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [processingAction, setProcessingAction] = useState("");
  const [queueAction, setQueueAction] = useState("");
  const [draggedQueueItemId, setDraggedQueueItemId] = useState("");
  const [queueDropTarget, setQueueDropTarget] = useState<{ itemId: string; edge: "before" | "after" } | null>(null);
  const [deletingVideoId, setDeletingVideoId] = useState("");
  const [streamUrl, setStreamUrl] = useState("rtmps://a.rtmps.youtube.com/live2");
  const [streamKey, setStreamKey] = useState("");
  const [streamKeyVisible, setStreamKeyVisible] = useState(false);
  const [streamPresets, setStreamPresets] = useState<StreamPresetSummary[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [presetAction, setPresetAction] = useState("");
  const [streamAction, setStreamAction] = useState(false);
  const [youtube, setYoutube] = useState<YouTubeStatus | null>(null);
  const [youtubeAction, setYoutubeAction] = useState("");
  const [monitoring, setMonitoring] = useState<MonitoringStatus | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [promos, setPromos] = useState<PromoStatus | null>(null);
  const [selectedPromoId, setSelectedPromoId] = useState("");
  const [promoFile, setPromoFile] = useState<File | null>(null);
  const [promoName, setPromoName] = useState("");
  const [promoTags, setPromoTags] = useState("");
  const [promoPlacementDraft, setPromoPlacementDraft] = useState<PromoPlacement | null>(null);
  const [promoDuration, setPromoDuration] = useState(10);
  const [promoAction, setPromoAction] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [campaignInterval, setCampaignInterval] = useState(30);
  const [campaignDuration, setCampaignDuration] = useState(10);
  const [campaignStartAt, setCampaignStartAt] = useState("");
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [monitoringRange, setMonitoringRange] = useState<MonitoringRange>(24);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramTokenVisible, setTelegramTokenVisible] = useState(false);
  const [telegramAction, setTelegramAction] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("stream");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [failedChannelAvatarUrl, setFailedChannelAvatarUrl] = useState("");
  const [thumbnailAction, setThumbnailAction] = useState("");
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [now, setNow] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const promoDragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [healthResult, videosResult, uploadsResult, streamResult, queueResult, playlistsResult, youtubeResult, systemResult, promosResult] = await Promise.all([
        api<Health>("/api/health"),
        api<{ videos: Video[] }>("/api/videos"),
        api<{ uploads: Video[] }>("/api/uploads"),
        api<{ stream: StreamStatus }>("/api/stream/status"),
        api<{ queue: QueueState }>("/api/queue"),
        api<{ playlists: Playlist[] }>("/api/playlists"),
        api<{ youtube: YouTubeStatus }>("/api/youtube/status"),
        api<{ system: SystemStatus | null }>("/api/system/status"),
        api<{ promos: PromoStatus }>("/api/promos"),
      ]);
      setHealth(healthResult);
      setVideos(videosResult.videos);
      setActiveUploads(uploadsResult.uploads);
      setStream(streamResult.stream);
      setQueue(queueResult.queue);
      setPlaylists(playlistsResult.playlists);
      setSelectedPlaylistId((current) => current || playlistsResult.playlists[0]?.id || "");
      setYoutube(youtubeResult.youtube);
      setSystemStatus(systemResult.system);
      setPromos(promosResult.promos);
      setSelectedPromoId((current) => current || promosResult.promos.assets[0]?.id || "");
      setPromoPlacementDraft((current) => current || (promosResult.promos.assets[0]
        ? { ...promosResult.promos.assets[0].placement }
        : null));
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setAuthState("anonymous");
        setOwner("");
        setCsrfToken("");
      }
      setHealth(null);
    }
  }, []);

  const refreshMonitoring = useCallback(async (hours: MonitoringRange) => {
    try {
      const [result, auditResult] = await Promise.all([
        api<{ monitoring: MonitoringStatus }>(`/api/monitoring/status?hours=${hours}`),
        api<{ entries: AuditEntry[] }>("/api/audit?limit=40"),
      ]);
      setMonitoring(result.monitoring);
      setAuditEntries(auditResult.entries);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setAuthState("anonymous");
        setOwner("");
        setCsrfToken("");
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api<AuthSession>("/api/auth/session")
      .then((session) => {
        if (cancelled) return;
        if (session.authenticated) {
          setOwner(session.owner);
          setCsrfToken(session.csrfToken);
          setAuthState("authenticated");
        } else {
          setAuthState("anonymous");
        }
      })
      .catch(() => {
        if (!cancelled) setAuthState("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const restorePreference = window.setTimeout(() => {
      setSidebarCollapsed(window.localStorage.getItem("streamlab:sidebar-collapsed") === "true");
    }, 0);
    return () => window.clearTimeout(restorePreference);
  }, []);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const initialRefresh = window.setTimeout(refresh, 0);
    const poll = window.setInterval(refresh, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [authState, refresh]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const initialRefresh = window.setTimeout(() => void refreshMonitoring(monitoringRange), 0);
    const poll = window.setInterval(() => void refreshMonitoring(monitoringRange), 5_000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(poll);
    };
  }, [authState, monitoringRange, refreshMonitoring]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const events = new EventSource("/api/stream/events");
    events.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { stream?: StreamStatus };
        if (payload.stream) setStream(payload.stream);
      } catch {
        // The regular status poll remains available if a malformed event is received.
      }
    };
    return () => events.close();
  }, [authState]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    let refreshTimer = 0;
    let fallback: EventSource | null = null;
    let closed = false;
    const handleMessage = (data: string) => {
      try {
        const payload = JSON.parse(data) as { type?: string; payload?: unknown };
        if (payload.type === "READY") return;
        if (payload.type === "SYSTEM_METRICS" && payload.payload) {
          setSystemStatus(payload.payload as SystemStatus);
          return;
        }
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => void refresh(), 150);
      } catch {
        // A periodic refresh remains as a fallback.
      }
    };
    const startFallback = () => {
      if (closed || fallback) return;
      fallback = new EventSource("/api/realtime/stream");
      fallback.onopen = () => setRealtimeConnected(true);
      fallback.onerror = () => setRealtimeConnected(false);
      fallback.onmessage = (event) => handleMessage(event.data);
    };
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);
    const fallbackTimer = window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) startFallback();
    }, 1_500);
    socket.onopen = () => {
      window.clearTimeout(fallbackTimer);
      fallback?.close();
      fallback = null;
      setRealtimeConnected(true);
    };
    socket.onmessage = (event) => handleMessage(String(event.data));
    socket.onerror = () => startFallback();
    socket.onclose = () => {
      setRealtimeConnected(false);
      startFallback();
    };
    return () => {
      closed = true;
      window.clearTimeout(refreshTimer);
      window.clearTimeout(fallbackTimer);
      socket.close();
      fallback?.close();
      setRealtimeConnected(false);
    };
  }, [authState, refresh]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    const result = new URLSearchParams(window.location.search).get("youtube");
    if (!result) return;
    const notification = window.setTimeout(() => {
      setActiveTab("profile");
      setNotice(
        result === "connected"
          ? { type: "success", text: "YouTube-канал підключено. Автоматична синхронізація запуститься протягом кількох секунд." }
          : { type: "error", text: "Не вдалося підключити YouTube. Спробуйте ще раз." },
      );
    }, 0);
    window.history.replaceState({}, "", window.location.pathname);
    return () => window.clearTimeout(notification);
  }, [authState]);

  useEffect(() => {
    if (authState !== "authenticated") return;
    let cancelled = false;
    void Promise.all([
      api<{ settings: StreamSettings }>("/api/settings/stream"),
      api<{ presets: StreamPresetSummary[] }>("/api/stream-presets"),
      api<{ telegram: TelegramStatus }>("/api/telegram/status"),
      api<{ profiles: CompressionProfile[] }>("/api/compression-profiles"),
    ])
      .then(([{ settings }, { presets }, { telegram }, { profiles }]) => {
        if (cancelled) return;
        setStreamSettings(settings);
        setBitrateDraft(settings.videoBitrateKbps);
        setFallbackVideoDraft(settings.fallbackVideoId ?? "");
        setCompressionProfileDraft(settings.compressionProfile);
        setStreamPresets(presets);
        setTelegram(telegram);
        setCompressionProfiles(profiles);
      })
      .catch((error) => {
        if (!cancelled) {
          setNotice({
            type: "error",
            text: error instanceof Error ? error.message : "Не вдалося завантажити налаштування ефіру.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authState]);

  const active = ["LIVE", "STARTING", "DEGRADED", "RECONNECTING", "STOPPING"].includes(stream.status);
  const selectedPromo = promos?.assets.find((asset) => asset.id === selectedPromoId) || null;
  const selectedPlaylist = playlists.find((playlist) => playlist.id === selectedPlaylistId) || null;
  const currentQueueIndex = stream.queueItemId
    ? queue.items.findIndex((item) => item.id === stream.queueItemId)
    : stream.videoId
      ? queue.items.findIndex((item) => item.videoId === stream.videoId)
    : -1;
  const nextQueueItem = queue.items.length > 0
    ? queue.items[currentQueueIndex >= 0 ? (currentQueueIndex + 1) % queue.items.length : 0]
    : null;
  const readyToStart = Boolean(
    (queue.items.length > 0 || Boolean(fallbackVideoDraft)) &&
    streamUrl.trim() &&
    streamKey.trim() &&
    health?.ffmpeg.available &&
    Number.isInteger(bitrateDraft) &&
    bitrateDraft >= 3000 &&
    bitrateDraft <= 12000,
  );
  const playbackProgress = stream.durationMs > 0
    ? Math.min(100, Math.max(0, (stream.positionMs / stream.durationMs) * 100))
    : 0;
  const youtubeChart = youtube?.history.slice(-48) ?? [];
  const youtubeChartMax = Math.max(1, ...youtubeChart.map((item) => item.viewers));
  const monitoringBitrateMax = Math.max(
    1,
    monitoring?.current.targetBitrateKbps ?? 0,
    ...(monitoring?.history.map((item) => item.bitrateKbps ?? 0) ?? []),
  );
  const pageMeta = {
    library: { eyebrow: "Медіатека", title: "Бібліотека відео", description: "Завантаження, підготовка та керування файлами." },
    playlists: { eyebrow: "Колекції", title: "Плейлисти", description: "Збережені набори відео для швидкого формування черги." },
    queue: { eyebrow: "Плейлист", title: "Черга трансляції", description: "Порядок безперервного відтворення в ефірі." },
    stream: { eyebrow: "Трансляція", title: "Керування ефіром", description: "Профіль сигналу, RTMPS-підключення та запуск." },
    promos: { eyebrow: "Оформлення ефіру", title: "Промоматеріали", description: "Банери, позиціонування, ручний показ і кампанії за розкладом." },
    monitoring: { eyebrow: "Діагностика", title: "Моніторинг ефіру", description: "Якість сигналу, продуктивність і журнал подій." },
    youtube: { eyebrow: "Аналітика", title: "YouTube", description: "Активна трансляція, показники каналу та сигнал ingest." },
    profile: { eyebrow: "Обліковий запис", title: "Профіль та інтеграції", description: "Доступ власника, YouTube і Telegram-бот." },
  }[activeTab];
  const navigationItems: Array<{
    id: Exclude<WorkspaceTab, "profile">;
    icon: string;
    label: string;
    description: string;
  }> = [
    { id: "library", icon: "▦", label: "Бібліотека", description: "Відеофайли" },
    { id: "playlists", icon: "☷", label: "Плейлисти", description: "Збережені набори" },
    { id: "queue", icon: "≡", label: "Черга", description: "Порядок ефіру" },
    { id: "stream", icon: "▶", label: "Ефір", description: "Запуск і керування" },
    { id: "promos", icon: "◇", label: "Промо", description: "Матеріали й кампанії" },
    { id: "monitoring", icon: "⌁", label: "Моніторинг", description: "Якість сигналу" },
    { id: "youtube", icon: "YT", label: "YouTube", description: "Канал і аналітика" },
  ];

  async function createPlaylist() {
    if (!playlistName.trim() || playlistAction) return;
    setPlaylistAction("create");
    try {
      const result = await api<{ playlists: Playlist[] }>("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: playlistName.trim() }),
      }, csrfToken);
      setPlaylists(result.playlists);
      const created = result.playlists.at(-1);
      if (created) setSelectedPlaylistId(created.id);
      setPlaylistName("");
      setNotice({ type: "success", text: "Плейлист створено." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося створити плейлист." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function renamePlaylist() {
    if (!selectedPlaylist || !playlistName.trim() || playlistAction) return;
    setPlaylistAction("rename");
    try {
      const result = await api<{ playlists: Playlist[] }>(`/api/playlists/${selectedPlaylist.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: playlistName.trim() }),
      }, csrfToken);
      setPlaylists(result.playlists);
      setPlaylistName("");
      setNotice({ type: "success", text: "Назву плейлиста оновлено." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося перейменувати плейлист." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function deletePlaylist() {
    if (!selectedPlaylist || playlistAction || !window.confirm(`Видалити плейлист «${selectedPlaylist.name}»?`)) return;
    setPlaylistAction("delete");
    try {
      const result = await api<{ playlists: Playlist[] }>(`/api/playlists/${selectedPlaylist.id}`, { method: "DELETE" }, csrfToken);
      setPlaylists(result.playlists);
      setSelectedPlaylistId(result.playlists[0]?.id || "");
      setNotice({ type: "success", text: "Плейлист видалено. Відеофайли залишилися в бібліотеці." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося видалити плейлист." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function addVideoToPlaylist(videoId: string) {
    if (!selectedPlaylist || playlistAction) return;
    setPlaylistAction(`add:${videoId}`);
    try {
      const result = await api<{ playlists: Playlist[] }>(`/api/playlists/${selectedPlaylist.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      }, csrfToken);
      setPlaylists(result.playlists);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося додати відео." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function removePlaylistItem(itemId: string) {
    if (!selectedPlaylist || playlistAction) return;
    setPlaylistAction(`remove:${itemId}`);
    try {
      const result = await api<{ playlists: Playlist[] }>(`/api/playlists/${selectedPlaylist.id}/items/${itemId}`, { method: "DELETE" }, csrfToken);
      setPlaylists(result.playlists);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося прибрати відео." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function movePlaylistItem(itemId: string, direction: -1 | 1) {
    if (!selectedPlaylist || playlistAction) return;
    const ids = selectedPlaylist.items.map((item) => item.id);
    const index = ids.indexOf(itemId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setPlaylistAction("reorder");
    try {
      const result = await api<{ playlists: Playlist[] }>(`/api/playlists/${selectedPlaylist.id}/reorder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: ids }),
      }, csrfToken);
      setPlaylists(result.playlists);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося змінити порядок." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function loadPlaylist() {
    if (!selectedPlaylist || playlistAction || active) return;
    setPlaylistAction("load");
    try {
      const result = await api<{ queue: QueueState }>(`/api/playlists/${selectedPlaylist.id}/load`, { method: "POST" }, csrfToken);
      setQueue(result.queue);
      setActiveTab("queue");
      setNotice({ type: "success", text: `Плейлист «${selectedPlaylist.name}» завантажено в чергу.` });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося завантажити плейлист." });
    } finally {
      setPlaylistAction("");
    }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    try {
      const session = await api<AuthSession>("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });
      if (!session.authenticated) throw new Error("Не вдалося створити сесію.");
      setOwner(session.owner);
      setCsrfToken(session.csrfToken);
      setLoginPassword("");
      setAuthState("authenticated");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Не вдалося увійти.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" }, csrfToken);
    } finally {
      setAuthState("anonymous");
      setOwner("");
      setCsrfToken("");
      setVideos([]);
      setActiveUploads([]);
      setStream(emptyStream);
      setQueue(emptyQueue);
      setPlaylists([]);
      setSelectedPlaylistId("");
      setPlaylistName("");
      setStreamSettings(null);
      setBitrateDraft(8000);
      setFallbackVideoDraft("");
      setCompressionProfileDraft("STANDARD");
      setCompressionProfiles([]);
      setStreamPresets([]);
      setSelectedPresetId("");
      setPresetName("");
      setStreamKey("");
      setStreamKeyVisible(false);
      setYoutube(null);
      setYoutubeAction("");
      setMonitoring(null);
      setSystemStatus(null);
      setPromos(null);
      setSelectedPromoId("");
      setPromoFile(null);
      setPromoName("");
      setPromoTags("");
      setPromoPlacementDraft(null);
      setPromoAction("");
      setAuditEntries([]);
      setMonitoringRange(24);
      setTelegram(null);
      setTelegramToken("");
      setTelegramTokenVisible(false);
      setTelegramAction("");
      setActiveTab("stream");
      setFailedChannelAvatarUrl("");
      setThumbnailAction("");
      setRealtimeConnected(false);
    }
  }

  function selectFile(file: File | null) {
    if (file) {
      const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
      if (!ALLOWED_VIDEO_EXTENSIONS.has(extension)) {
        setSelectedFile(null);
        setUploadProgress(0);
        setNotice({ type: "error", text: "Оберіть відео у форматі MP4, MOV, MKV, WEBM або M4V." });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
        setSelectedFile(null);
        setUploadProgress(0);
        setNotice({ type: "error", text: "Файл має бути непорожнім і не перевищувати 50 ГБ." });
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
    }

    setSelectedFile(file);
    setUploadProgress(0);
    setNotice(null);
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null);
  }

  function handleDragEnter(event: ReactDragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (uploading) return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragOver(event: ReactDragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!uploading) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: ReactDragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (uploading) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: ReactDragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (uploading) return;
    selectFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function uploadVideo() {
    if (!selectedFile || uploading) return;
    setUploading(true);
    setNotice(null);
    setUploadProgress(0);
    try {
      const created = await api<{ upload: Video }>("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: selectedFile.name,
          size: selectedFile.size,
          mimeType: selectedFile.type,
          fingerprint: `${selectedFile.name}:${selectedFile.size}:${selectedFile.lastModified}`,
          compressionProfile: compressionProfileDraft,
        }),
      }, csrfToken);

      let offset = created.upload.uploadedBytes;
      setUploadProgress(Math.round((offset / selectedFile.size) * 100));
      while (offset < selectedFile.size) {
        const chunk = selectedFile.slice(offset, Math.min(offset + CHUNK_SIZE, selectedFile.size));
        const result = await api<{ upload: Video }>(
          `/api/uploads/${created.upload.id}/chunks?offset=${offset}`,
          { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk },
          csrfToken,
        );
        offset = result.upload.uploadedBytes;
        setUploadProgress(Math.round((offset / selectedFile.size) * 100));
      }

      const completed = await api<{ video: Video }>(
        `/api/uploads/${created.upload.id}/complete`,
        { method: "POST" },
        csrfToken,
      );
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setUploadProgress(100);
      setNotice({
        type: "success",
        text: completed.video.status === "READY"
          ? "Відео завантажено й готове до трансляції."
          : "Відео завантажено. Почалася автоматична підготовка до трансляції.",
      });
      await refresh();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося завантажити відео.",
      });
    } finally {
      setUploading(false);
    }
  }

  async function cancelInterruptedUpload(upload: Video) {
    if (uploading || !window.confirm(`Скасувати завантаження «${upload.name}» і видалити отримані дані?`)) return;
    try {
      const result = await api<{ uploads: Video[] }>(`/api/uploads/${upload.id}`, { method: "DELETE" }, csrfToken);
      setActiveUploads(result.uploads);
      setNotice({ type: "success", text: "Незавершене завантаження видалено із сервера." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося скасувати завантаження." });
    }
  }

  async function retryVideoProcessing(videoId: string) {
    if (processingAction) return;
    setProcessingAction(videoId);
    setNotice(null);
    try {
      await api<{ video: Video }>(
        `/api/videos/${videoId}/process`,
        { method: "POST" },
        csrfToken,
      );
      setNotice({ type: "success", text: "Повторну обробку відео запущено." });
      await refresh();
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося повторити обробку відео.",
      });
    } finally {
      setProcessingAction("");
    }
  }

  async function uploadVideoThumbnail(video: Video, file: File | null) {
    if (!file || thumbnailAction || video.status !== "READY") return;
    if (file.type !== "image/png" || !file.name.toLowerCase().endsWith(".png")) {
      setNotice({ type: "error", text: "Для прев’ю потрібно вибрати PNG-зображення." });
      return;
    }
    if (file.size <= 0 || file.size > 15 * 1024 * 1024) {
      setNotice({ type: "error", text: "PNG-прев’ю має бути непорожнім і не перевищувати 15 МБ." });
      return;
    }
    setThumbnailAction(video.id);
    setNotice(null);
    try {
      const result = await api<{ video: Video }>(
        `/api/videos/${video.id}/thumbnail`,
        {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: file,
        },
        csrfToken,
      );
      setVideos((current) => current.map((item) => item.id === video.id ? result.video : item));
      setNotice({ type: "success", text: "PNG-прев’ю конвертовано у WebP та збережено." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося створити прев’ю.",
      });
    } finally {
      setThumbnailAction("");
    }
  }

  async function deleteVideo(video: Video) {
    if (deletingVideoId) return;
    const confirmed = window.confirm(
      `Видалити «${video.name}»? Файл буде повністю стерто із сервера без можливості відновлення.`,
    );
    if (!confirmed) return;

    setDeletingVideoId(video.id);
    setNotice(null);
    try {
      const result = await api<{ video: Video; queue: QueueState }>(`/api/videos/${video.id}`, {
        method: "DELETE",
      }, csrfToken);
      setVideos((current) => current.filter((item) => item.id !== video.id));
      setQueue(result.queue);
      if (fallbackVideoDraft === video.id) {
        setFallbackVideoDraft("");
        setStreamSettings((current) => current ? { ...current, fallbackVideoId: null } : current);
      }
      setNotice({ type: "success", text: "Відео повністю видалено із сервера." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося видалити відео.",
      });
    } finally {
      setDeletingVideoId("");
    }
  }

  async function addVideoToQueue(videoId: string) {
    if (queueAction) return;
    setQueueAction(`add:${videoId}`);
    setNotice(null);
    try {
      const result = await api<{ queue: QueueState }>("/api/queue/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId }),
      }, csrfToken);
      setQueue(result.queue);
      setNotice({ type: "success", text: "Відео додано до черги трансляції." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося додати відео до черги.",
      });
    } finally {
      setQueueAction("");
    }
  }

  async function removeQueueItem(itemId: string) {
    if (queueAction) return;
    setQueueAction(`remove:${itemId}`);
    setNotice(null);
    try {
      const result = await api<{ queue: QueueState }>(`/api/queue/items/${itemId}`, {
        method: "DELETE",
      }, csrfToken);
      setQueue(result.queue);
      setNotice({ type: "success", text: "Відео прибрано з черги." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося змінити чергу.",
      });
    } finally {
      setQueueAction("");
    }
  }

  async function playQueueItemNext(itemId: string) {
    if (queueAction) return;
    setQueueAction(`next:${itemId}`);
    setNotice(null);
    try {
      const result = await api<{ queue: QueueState }>(`/api/queue/items/${itemId}/play-next`, {
        method: "POST",
      }, csrfToken);
      setQueue(result.queue);
      setNotice({
        type: "success",
        text: active ? "Відео буде наступним в ефірі." : "Відео переміщено на початок черги.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося змінити чергу.",
      });
    } finally {
      setQueueAction("");
    }
  }

  async function saveQueueOrder(items: QueueItem[]) {
    if (queueAction) return;
    const previous = queue;
    const optimisticItems = items.map((item, position) => ({ ...item, position }));
    setQueue({ ...queue, items: optimisticItems });
    setQueueAction("reorder");
    try {
      const result = await api<{ queue: QueueState }>("/api/queue/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: optimisticItems.map((item) => item.id) }),
      }, csrfToken);
      setQueue(result.queue);
    } catch (error) {
      setQueue(previous);
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося зберегти порядок черги.",
      });
    } finally {
      setQueueAction("");
      setDraggedQueueItemId("");
      setQueueDropTarget(null);
    }
  }

  function moveQueueItem(itemId: string, direction: -1 | 1) {
    if (queueAction) return;
    const currentIndex = queue.items.findIndex((item) => item.id === itemId);
    const targetIndex = currentIndex + direction;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= queue.items.length) return;
    const items = [...queue.items];
    [items[currentIndex], items[targetIndex]] = [items[targetIndex], items[currentIndex]];
    void saveQueueOrder(items);
  }

  function handleQueueDragStart(event: ReactDragEvent<HTMLDivElement>, itemId: string) {
    setDraggedQueueItemId(itemId);
    setQueueDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", itemId);
  }

  function handleQueueDragOver(event: ReactDragEvent<HTMLDivElement>, targetItemId: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!draggedQueueItemId || draggedQueueItemId === targetItemId || queueAction) {
      setQueueDropTarget(null);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge = event.clientY > bounds.top + bounds.height / 2 ? "after" : "before";
    setQueueDropTarget((current) => (
      current?.itemId === targetItemId && current.edge === edge
        ? current
        : { itemId: targetItemId, edge }
    ));
  }

  function handleQueueDrop(event: ReactDragEvent<HTMLDivElement>, targetItemId: string) {
    event.preventDefault();
    const sourceItemId = draggedQueueItemId || event.dataTransfer.getData("text/plain");
    if (!sourceItemId || sourceItemId === targetItemId || queueAction) {
      setQueueDropTarget(null);
      return;
    }

    const sourceItem = queue.items.find((item) => item.id === sourceItemId);
    if (!sourceItem) return;
    const items = queue.items.filter((item) => item.id !== sourceItemId);
    const targetIndex = items.findIndex((item) => item.id === targetItemId);
    if (targetIndex < 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const insertAfter = queueDropTarget?.itemId === targetItemId
      ? queueDropTarget.edge === "after"
      : event.clientY > bounds.top + bounds.height / 2;
    items.splice(targetIndex + (insertAfter ? 1 : 0), 0, sourceItem);
    void saveQueueOrder(items);
  }

  async function loadStreamPreset(presetId: string) {
    setSelectedPresetId(presetId);
    if (!presetId) {
      setPresetName("");
      return;
    }
    if (presetAction) return;
    setPresetAction("load");
    setNotice(null);
    try {
      const result = await api<{ preset: StreamPresetDetails }>(
        `/api/stream-presets/${encodeURIComponent(presetId)}`,
      );
      setPresetName(result.preset.name);
      setStreamUrl(result.preset.streamUrl);
      setStreamKey(result.preset.streamKey);
      setStreamKeyVisible(false);
    } catch (error) {
      setSelectedPresetId("");
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося відкрити пресет.",
      });
    } finally {
      setPresetAction("");
    }
  }

  function beginNewStreamPreset() {
    setSelectedPresetId("");
    setPresetName("");
    setNotice(null);
  }

  async function saveStreamPreset() {
    if (presetAction || active) return;
    if (!presetName.trim()) {
      setNotice({ type: "error", text: "Вкажіть назву пресету." });
      return;
    }
    setPresetAction("save");
    setNotice(null);
    try {
      const path = selectedPresetId
        ? `/api/stream-presets/${encodeURIComponent(selectedPresetId)}`
        : "/api/stream-presets";
      const result = await api<{ preset: StreamPresetSummary }>(path, {
        method: selectedPresetId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: presetName, streamUrl, streamKey }),
      }, csrfToken);
      setStreamPresets((current) => {
        const index = current.findIndex((preset) => preset.id === result.preset.id);
        if (index === -1) return [...current, result.preset];
        const updated = [...current];
        updated[index] = result.preset;
        return updated;
      });
      setSelectedPresetId(result.preset.id);
      setPresetName(result.preset.name);
      setNotice({
        type: "success",
        text: selectedPresetId ? "Пресет оновлено." : "Пресет збережено.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося зберегти пресет.",
      });
    } finally {
      setPresetAction("");
    }
  }

  async function deleteStreamPreset() {
    if (!selectedPresetId || presetAction || active) return;
    if (!window.confirm(`Видалити пресет «${presetName}»?`)) return;
    setPresetAction("delete");
    setNotice(null);
    try {
      const result = await api<{ presets: StreamPresetSummary[] }>(
        `/api/stream-presets/${encodeURIComponent(selectedPresetId)}`,
        { method: "DELETE" },
        csrfToken,
      );
      setStreamPresets(result.presets);
      setSelectedPresetId("");
      setPresetName("");
      setNotice({ type: "success", text: "Пресет видалено. Поля ефіру залишилися без змін." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося видалити пресет.",
      });
    } finally {
      setPresetAction("");
    }
  }

  async function saveStreamSettings(showNotice = true) {
    if (settingsAction || active) return null;
    setSettingsAction(true);
    if (showNotice) setNotice(null);
    try {
      const result = await api<{ settings: StreamSettings }>("/api/settings/stream", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoBitrateKbps: bitrateDraft,
          fallbackVideoId: fallbackVideoDraft || null,
          compressionProfile: compressionProfileDraft,
        }),
      }, csrfToken);
      setStreamSettings(result.settings);
      setBitrateDraft(result.settings.videoBitrateKbps);
      setFallbackVideoDraft(result.settings.fallbackVideoId ?? "");
      setCompressionProfileDraft(result.settings.compressionProfile);
      if (showNotice) {
        setNotice({ type: "success", text: "Профіль ефіру збережено для наступного запуску." });
      }
      return result.settings;
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося зберегти профіль ефіру.",
      });
      return null;
    } finally {
      setSettingsAction(false);
    }
  }

  async function startStream(event: FormEvent) {
    event.preventDefault();
    if (!readyToStart || streamAction) return;
    setStreamAction(true);
    setNotice(null);
    try {
      if (
        streamSettings?.videoBitrateKbps !== bitrateDraft ||
        (streamSettings?.fallbackVideoId ?? "") !== fallbackVideoDraft ||
        streamSettings?.compressionProfile !== compressionProfileDraft
      ) {
        const saved = await saveStreamSettings(false);
        if (!saved) return;
      }
      const result = await api<{ stream: StreamStatus }>("/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamUrl, streamKey }),
      }, csrfToken);
      setStream(result.stream);
      setNotice({ type: "success", text: "FFmpeg запущено. Очікуємо сигнал від YouTube." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося запустити трансляцію.",
      });
    } finally {
      setStreamAction(false);
      await refresh();
    }
  }

  async function stopStream() {
    if (streamAction) return;
    setStreamAction(true);
    setNotice(null);
    try {
      const result = await api<{ stream: StreamStatus }>("/api/stream/stop", {
        method: "POST",
      }, csrfToken);
      setStream(result.stream);
      setNotice({ type: "success", text: "Трансляцію зупинено." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося зупинити трансляцію.",
      });
    } finally {
      setStreamAction(false);
      await refresh();
    }
  }

  async function skipStreamVideo() {
    if (streamAction) return;
    setStreamAction(true);
    setNotice(null);
    try {
      const result = await api<{ stream: StreamStatus }>("/api/stream/skip", {
        method: "POST",
      }, csrfToken);
      setStream(result.stream);
      setNotice({ type: "success", text: "Переходимо до наступного відео без зупинки ефіру." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося пропустити відео.",
      });
    } finally {
      setStreamAction(false);
      await refresh();
    }
  }

  async function connectYouTube() {
    if (youtubeAction) return;
    setYoutubeAction("connect");
    setNotice(null);
    try {
      const result = await api<{ authorizationUrl: string }>(
        "/api/youtube/oauth/start",
        { method: "POST" },
        csrfToken,
      );
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setYoutubeAction("");
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося почати підключення YouTube.",
      });
    }
  }

  async function disconnectYouTube() {
    if (youtubeAction || !window.confirm("Відключити YouTube-канал від StreamLab?")) return;
    setYoutubeAction("disconnect");
    setNotice(null);
    try {
      const result = await api<{ youtube: YouTubeStatus }>(
        "/api/youtube/disconnect",
        { method: "POST" },
        csrfToken,
      );
      setYoutube(result.youtube);
      setFailedChannelAvatarUrl("");
      setNotice({ type: "success", text: "YouTube-канал відключено, доступ відкликано." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося відключити YouTube.",
      });
    } finally {
      setYoutubeAction("");
    }
  }

  async function connectTelegram() {
    if (telegramAction || !telegramToken.trim()) return;
    setTelegramAction("connect");
    setNotice(null);
    try {
      const result = await api<{ telegram: TelegramStatus }>(
        "/api/telegram/connect",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: telegramToken.trim() }),
        },
        csrfToken,
      );
      setTelegram(result.telegram);
      setTelegramToken("");
      setTelegramTokenVisible(false);
      setNotice({ type: "success", text: "Telegram-бот підключено й перевірено." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося підключити Telegram-бота.",
      });
    } finally {
      setTelegramAction("");
    }
  }

  async function disconnectTelegram() {
    if (telegramAction || !window.confirm("Відключити Telegram-бота від StreamLab?")) return;
    setTelegramAction("disconnect");
    setNotice(null);
    try {
      const result = await api<{ telegram: TelegramStatus }>(
        "/api/telegram/disconnect",
        { method: "DELETE" },
        csrfToken,
      );
      setTelegram(result.telegram);
      setTelegramToken("");
      setNotice({ type: "success", text: "Telegram-бот відключено." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося відключити Telegram-бота.",
      });
    } finally {
      setTelegramAction("");
    }
  }

  function toggleSidebar() {
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      window.localStorage.setItem("streamlab:sidebar-collapsed", String(next));
      return next;
    });
  }

  async function createPromoAsset() {
    if (!promoFile || promoAction) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(promoFile.type)) {
      setNotice({ type: "error", text: "Для промо підтримуються PNG, JPG і WebP." });
      return;
    }
    setPromoAction("upload");
    setNotice(null);
    try {
      const parameters = new URLSearchParams({
        name: promoName.trim() || promoFile.name.replace(/\.[^.]+$/, ""),
        tags: promoTags,
      });
      const result = await api<{ asset: PromoAsset; promos: PromoStatus }>(
        `/api/promo-assets?${parameters}`,
        { method: "POST", headers: { "Content-Type": promoFile.type }, body: promoFile },
        csrfToken,
      );
      setPromos(result.promos);
      setSelectedPromoId(result.asset.id);
      setPromoPlacementDraft({ ...result.asset.placement });
      setPromoFile(null);
      setPromoName("");
      setPromoTags("");
      setNotice({ type: "success", text: "Промоматеріал конвертовано у WebP і додано до бібліотеки." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося додати промоматеріал." });
    } finally {
      setPromoAction("");
    }
  }

  function applyPromoZone(zone: string) {
    if (!promoPlacementDraft) return;
    const { width, height } = promoPlacementDraft;
    const horizontal = zone.endsWith("left") ? 54 : zone.endsWith("right") ? 1_920 - width - 54 : (1_920 - width) / 2;
    const vertical = zone.startsWith("top") ? 54 : zone.startsWith("bottom") ? 1_080 - height - 54 : (1_080 - height) / 2;
    setPromoPlacementDraft({
      ...promoPlacementDraft,
      zone,
      x: Math.max(0, Math.round(zone === "fullscreen" ? 0 : horizontal)),
      y: Math.max(0, Math.round(zone === "fullscreen" ? 0 : vertical)),
      ...(zone === "fullscreen" ? { width: 1_920, height: 1_080 } : {}),
    });
  }

  function handlePromoPointerDown(event: ReactPointerEvent<HTMLImageElement>) {
    if (!promoPlacementDraft) return;
    const canvas = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!canvas) return;
    const pointerX = ((event.clientX - canvas.left) / canvas.width) * 1_920;
    const pointerY = ((event.clientY - canvas.top) / canvas.height) * 1_080;
    promoDragRef.current = {
      offsetX: pointerX - promoPlacementDraft.x,
      offsetY: pointerY - promoPlacementDraft.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePromoPointerMove(event: ReactPointerEvent<HTMLImageElement>) {
    if (!promoDragRef.current || !promoPlacementDraft) return;
    const canvas = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!canvas) return;
    const x = ((event.clientX - canvas.left) / canvas.width) * 1_920 - promoDragRef.current.offsetX;
    const y = ((event.clientY - canvas.top) / canvas.height) * 1_080 - promoDragRef.current.offsetY;
    setPromoPlacementDraft({
      ...promoPlacementDraft,
      zone: "custom",
      x: Math.round(Math.min(1_920 - promoPlacementDraft.width, Math.max(0, x))),
      y: Math.round(Math.min(1_080 - promoPlacementDraft.height, Math.max(0, y))),
    });
  }

  function handlePromoPointerUp(event: ReactPointerEvent<HTMLImageElement>) {
    promoDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function savePromoPlacement() {
    if (!selectedPromo || !promoPlacementDraft || promoAction) return;
    setPromoAction("save-placement");
    try {
      const result = await api<{ promos: PromoStatus }>(`/api/promo-assets/${selectedPromo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placement: promoPlacementDraft }),
      }, csrfToken);
      setPromos(result.promos);
      setNotice({ type: "success", text: "Позицію промоматеріалу збережено." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося зберегти позицію." });
    } finally {
      setPromoAction("");
    }
  }

  async function showPromoNow() {
    if (!selectedPromo || promoAction) return;
    setPromoAction("show");
    try {
      const result = await api<{ promos: PromoStatus }>(`/api/promo-assets/${selectedPromo.id}/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ durationSeconds: promoDuration }),
      }, csrfToken);
      setPromos(result.promos);
      setNotice({ type: "success", text: "Промоматеріал показано в активному ефірі." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося показати промоматеріал." });
    } finally {
      setPromoAction("");
    }
  }

  async function hidePromo() {
    if (promoAction) return;
    setPromoAction("hide");
    try {
      const result = await api<{ promos: PromoStatus }>("/api/promos/hide", { method: "POST" }, csrfToken);
      setPromos(result.promos);
      setNotice({ type: "success", text: "Промоматеріал приховано." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося приховати промоматеріал." });
    } finally {
      setPromoAction("");
    }
  }

  async function deletePromoAsset() {
    if (!selectedPromo || promoAction || !window.confirm(`Видалити промоматеріал «${selectedPromo.name}» із сервера?`)) return;
    setPromoAction("delete");
    try {
      const result = await api<{ promos: PromoStatus }>(`/api/promo-assets/${selectedPromo.id}`, { method: "DELETE" }, csrfToken);
      setPromos(result.promos);
      const nextAsset = result.promos.assets[0] || null;
      setSelectedPromoId(nextAsset?.id || "");
      setPromoPlacementDraft(nextAsset ? { ...nextAsset.placement } : null);
      setNotice({ type: "success", text: "Промоматеріал видалено із сервера." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося видалити промоматеріал." });
    } finally {
      setPromoAction("");
    }
  }

  async function createPromoCampaign() {
    if (!selectedPromo || !campaignName.trim() || promoAction) return;
    setPromoAction("create-campaign");
    try {
      const result = await api<{ promos: PromoStatus }>("/api/promo-campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: campaignName.trim(),
          assetId: selectedPromo.id,
          status: campaignStartAt ? "SCHEDULED" : "ACTIVE",
          startAt: campaignStartAt ? new Date(campaignStartAt).toISOString() : null,
          intervalMinutes: campaignInterval,
          durationSeconds: campaignDuration,
          timezone: "Europe/Kyiv",
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        }),
      }, csrfToken);
      setPromos(result.promos);
      setCampaignName("");
      setCampaignStartAt("");
      setNotice({ type: "success", text: "Промокампанію створено." });
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося створити кампанію." });
    } finally {
      setPromoAction("");
    }
  }

  async function setCampaignStatus(campaign: PromoCampaign, status: PromoCampaign["status"]) {
    if (promoAction) return;
    setPromoAction(`campaign:${campaign.id}`);
    try {
      const result = await api<{ promos: PromoStatus }>(`/api/promo-campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      }, csrfToken);
      setPromos(result.promos);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося змінити кампанію." });
    } finally {
      setPromoAction("");
    }
  }

  async function deletePromoCampaign(campaign: PromoCampaign) {
    if (promoAction || !window.confirm(`Видалити кампанію «${campaign.name}»?`)) return;
    setPromoAction(`campaign:${campaign.id}`);
    try {
      const result = await api<{ promos: PromoStatus }>(`/api/promo-campaigns/${campaign.id}`, { method: "DELETE" }, csrfToken);
      setPromos(result.promos);
    } catch (error) {
      setNotice({ type: "error", text: error instanceof Error ? error.message : "Не вдалося видалити кампанію." });
    } finally {
      setPromoAction("");
    }
  }

  async function refreshYouTube() {
    if (youtubeAction) return;
    setYoutubeAction("refresh");
    setNotice(null);
    try {
      const result = await api<{ youtube: YouTubeStatus }>(
        "/api/youtube/refresh",
        { method: "POST" },
        csrfToken,
      );
      setYoutube(result.youtube);
      setFailedChannelAvatarUrl("");
      setNotice({ type: "success", text: "Дані YouTube оновлено поза автоматичним графіком." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося оновити YouTube.",
      });
    } finally {
      setYoutubeAction("");
    }
  }

  async function selectYouTubeBroadcast(broadcastId: string) {
    if (youtubeAction || !broadcastId) return;
    setYoutubeAction("select");
    setNotice(null);
    try {
      const result = await api<{ youtube: YouTubeStatus }>(
        "/api/youtube/broadcast/select",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ broadcastId }),
        },
        csrfToken,
      );
      setYoutube(result.youtube);
      setNotice({ type: "success", text: "Трансляцію вибрано. Сигнал і статистика оновляться автоматично." });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося вибрати трансляцію.",
      });
    } finally {
      setYoutubeAction("");
    }
  }

  async function createYouTubePreset() {
    if (youtubeAction || active) return;
    setYoutubeAction("preset");
    setNotice(null);
    try {
      const created = await api<{ preset: StreamPresetSummary }>(
        "/api/youtube/stream-preset",
        { method: "POST" },
        csrfToken,
      );
      const details = await api<{ preset: StreamPresetDetails }>(
        `/api/stream-presets/${encodeURIComponent(created.preset.id)}`,
      );
      setStreamPresets((current) => [...current, created.preset]);
      setSelectedPresetId(created.preset.id);
      setPresetName(details.preset.name);
      setStreamUrl(details.preset.streamUrl);
      setStreamKey(details.preset.streamKey);
      setStreamKeyVisible(false);
      setActiveTab("stream");
      setNotice({
        type: "success",
        text: "RTMPS-пресет YouTube створено й підставлено у форму запуску.",
      });
    } catch (error) {
      setNotice({
        type: "error",
        text: error instanceof Error ? error.message : "Не вдалося створити YouTube-пресет.",
      });
    } finally {
      setYoutubeAction("");
    }
  }

  if (authState === "loading") {
    return (
      <main className="login-shell" aria-busy="true">
        <div className="login-card login-card--loading">
          <div className="brand" aria-label="StreamLab">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            <span>StreamLab</span>
          </div>
          <p>Перевіряємо доступ…</p>
        </div>
      </main>
    );
  }

  if (authState === "anonymous") {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <div className="brand" aria-label="StreamLab">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            <span>StreamLab</span>
            <span className="mvp-tag">OWNER</span>
          </div>
          <p className="eyebrow">YouTube 24/7 Stream Manager</p>
          <h1 id="login-title">Вхід до панелі</h1>
          <p className="login-copy">Керування відео та трансляцією доступне лише власнику.</p>
          <form onSubmit={login}>
            <label className="field">
              <span>Логін</span>
              <input
                value={loginUsername}
                onChange={(event) => setLoginUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label className="field">
              <span>Пароль</span>
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {loginError && <p className="login-error" role="alert">{loginError}</p>}
            <button className="button button--primary button--full" type="submit" disabled={loginBusy}>
              {loginBusy ? "Входимо…" : "Увійти"}
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <div className={`dashboard-shell ${sidebarCollapsed ? "dashboard-shell--collapsed" : ""}`}>
      <aside className="app-sidebar" aria-label="Основна навігація">
        <div className="sidebar-header">
          <div className="sidebar-brand" aria-label="StreamLab">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            <span className="sidebar-brand-copy"><strong>StreamLab</strong><small>24/7 Manager</small></span>
          </div>
          <button
            className="sidebar-toggle"
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Розгорнути сайдбар" : "Згорнути сайдбар"}
            title={sidebarCollapsed ? "Розгорнути сайдбар" : "Згорнути сайдбар"}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        </div>

        <nav className="sidebar-nav">
          {navigationItems.map((item) => (
            <button
              className={activeTab === item.id ? "sidebar-nav-item sidebar-nav-item--active" : "sidebar-nav-item"}
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={activeTab === item.id ? "page" : undefined}
              aria-label={item.label}
              title={sidebarCollapsed ? item.label : undefined}
            >
              <span className="sidebar-nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="sidebar-nav-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
              {item.id === "library" && <span className="sidebar-nav-value">{videos.length}</span>}
              {item.id === "playlists" && <span className="sidebar-nav-value">{playlists.length}</span>}
              {item.id === "queue" && <span className="sidebar-nav-value">{queue.items.length}</span>}
              {item.id === "stream" && <span className={`sidebar-state-dot sidebar-state-dot--${stream.status.toLowerCase()}`} aria-hidden="true" />}
              {item.id === "promos" && (promos?.active
                ? <span className="sidebar-state-dot sidebar-state-dot--live" aria-hidden="true" />
                : <span className="sidebar-nav-value">{promos?.assets.length || 0}</span>)}
              {item.id === "monitoring" && <span className={`sidebar-state-dot sidebar-state-dot--${(monitoring?.status || "OFFLINE").toLowerCase()}`} aria-hidden="true" />}
              {item.id === "youtube" && <span className={`sidebar-state-dot ${youtube?.connected ? "sidebar-state-dot--live" : ""}`} aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            className={activeTab === "profile" ? "sidebar-profile sidebar-profile--active" : "sidebar-profile"}
            type="button"
            onClick={() => setActiveTab("profile")}
            aria-current={activeTab === "profile" ? "page" : undefined}
            aria-label="Профіль"
            title={sidebarCollapsed ? "Профіль" : undefined}
          >
            <span className="sidebar-profile-avatar" aria-hidden="true">{owner.slice(0, 1).toUpperCase()}</span>
            <span className="sidebar-nav-copy"><strong>{owner}</strong><small>Профіль та інтеграції</small></span>
            <span className="sidebar-profile-arrow" aria-hidden="true">›</span>
          </button>
        </div>
      </aside>

      <main className="app-main">
        <header className="page-header">
          <div className="page-heading">
            <p className="eyebrow">{pageMeta.eyebrow}</p>
            <h1>{pageMeta.title}</h1>
            <p>{pageMeta.description}</p>
          </div>
          <div className="page-status">
            <div className={`live-indicator live-indicator--${stream.status.toLowerCase()}`}>
              <span className="status-dot" aria-hidden="true" />
              {statusLabel(stream.status)}
            </div>
            <div className="page-stat"><span>Відео</span><strong>{videos.length}</strong></div>
            <div className={`page-stat realtime-state ${realtimeConnected ? "realtime-state--online" : ""}`}>
              <span>Синхронізація</span><strong>{realtimeConnected ? "онлайн" : "резервна"}</strong>
            </div>
            <div className="page-stat"><span>Uptime</span><strong>{formatDuration(stream.startedAt, now)}</strong></div>
          </div>
        </header>

        <div className="app-content">

      {!health && (
        <div className="system-banner system-banner--error" role="alert">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Медіасервер недоступний</strong>
            <p>Перевірте стан контейнера медіасервера й оновіть сторінку.</p>
          </div>
        </div>
      )}

      {health && !health.ffmpeg.available && (
        <div className="system-banner system-banner--warning" role="alert">
          <span aria-hidden="true">!</span>
          <div>
            <strong>FFmpeg не знайдено</strong>
            <p>Завантаження доступне, але підготовка відео та ефір потребують FFmpeg. Встановіть його або запустіть медіасервер через Docker.</p>
          </div>
        </div>
      )}

      {health?.storage && health.storage.level !== "OK" && (
        <div className={`system-banner system-banner--${health.storage.level === "CRITICAL" ? "error" : "warning"}`} role="alert">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Диск заповнений на {health.storage.percentUsed}%</strong>
            <p>Вільно {humanSize(health.storage.freeBytes)} з {humanSize(health.storage.totalBytes)}. Видаліть непотрібні відео до наступного завантаження.</p>
          </div>
        </div>
      )}

      {notice && (
        <div className={`notice notice--${notice.type}`} role="status">
          {notice.text}
          <button type="button" onClick={() => setNotice(null)} aria-label="Закрити повідомлення">×</button>
        </div>
      )}

      <div className="workspace-grid workspace-grid--tabs">
        {activeTab === "library" && (
        <section id="workspace-library" className="panel upload-panel" aria-labelledby="upload-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon" aria-hidden="true">▦</span>
              <h2 id="upload-title">Відеофайл</h2>
            </div>
            <span className="panel-kicker">до 50 ГБ</span>
          </div>

          <label className="field compression-profile-field">
            <span>Профіль підготовки</span>
            <select
              value={compressionProfileDraft}
              onChange={(event) => setCompressionProfileDraft(event.target.value as CompressionProfile["id"])}
              disabled={uploading}
            >
              {compressionProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.label} · {profile.videoBitrate}</option>
              ))}
            </select>
            <small>{compressionProfiles.find((profile) => profile.id === compressionProfileDraft)?.description || "Профіль застосовується до нових завантажень."}</small>
          </label>

          <label
            className={`dropzone ${selectedFile ? "dropzone--selected" : ""} ${dragActive ? "dropzone--dragging" : ""}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            aria-disabled={uploading}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/x-matroska,video/webm,.m4v"
              onChange={handleFile}
              disabled={uploading}
            />
            <span className="upload-glyph" aria-hidden="true">↑</span>
            {dragActive ? (
              <>
                <strong>Відпустіть файл, щоб додати його</strong>
                <span>Підтримуються MP4, MOV, MKV, WEBM і M4V</span>
              </>
            ) : selectedFile ? (
              <>
                <strong>{selectedFile.name}</strong>
                <span>{humanSize(selectedFile.size)}</span>
              </>
            ) : (
              <>
                <strong>Перетягніть відео сюди</strong>
                <span>або натисніть, щоб вибрати MP4, MOV, MKV чи WEBM</span>
              </>
            )}
          </label>

          {(uploading || uploadProgress > 0) && (
            <div className="progress-block">
              <div className="progress-copy">
                <span>{uploading ? "Завантаження" : "Готово"}</span>
                <strong>{uploadProgress}%</strong>
              </div>
              <div className="progress-track" role="progressbar" aria-valuenow={uploadProgress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
            </div>
          )}

          {activeUploads.length > 0 && !uploading && (
            <div className="interrupted-uploads" role="status">
              <strong>Незавершені завантаження</strong>
              {activeUploads.map((upload) => (
                <div key={upload.id}>
                  <span><b>{upload.name}</b><small>{Math.round((upload.uploadedBytes / upload.size) * 100)}% · {humanSize(upload.uploadedBytes)} з {humanSize(upload.size)}</small></span>
                  <span>Оберіть цей самий файл, щоб продовжити</span>
                  <button type="button" onClick={() => cancelInterruptedUpload(upload)}>Скасувати</button>
                </div>
              ))}
            </div>
          )}

          <button
            className="button button--secondary button--full"
            type="button"
            onClick={uploadVideo}
            disabled={!selectedFile || uploading || !health}
          >
            {uploading ? "Завантажуємо…" : "Завантажити відео"}
          </button>

          <div className="video-list-heading">
            <h3>Бібліотека</h3>
            <span>{videos.length}</span>
          </div>
          <div className="video-list">
            {videos.length === 0 ? (
              <div className="empty-state">Після завантаження відео з’явиться тут.</div>
            ) : (
              videos.map((video) => {
                const ready = video.status === "READY";
                const processing = ["ANALYZING", "PROCESSING"].includes(video.status);
                return (
                  <div
                    className={`video-row video-row--${video.status.toLowerCase()}`}
                    key={video.id}
                  >
                    <div className="video-row-main">
                      <span className={`video-thumb ${video.thumbnailUrl ? "video-thumb--image" : ""}`} aria-hidden="true">
                        {video.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={video.thumbnailUrl} alt="" loading="lazy" />
                        ) : video.status === "FAILED" ? "!" : ready ? "▶" : "…"}
                      </span>
                      <span className="video-copy">
                        <strong>{video.name}</strong>
                        <span>{videoMeta(video)} · {videoStatusLabel(video)}</span>
                      </span>
                      <div className="video-library-actions">
                        {ready ? (
                          <button
                            className="video-add-queue"
                            type="button"
                            onClick={() => addVideoToQueue(video.id)}
                            disabled={Boolean(queueAction) || Boolean(deletingVideoId)}
                          >
                            {queueAction === `add:${video.id}` ? "Додаємо…" : "+ До черги"}
                          </button>
                        ) : (
                        <span className={`video-status video-status--${video.status.toLowerCase()}`}>
                          {video.status === "FAILED" ? "FAILED" : "PROCESSING"}
                        </span>
                        )}
                        <button
                          className="video-delete"
                          type="button"
                          onClick={() => deleteVideo(video)}
                          disabled={
                            processing ||
                            Boolean(deletingVideoId) ||
                            (active && stream.videoId === video.id)
                          }
                        >
                          {deletingVideoId === video.id ? "Видаляємо…" : "Видалити"}
                        </button>
                      </div>
                    </div>
                    {processing && (
                      <div
                        className="video-processing-track"
                        role="progressbar"
                        aria-label={`Підготовка ${video.name}`}
                        aria-valuenow={video.processingProgress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span style={{ width: `${video.processingProgress}%` }} />
                      </div>
                    )}
                    {video.status === "FAILED" && (
                      <div className="video-processing-error" role="alert">
                        <span>{video.processingError || "Не вдалося підготувати відео."}</span>
                        <button
                          type="button"
                          onClick={() => retryVideoProcessing(video.id)}
                          disabled={Boolean(processingAction)}
                        >
                          {processingAction === video.id ? "Запускаємо…" : "Повторити"}
                        </button>
                      </div>
                    )}
                    {ready && (
                      <div className="video-thumbnail-upload">
                        <div className="video-thumbnail-copy">
                          <span>Власне прев’ю</span>
                          <strong>PNG → компактний WebP 16:9</strong>
                        </div>
                        <label className="video-thumbnail-button" aria-disabled={Boolean(thumbnailAction)}>
                          {thumbnailAction === video.id ? "Конвертуємо…" : video.thumbnailUrl ? "Замінити PNG" : "Завантажити PNG"}
                          <input
                            type="file"
                            accept="image/png,.png"
                            disabled={Boolean(thumbnailAction)}
                            onChange={(event) => {
                              void uploadVideoThumbnail(video, event.target.files?.[0] || null);
                              event.currentTarget.value = "";
                            }}
                          />
                        </label>
                        {video.thumbnailError && (
                          <p role="alert">{video.thumbnailError}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
        )}

        {activeTab === "stream" && (
        <section id="workspace-stream" className="panel stream-panel" aria-labelledby="stream-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon" aria-hidden="true">▶</span>
              <h2 id="stream-title">Запуск ефіру</h2>
            </div>
            <span className="panel-kicker">RTMPS</span>
          </div>

          <form onSubmit={startStream}>
            <div className="preset-manager">
              <div className="preset-fields">
                <label className="field">
                  <span>Пресет підключення</span>
                  <select
                    value={selectedPresetId}
                    onChange={(event) => void loadStreamPreset(event.target.value)}
                    disabled={active || Boolean(presetAction)}
                  >
                    <option value="">Без пресету</option>
                    {streamPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.name} · {preset.streamKeyMasked}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Назва пресету</span>
                  <input
                    value={presetName}
                    onChange={(event) => setPresetName(event.target.value)}
                    placeholder="Наприклад, Основний канал"
                    maxLength={80}
                    disabled={active || Boolean(presetAction)}
                  />
                </label>
              </div>
              <div className="preset-actions">
                <button type="button" onClick={beginNewStreamPreset} disabled={active || Boolean(presetAction)}>
                  Новий
                </button>
                <button
                  className="preset-save"
                  type="button"
                  onClick={() => void saveStreamPreset()}
                  disabled={
                    active ||
                    Boolean(presetAction) ||
                    !presetName.trim() ||
                    !streamUrl.trim() ||
                    !streamKey.trim()
                  }
                >
                  {presetAction === "save" ? "Зберігаємо…" : selectedPresetId ? "Оновити" : "Зберегти"}
                </button>
                <button
                  className="preset-delete"
                  type="button"
                  onClick={() => void deleteStreamPreset()}
                  disabled={active || Boolean(presetAction) || !selectedPresetId}
                >
                  Видалити
                </button>
              </div>
              <p>Пресети зберігаються на сервері у зашифрованому вигляді.</p>
            </div>

            <label className="field">
              <span>Server URL</span>
              <input
                type="url"
                value={streamUrl}
                onChange={(event) => setStreamUrl(event.target.value)}
                placeholder="rtmps://a.rtmps.youtube.com/live2"
                disabled={active}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>Stream key</span>
              <div className="secret-input">
                <input
                  type={streamKeyVisible ? "text" : "password"}
                  value={streamKey}
                  onChange={(event) => setStreamKey(event.target.value)}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  disabled={active}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setStreamKeyVisible((visible) => !visible)}
                  aria-label={streamKeyVisible ? "Приховати stream key" : "Показати stream key"}
                  aria-pressed={streamKeyVisible}
                  disabled={!streamKey}
                >
                  {streamKeyVisible ? "Сховати" : "Показати"}
                </button>
              </div>
              <small>Ключ залишається у полі після запуску та за замовчуванням прихований.</small>
            </label>

            <label className="field">
              <span>Резервне відео</span>
              <select
                value={fallbackVideoDraft}
                onChange={(event) => setFallbackVideoDraft(event.target.value)}
                disabled={active || settingsAction}
              >
                <option value="">Не вибрано</option>
                {videos.filter((video) => video.status === "READY").map((video) => (
                  <option key={video.id} value={video.id}>{video.name}</option>
                ))}
              </select>
              <small>Вмикається, якщо черга порожня або поточний файл не відтворюється.</small>
            </label>

            <label className="field">
              <span>Профіль підготовки нових відео</span>
              <select
                value={compressionProfileDraft}
                onChange={(event) => setCompressionProfileDraft(event.target.value as CompressionProfile["id"])}
                disabled={active || settingsAction}
              >
                {compressionProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.label} · {profile.videoBitrate} / {profile.audioBitrate}</option>
                ))}
              </select>
              <small>Зміна не перекодовує вже готові файли й застосовується до наступних завантажень.</small>
            </label>

            <div className="bitrate-control">
              <label className="field" htmlFor="video-bitrate">
                <span>Відеобітрейт</span>
                <div className="bitrate-input">
                  <input
                    id="video-bitrate"
                    type="number"
                    min={3000}
                    max={12000}
                    step={500}
                    value={bitrateDraft}
                    onChange={(event) => setBitrateDraft(Number(event.target.value))}
                    disabled={active || settingsAction}
                  />
                  <span>Кбіт/с</span>
                </div>
                <small>Діапазон 3000–12000. Зміна застосовується при наступному запуску.</small>
              </label>
              <button
                className="button button--quiet bitrate-save"
                type="button"
                onClick={() => void saveStreamSettings()}
                disabled={
                  active ||
                  settingsAction ||
                  !Number.isInteger(bitrateDraft) ||
                  bitrateDraft < 3000 ||
                  bitrateDraft > 12000 ||
                  (
                    streamSettings?.videoBitrateKbps === bitrateDraft &&
                    (streamSettings?.fallbackVideoId ?? "") === fallbackVideoDraft &&
                    streamSettings?.compressionProfile === compressionProfileDraft
                  )
                }
              >
                {settingsAction ? "Зберігаємо…" : "Зберегти профіль"}
              </button>
            </div>

            <div className="output-card">
              <span className="output-label">Вихідний профіль</span>
              <div className="output-grid">
                <div><span>Роздільність</span><strong>1080p</strong></div>
                <div><span>Частота</span><strong>30 FPS</strong></div>
                <div><span>Відео</span><strong>H.264</strong></div>
                <div>
                  <span>Бітрейт</span>
                  <strong>{((active ? stream.videoBitrateKbps : bitrateDraft) / 1000).toFixed(1)} Мбіт/с</strong>
                </div>
              </div>
            </div>

            {!active ? (
              <button className="button button--primary button--full" type="submit" disabled={!readyToStart || streamAction}>
                <span className="button-play" aria-hidden="true">▶</span>
                {streamAction ? "Запускаємо…" : "Запустити трансляцію"}
              </button>
            ) : (
              <div className="stream-controls">
                <button className="button button--quiet" type="button" onClick={skipStreamVideo} disabled={streamAction || stream.status === "STOPPING"}>
                  <span className="button-skip" aria-hidden="true">⏭</span>
                  Пропустити відео
                </button>
                <button className="button button--danger" type="button" onClick={stopStream} disabled={streamAction}>
                  <span className="button-stop" aria-hidden="true" />
                  {streamAction ? "Виконуємо…" : "Зупинити трансляцію"}
                </button>
              </div>
            )}
          </form>

          <div className={`stream-card stream-card--${stream.status.toLowerCase()}`}>
            <div className="stream-card-top">
              <div>
                <span className="stream-pulse" aria-hidden="true" />
                <strong>{statusLabel(stream.status)}</strong>
              </div>
              <span>{formatDuration(stream.startedAt, now)}</span>
            </div>
            <div className="now-playing">
              <span>Зараз транслюється</span>
              <strong>{stream.videoName || queue.items[0]?.video?.name || "Черга ще порожня"}</strong>
            </div>
            {active && stream.durationMs > 0 && (
              <div className="playback-progress">
                <div className="playback-progress-track" aria-hidden="true">
                  <span style={{ width: `${playbackProgress}%` }} />
                </div>
                <div>
                  <span>{formatMediaTime(stream.positionMs)}</span>
                  <span>{formatMediaTime(stream.durationMs)}</span>
                </div>
              </div>
            )}
            {active && stream.nextVideoName && (
              <p className="stream-next">Далі: <strong>{stream.nextVideoName}</strong></p>
            )}
            {stream.status === "RECONNECTING" && (
              <div className="reconnect-info" role="status">
                <span>Спроба {stream.reconnectAttempt}</span>
                <strong>Наступний запуск {formatRetry(stream.nextRetryAt, now)}</strong>
              </div>
            )}
            {stream.restoredAfterRestart && stream.autoResumeEnabled && (
              <p className="auto-resume-note">Автовідновлення після перезапуску сервісу активне.</p>
            )}
            {stream.lastError && <p className="stream-error">{stream.lastError}</p>}
            {!stream.lastError && stream.lastFailure && (
              <p className="stream-history">Останнє відновлення: {stream.lastFailure}</p>
            )}
          </div>

          {stream.logs.length > 0 && (
            <details className="log-details">
              <summary>Останні повідомлення FFmpeg</summary>
              <pre>{stream.logs.slice(-8).join("\n")}</pre>
            </details>
          )}
        </section>
        )}

        {activeTab === "promos" && (
        <section id="workspace-promos" className="panel promo-panel" aria-labelledby="promo-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon" aria-hidden="true">◇</span>
              <h2 id="promo-title">Промоматеріали та кампанії</h2>
            </div>
            <span className={`promo-live-state ${promos?.active ? "promo-live-state--active" : ""}`}>
              {promos?.active ? "промо в ефірі" : "промо неактивне"}
            </span>
          </div>

          {!promos ? (
            <div className="monitoring-empty">Завантажуємо промоматеріали…</div>
          ) : (
            <div className="promo-workspace">
              <div className="promo-library-column">
                <div className="promo-upload-card">
                  <div className="promo-card-heading">
                    <div><span>Бібліотека</span><strong>Новий матеріал</strong></div>
                    <span>{promos.assets.length}</span>
                  </div>
                  <label className="promo-file-picker">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                      onChange={(event) => setPromoFile(event.target.files?.[0] || null)}
                      disabled={Boolean(promoAction)}
                    />
                    <span aria-hidden="true">＋</span>
                    <div>
                      <strong>{promoFile?.name || "Оберіть PNG, JPG або WebP"}</strong>
                      <small>{promoFile ? humanSize(promoFile.size) : "Матеріал буде нормалізовано у WebP"}</small>
                    </div>
                  </label>
                  <label className="field promo-small-field">
                    <span>Назва</span>
                    <input value={promoName} onChange={(event) => setPromoName(event.target.value)} placeholder="Наприклад, QR Instagram" />
                  </label>
                  <label className="field promo-small-field">
                    <span>Теги через кому</span>
                    <input value={promoTags} onChange={(event) => setPromoTags(event.target.value)} placeholder="qr, social, right" />
                  </label>
                  <button className="button button--primary button--full" type="button" onClick={createPromoAsset} disabled={!promoFile || Boolean(promoAction)}>
                    {promoAction === "upload" ? "Конвертуємо…" : "Додати до бібліотеки"}
                  </button>
                </div>

                <div className="promo-asset-list">
                  {promos.assets.length === 0 ? (
                    <div className="empty-state">Додайте перший банер або QR-код.</div>
                  ) : promos.assets.map((asset) => (
                    <button
                      type="button"
                      className={selectedPromoId === asset.id ? "promo-asset-card promo-asset-card--active" : "promo-asset-card"}
                      key={asset.id}
                      onClick={() => {
                        setSelectedPromoId(asset.id);
                        setPromoPlacementDraft({ ...asset.placement });
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={asset.fileUrl} alt="" loading="lazy" />
                      <span><strong>{asset.name}</strong><small>{asset.width}×{asset.height} · {humanSize(asset.size)}</small></span>
                      <b>{asset.impressions}</b>
                    </button>
                  ))}
                </div>
              </div>

              <div className="promo-editor-column">
                {!selectedPromo || !promoPlacementDraft ? (
                  <div className="promo-editor-empty">Оберіть матеріал у бібліотеці для позиціонування.</div>
                ) : (
                  <>
                    <div className="promo-editor-toolbar">
                      <div><span>Візуальний редактор 1920×1080</span><strong>{selectedPromo.name}</strong></div>
                      <button type="button" onClick={deletePromoAsset} disabled={Boolean(promoAction)}>Видалити</button>
                    </div>
                    <div className="promo-canvas" aria-label="Попередній перегляд розміщення промоматеріалу">
                      <div className="promo-safe-area" aria-hidden="true" />
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selectedPromo.fileUrl}
                        alt={`Розміщення ${selectedPromo.name}`}
                        style={{
                          left: `${(promoPlacementDraft.x / 1_920) * 100}%`,
                          top: `${(promoPlacementDraft.y / 1_080) * 100}%`,
                          width: `${(promoPlacementDraft.width / 1_920) * 100}%`,
                          height: `${(promoPlacementDraft.height / 1_080) * 100}%`,
                          opacity: promoPlacementDraft.opacity,
                          zIndex: promoPlacementDraft.zIndex + 1,
                        }}
                        onPointerDown={handlePromoPointerDown}
                        onPointerMove={handlePromoPointerMove}
                        onPointerUp={handlePromoPointerUp}
                        onPointerCancel={handlePromoPointerUp}
                      />
                    </div>

                    <div className="promo-zone-picker" aria-label="Готові зони">
                      {["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right", "fullscreen"].map((zone) => (
                        <button key={zone} type="button" className={promoPlacementDraft.zone === zone ? "promo-zone--active" : ""} onClick={() => applyPromoZone(zone)}>
                          {zone.replace("top", "верх").replace("bottom", "низ").replace("center", "центр").replace("left", "ліво").replace("right", "право").replace("fullscreen", "на весь екран")}
                        </button>
                      ))}
                    </div>

                    <div className="promo-controls-grid">
                      <label><span>X</span><input type="number" min={0} max={1_920 - promoPlacementDraft.width} value={promoPlacementDraft.x} onChange={(event) => setPromoPlacementDraft({ ...promoPlacementDraft, x: Number(event.target.value), zone: "custom" })} /></label>
                      <label><span>Y</span><input type="number" min={0} max={1_080 - promoPlacementDraft.height} value={promoPlacementDraft.y} onChange={(event) => setPromoPlacementDraft({ ...promoPlacementDraft, y: Number(event.target.value), zone: "custom" })} /></label>
                      <label><span>Ширина</span><input type="number" min={32} max={1_920} value={promoPlacementDraft.width} onChange={(event) => setPromoPlacementDraft({ ...promoPlacementDraft, width: Number(event.target.value), zone: "custom" })} /></label>
                      <label><span>Висота</span><input type="number" min={32} max={1_080} value={promoPlacementDraft.height} onChange={(event) => setPromoPlacementDraft({ ...promoPlacementDraft, height: Number(event.target.value), zone: "custom" })} /></label>
                      <label className="promo-opacity-control"><span>Прозорість · {Math.round(promoPlacementDraft.opacity * 100)}%</span><input type="range" min={0.05} max={1} step={0.05} value={promoPlacementDraft.opacity} onChange={(event) => setPromoPlacementDraft({ ...promoPlacementDraft, opacity: Number(event.target.value) })} /></label>
                    </div>

                    <div className="promo-editor-actions">
                      <button className="button button--quiet" type="button" onClick={savePromoPlacement} disabled={Boolean(promoAction)}>
                        {promoAction === "save-placement" ? "Зберігаємо…" : "Зберегти позицію"}
                      </button>
                      <label><span>Показувати</span><input type="number" min={1} max={3_600} value={promoDuration} onChange={(event) => setPromoDuration(Number(event.target.value))} /><small>с</small></label>
                      {promos.active ? (
                        <button className="button button--danger" type="button" onClick={hidePromo} disabled={Boolean(promoAction)}>Приховати</button>
                      ) : (
                        <button className="button button--primary" type="button" onClick={showPromoNow} disabled={!active || Boolean(promoAction)}>Показати зараз</button>
                      )}
                    </div>
                    {!active && <p className="promo-stream-note">Ручний показ стане доступним після запуску ефіру.</p>}
                  </>
                )}
              </div>

              <div className="promo-campaigns">
                <div className="promo-card-heading">
                  <div><span>Автоматизація</span><strong>Промокампанії</strong></div>
                  <span>{promos.campaigns.length}</span>
                </div>
                <div className="promo-campaign-form">
                  <label className="field"><span>Назва кампанії</span><input value={campaignName} onChange={(event) => setCampaignName(event.target.value)} placeholder="QR кожні 30 хвилин" /></label>
                  <label className="field"><span>Інтервал, хв</span><input type="number" min={1} max={1_440} value={campaignInterval} onChange={(event) => setCampaignInterval(Number(event.target.value))} /></label>
                  <label className="field"><span>Тривалість, с</span><input type="number" min={1} max={3_600} value={campaignDuration} onChange={(event) => setCampaignDuration(Number(event.target.value))} /></label>
                  <label className="field"><span>Початок (необов’язково)</span><input type="datetime-local" value={campaignStartAt} onChange={(event) => setCampaignStartAt(event.target.value)} /></label>
                  <button className="button button--primary" type="button" onClick={createPromoCampaign} disabled={!selectedPromo || !campaignName.trim() || Boolean(promoAction)}>Створити кампанію</button>
                </div>
                <div className="promo-campaign-list">
                  {promos.campaigns.length === 0 ? (
                    <div className="empty-state">Створіть кампанію для показу матеріалу за інтервалом.</div>
                  ) : promos.campaigns.map((campaign) => {
                    const campaignAsset = promos.assets.find((asset) => asset.id === campaign.assetId);
                    const running = ["ACTIVE", "SCHEDULED"].includes(campaign.status);
                    return (
                      <div className="promo-campaign-row" key={campaign.id}>
                        <span className={`promo-campaign-status promo-campaign-status--${campaign.status.toLowerCase()}`} />
                        <div><strong>{campaign.name}</strong><small>{campaignAsset?.name || "Матеріал видалено"} · кожні {campaign.intervalMinutes} хв · {campaign.durationSeconds} с</small></div>
                        <span><b>{campaign.impressions}</b><small>показів</small></span>
                        <button type="button" onClick={() => setCampaignStatus(campaign, running ? "PAUSED" : "ACTIVE")} disabled={Boolean(promoAction)}>{running ? "Пауза" : "Запустити"}</button>
                        <button className="promo-campaign-delete" type="button" onClick={() => deletePromoCampaign(campaign)} disabled={Boolean(promoAction)}>×</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>
        )}

        {activeTab === "monitoring" && (
        <section id="workspace-monitoring" className="panel monitoring-panel" aria-labelledby="monitoring-title">
          <div className="panel-heading monitoring-heading">
            <div>
              <span className="section-icon" aria-hidden="true">⌁</span>
              <h2 id="monitoring-title">Моніторинг ефіру</h2>
            </div>
            <div className="monitoring-range" aria-label="Період графіків">
              {([1, 24, 168] as MonitoringRange[]).map((hours) => (
                <button
                  key={hours}
                  className={monitoringRange === hours ? "monitoring-range--active" : ""}
                  type="button"
                  onClick={() => setMonitoringRange(hours)}
                >
                  {hours === 1 ? "1 год" : hours === 24 ? "24 год" : "7 днів"}
                </button>
              ))}
            </div>
          </div>

          {!systemStatus ? (
            <div className="system-monitoring-empty">Очікуємо перший знімок ресурсів сервера…</div>
          ) : (
            <div className="system-monitoring" aria-label="Ресурси сервера у реальному часі">
              <div className="system-monitoring-heading">
                <div>
                  <span className="system-live-dot" aria-hidden="true" />
                  <div>
                    <span>Сервер у реальному часі</span>
                    <strong>{systemStatus.system.hostname}</strong>
                  </div>
                </div>
                <time dateTime={systemStatus.updatedAt}>
                  LIVE · {new Date(systemStatus.updatedAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
              </div>

              <div className="system-metrics">
                <div className="system-metric">
                  <span>Процесор</span>
                  <strong>{formatMetric(systemStatus.cpu.usagePercent, "%", 1)}</strong>
                  <div className="system-meter" aria-hidden="true"><i style={{ width: `${systemStatus.cpu.usagePercent ?? 0}%` }} /></div>
                  <small>{systemStatus.cpu.cores} ядер · load {formatMetric(systemStatus.cpu.loadAverage[0], "", 2)}</small>
                </div>
                <div className="system-metric">
                  <span>Оперативна пам’ять</span>
                  <strong>{formatMetric(systemStatus.memory.usagePercent, "%", 1)}</strong>
                  <div className="system-meter" aria-hidden="true"><i style={{ width: `${systemStatus.memory.usagePercent ?? 0}%` }} /></div>
                  <small>{humanSize(systemStatus.memory.usedBytes)} з {humanSize(systemStatus.memory.totalBytes)}</small>
                </div>
                <div className={`system-metric system-metric--${systemStatus.disk.level.toLowerCase()}`}>
                  <span>Диск із медіа</span>
                  <strong>{formatMetric(systemStatus.disk.percentUsed, "%", 1)}</strong>
                  <div className="system-meter" aria-hidden="true"><i style={{ width: `${systemStatus.disk.percentUsed}%` }} /></div>
                  <small>{humanSize(systemStatus.disk.freeBytes)} вільно</small>
                </div>
                <div className="system-metric">
                  <span>Мережа</span>
                  <strong>↓ {formatRate(systemStatus.network.receivedBytesPerSecond)}</strong>
                  <div className="system-network-out">↑ {formatRate(systemStatus.network.transmittedBytesPerSecond)}</div>
                  <small>поточна швидкість контейнера</small>
                </div>
              </div>

              <div className="system-detail-grid">
                <div className="system-history-card">
                  <div className="system-card-heading">
                    <div><span>Навантаження</span><strong>Останні {Math.round((systemStatus.history.length * systemStatus.intervalMs) / 1_000)} секунд</strong></div>
                    <span>CPU / RAM</span>
                  </div>
                  <div className="system-history-row">
                    <b>CPU</b>
                    <div aria-label="Історія завантаження процесора">
                      {systemStatus.history.map((sample) => (
                        <i
                          key={`cpu-${sample.capturedAt}`}
                          style={{ height: `${Math.max(2, sample.cpuUsagePercent ?? 0)}%` }}
                          title={`${formatMetric(sample.cpuUsagePercent, "%", 1)} · ${formatEventTime(sample.capturedAt)}`}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="system-history-row system-history-row--memory">
                    <b>RAM</b>
                    <div aria-label="Історія використання оперативної пам’яті">
                      {systemStatus.history.map((sample) => (
                        <i
                          key={`ram-${sample.capturedAt}`}
                          style={{ height: `${Math.max(2, sample.memoryUsagePercent ?? 0)}%` }}
                          title={`${formatMetric(sample.memoryUsagePercent, "%", 1)} · ${formatEventTime(sample.capturedAt)}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="system-hardware-card">
                  <div className="system-card-heading">
                    <div><span>Залізо та система</span><strong>{systemStatus.cpu.model}</strong></div>
                  </div>
                  <dl>
                    <div><dt>CPU</dt><dd>{systemStatus.cpu.cores} × {formatMetric(systemStatus.cpu.speedMhz, " МГц")}</dd></div>
                    <div><dt>Температура</dt><dd>{formatMetric(systemStatus.cpu.temperatureCelsius, " °C", 1)}</dd></div>
                    <div><dt>RAM процесу</dt><dd>{humanSize(systemStatus.memory.processRssBytes)}</dd></div>
                    <div><dt>Система</dt><dd>{systemStatus.system.platform} {systemStatus.system.release} · {systemStatus.system.architecture}</dd></div>
                    <div><dt>Uptime сервера</dt><dd>{formatMediaTime(systemStatus.system.uptimeSeconds * 1_000)}</dd></div>
                  </dl>
                  <p>Температура відображається лише тоді, коли VPS передає її контейнеру.</p>
                </div>
              </div>
            </div>
          )}

          {!monitoring ? (
            <div className="monitoring-empty">Завантажуємо показники ефіру…</div>
          ) : (
            <div className="monitoring-dashboard">
              <div className={`monitoring-status-card monitoring-status-card--${monitoring.status.toLowerCase()}`}>
                <span className="monitoring-status-icon" aria-hidden="true" />
                <div>
                  <span>Загальний стан</span>
                  <strong>{monitoringStatusLabel(monitoring.status)}</strong>
                  <p>{monitoring.reason}</p>
                </div>
                <time dateTime={monitoring.updatedAt}>Оновлено {formatEventTime(monitoring.updatedAt)}</time>
              </div>

              <div className="monitoring-metrics">
                <div>
                  <span>Фактичний бітрейт</span>
                  <strong>{formatMetric(monitoring.current.bitrateKbps, " Кбіт/с")}</strong>
                  <small>ціль {formatMetric(monitoring.current.targetBitrateKbps, " Кбіт/с")}</small>
                </div>
                <div>
                  <span>Частота кадрів</span>
                  <strong>{formatMetric(monitoring.current.fps, " FPS", 1)}</strong>
                  <small>ціль 30 FPS</small>
                </div>
                <div>
                  <span>Швидкість кодування</span>
                  <strong>{formatMetric(monitoring.current.speed, "×", 2)}</strong>
                  <small>норма від 0,98×</small>
                </div>
                <div>
                  <span>Пропущені кадри</span>
                  <strong>{monitoring.current.droppedFrames.toLocaleString("uk-UA")}</strong>
                  <small>дубльовано {monitoring.current.duplicateFrames.toLocaleString("uk-UA")}</small>
                </div>
                <div>
                  <span>RTMPS-відновлення</span>
                  <strong>{monitoring.session.restarts}</strong>
                  <small>за поточну сесію</small>
                </div>
                <div>
                  <span>Uptime</span>
                  <strong>{formatMediaTime(monitoring.session.uptimeMs)}</strong>
                  <small>безперервна робота</small>
                </div>
                <div>
                  <span>Глядачі зараз</span>
                  <strong>{monitoring.current.viewers.toLocaleString("uk-UA")}</strong>
                  <small>пік {monitoring.session.peakViewers.toLocaleString("uk-UA")}</small>
                </div>
                <div>
                  <span>Сигнал YouTube</span>
                  <strong>{youtubeHealthLabel(monitoring.current.youtubeHealth || "noData")}</strong>
                  <small>{youtube?.connected ? "канал підключено" : "канал не підключено"}</small>
                </div>
              </div>

              <div className="monitoring-chart-grid">
                <div className="monitoring-chart-card">
                  <div className="monitoring-chart-heading">
                    <div><span>Вихідний бітрейт</span><strong>Кбіт/с</strong></div>
                    <span>ціль {formatMetric(monitoring.current.targetBitrateKbps)}</span>
                  </div>
                  {monitoring.history.some((item) => item.bitrateKbps !== null) ? (
                    <div className="monitoring-chart" aria-label="Історія вихідного бітрейту">
                      {monitoring.history.map((item) => (
                        <span
                          key={`bitrate-${item.capturedAt}`}
                          title={`${formatEventTime(item.capturedAt)} · ${formatMetric(item.bitrateKbps, " Кбіт/с")}`}
                        >
                          <i
                            className={`monitoring-chart-bar monitoring-chart-bar--${item.healthStatus.toLowerCase()}`}
                            style={{ height: `${Math.max(2, ((item.bitrateKbps ?? 0) / monitoringBitrateMax) * 100)}%` }}
                          />
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="monitoring-chart-empty">Графік з’явиться після запуску ефіру.</div>
                  )}
                </div>

                <div className="monitoring-chart-card">
                  <div className="monitoring-chart-heading">
                    <div><span>Швидкість кодування</span><strong>відносно реального часу</strong></div>
                    <span>норма ≥ 0,98×</span>
                  </div>
                  {monitoring.history.some((item) => item.speed !== null) ? (
                    <div className="monitoring-chart" aria-label="Історія швидкості кодування">
                      {monitoring.history.map((item) => (
                        <span
                          key={`speed-${item.capturedAt}`}
                          title={`${formatEventTime(item.capturedAt)} · ${formatMetric(item.speed, "×", 2)}`}
                        >
                          <i
                            className={`monitoring-chart-bar monitoring-chart-bar--${item.healthStatus.toLowerCase()}`}
                            style={{ height: `${Math.max(2, Math.min(100, ((item.speed ?? 0) / 1.05) * 100))}%` }}
                          />
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="monitoring-chart-empty">Ще немає даних про швидкість FFmpeg.</div>
                  )}
                </div>
              </div>

              <div className="monitoring-events">
                <div className="monitoring-events-heading">
                  <div><span>Журнал подій</span><strong>Останні зміни стану</strong></div>
                  <span>{monitoring.events.length}</span>
                </div>
                {monitoring.events.length ? (
                  <div className="monitoring-event-list">
                    {monitoring.events.slice(0, 24).map((event) => (
                      <div className={`monitoring-event monitoring-event--${event.severity}`} key={event.id}>
                        <span className="monitoring-event-dot" aria-hidden="true" />
                        <p>{event.message}</p>
                        <time dateTime={event.occurredAt}>{formatEventTime(event.occurredAt)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="monitoring-events-empty">Подій ще немає. Тут з’являться запуск, зупинка, відновлення та зміни відео.</div>
                )}
              </div>

              <div className="monitoring-events audit-events">
                <div className="monitoring-events-heading">
                  <div><span>Аудит дій</span><strong>Зміни власника та API</strong></div>
                  <span>{auditEntries.length}</span>
                </div>
                {auditEntries.length ? (
                  <div className="monitoring-event-list">
                    {auditEntries.map((entry) => (
                      <div className={`monitoring-event monitoring-event--${entry.status === "SUCCESS" ? "success" : "critical"}`} key={entry.id}>
                        <span className="monitoring-event-dot" aria-hidden="true" />
                        <p><b>{entry.action}</b> · {entry.actor}</p>
                        <time dateTime={entry.occurredAt}>{formatEventTime(entry.occurredAt)}</time>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="monitoring-events-empty">Журнал заповниться після першої зміни налаштувань або контенту.</div>
                )}
              </div>
            </div>
          )}
        </section>
        )}

        {activeTab === "youtube" && (
        <section id="workspace-youtube" className="panel youtube-panel" aria-labelledby="youtube-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon section-icon--text" aria-hidden="true">YT</span>
              <h2 id="youtube-title">YouTube</h2>
            </div>
            <span className={`youtube-connection ${youtube?.connected ? "youtube-connection--active" : ""}`}>
              {youtube?.connected ? "канал підключено" : "не підключено"}
            </span>
          </div>

          {!youtube?.configured ? (
            <div className="youtube-empty">
              <strong>OAuth ще не налаштовано</strong>
              <p>Додайте три GOOGLE_OAUTH змінні на сервері та перезапустіть контейнери.</p>
            </div>
          ) : !youtube.connected ? (
            <div className="youtube-connect">
              <div>
                <span className="youtube-logo" aria-hidden="true">▶</span>
                <div>
                  <strong>YouTube-канал ще не підключено</strong>
                  <p>Керування інтеграціями тепер знаходиться на екрані профілю.</p>
                </div>
              </div>
              <button
                className="button button--primary"
                type="button"
                onClick={() => setActiveTab("profile")}
              >
                Перейти до профілю
              </button>
            </div>
          ) : (
            <div className="youtube-dashboard">
              <div className="youtube-toolbar">
                <div className="youtube-channel">
                  <span
                    className="youtube-avatar"
                    role="img"
                    aria-label={`Аватар каналу ${youtube.channel?.title || "YouTube"}`}
                  >
                    {(youtube.channel?.title || "Y").slice(0, 1).toUpperCase()}
                    {youtube.channel?.thumbnailUrl && failedChannelAvatarUrl !== youtube.channel.thumbnailUrl && (
                      // The URL is returned by the authenticated YouTube API and can use changing Google hosts.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={youtube.channel.thumbnailUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        onError={() => setFailedChannelAvatarUrl(youtube.channel?.thumbnailUrl || "")}
                      />
                    )}
                  </span>
                  <div>
                    <span>Підключений канал</span>
                    <strong>{youtube.channel?.title || "Очікує синхронізації"}</strong>
                  </div>
                </div>
                <div className="youtube-toolbar-actions">
                  <button type="button" onClick={refreshYouTube} disabled={Boolean(youtubeAction)}>
                    {youtubeAction === "refresh" ? "Синхронізуємо…" : "Оновити зараз"}
                  </button>
                </div>
              </div>

              <div className="youtube-manual-sync" role="note">
                Автосинхронізація активна: метрики — кожні {youtube.polling.metricsSeconds} с, сигнал — {youtube.polling.streamSeconds} с,
                статус ефіру — {youtube.polling.broadcastSeconds} с, підписники — {youtube.polling.subscribersMinutes} хв,
                Analytics — {youtube.polling.analyticsMinutes} хв. Орієнтовно {youtube.polling.estimatedDailyUnits.toLocaleString("uk-UA")} одиниць квоти на добу.
                {youtube.lastUpdatedAt && <span> Остання синхронізація: {new Date(youtube.lastUpdatedAt).toLocaleString("uk-UA")}.</span>}
              </div>

              <div className="youtube-broadcast-row">
                <label className="field">
                  <span>Активна трансляція</span>
                  <select
                    value={youtube.selected?.id || ""}
                    onChange={(event) => void selectYouTubeBroadcast(event.target.value)}
                    disabled={Boolean(youtubeAction) || youtube.broadcasts.length === 0}
                  >
                    {youtube.broadcasts.length === 0 && <option value="">Немає активних або запланованих ефірів</option>}
                    {youtube.broadcasts.map((broadcast) => (
                      <option key={broadcast.id} value={broadcast.id}>
                        {broadcast.title} · {youtubeBroadcastStatus(broadcast.lifeCycleStatus)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button--quiet youtube-preset-button"
                  type="button"
                  onClick={createYouTubePreset}
                  disabled={Boolean(youtubeAction) || active || !youtube.stream?.ingestionReady}
                >
                  {youtubeAction === "preset" ? "Створюємо…" : "Створити RTMPS-пресет"}
                </button>
              </div>

              <div className="youtube-metrics" aria-label="Поточні показники YouTube">
                <div>
                  <span>Глядачі зараз</span>
                  <strong>{youtube.metrics?.viewers.toLocaleString("uk-UA") ?? "—"}</strong>
                </div>
                <div>
                  <span>Перегляди</span>
                  <strong>{youtube.metrics?.views.toLocaleString("uk-UA") ?? "—"}</strong>
                </div>
                <div>
                  <span>Вподобання</span>
                  <strong>{youtube.metrics?.likes.toLocaleString("uk-UA") ?? "—"}</strong>
                </div>
                <div className={`youtube-health youtube-health--${youtube.stream?.healthStatus || "nodata"}`}>
                  <span>Сигнал YouTube</span>
                  <strong>{youtubeHealthLabel(youtube.stream?.healthStatus)}</strong>
                </div>
              </div>

              <div className="youtube-detail-grid">
                <div className="youtube-chart-card">
                  <div className="youtube-card-heading">
                    <div>
                      <span>Глядачі</span>
                      <strong>Останні 24 години</strong>
                    </div>
                    <span>пік {youtubeChartMax.toLocaleString("uk-UA")}</span>
                  </div>
                  {youtubeChart.length > 1 ? (
                    <div className="youtube-chart" aria-label="Історія одночасних глядачів">
                      {youtubeChart.map((item) => (
                        <span
                          key={`${item.capturedAt}-${item.broadcastId}`}
                          style={{ height: `${Math.max(4, (item.viewers / youtubeChartMax) * 100)}%` }}
                          title={`${item.viewers} · ${new Date(item.capturedAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}`}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="youtube-chart-empty">Графік з’явиться після перших двох знімків статистики.</p>
                  )}
                </div>

                <div className="youtube-quota-card">
                  <div className="youtube-card-heading">
                    <div>
                      <span>API квота</span>
                      <strong>{youtube.quota.used.toLocaleString("uk-UA")} / {youtube.quota.limit.toLocaleString("uk-UA")}</strong>
                    </div>
                    <span>{Math.max(0, Math.round((youtube.quota.remaining / youtube.quota.limit) * 100))}% вільно</span>
                  </div>
                  <div className="youtube-quota-track" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, (youtube.quota.used / youtube.quota.limit) * 100)}%` }} />
                  </div>
                  <p>Polling розподілено так, щоб залишатися нижче стандартного ліміту 10 000 одиниць на добу.</p>
                </div>

                <div className="youtube-quota-card youtube-analytics-card">
                  <div className="youtube-card-heading">
                    <div>
                      <span>YouTube Analytics</span>
                      <strong>{youtube.analytics?.available ? `${Math.round(youtube.analytics.estimatedMinutesWatched || 0).toLocaleString("uk-UA")} хв перегляду` : "Очікує доступу"}</strong>
                    </div>
                    <span>{youtube.analytics?.updatedAt ? formatEventTime(youtube.analytics.updatedAt) : `кожні ${youtube.polling.analyticsMinutes} хв`}</span>
                  </div>
                  <p>{youtube.analytics?.reconnectRequired
                    ? "Щоб увімкнути Analytics, один раз перепідключіть YouTube у профілі для нового read-only дозволу."
                    : `Середній перегляд: ${formatMediaTime((youtube.analytics?.averageViewDurationSeconds || 0) * 1_000)}.`}</p>
                </div>
              </div>

              {youtube.stream?.configurationIssues.length ? (
                <div className="youtube-issues" role="status">
                  <strong>Зауваження YouTube до сигналу</strong>
                  <ul>
                    {youtube.stream.configurationIssues.map((issue, index) => (
                      <li key={`${issue.type}-${index}`}>
                        {issue.description || issue.reason || issue.type}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {youtube.lastError && <p className="youtube-error">{youtube.lastError}</p>}
            </div>
          )}
        </section>
        )}

        {activeTab === "profile" && (
        <section id="workspace-profile" className="panel profile-panel" aria-labelledby="profile-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon" aria-hidden="true">{owner.slice(0, 1).toUpperCase()}</span>
              <h2 id="profile-title">Профіль власника</h2>
            </div>
            <span className="panel-kicker">OWNER</span>
          </div>

          <div className="profile-grid">
            <article className="profile-card profile-account-card">
              <div className="profile-card-heading">
                <div><span>Обліковий запис</span><strong>Доступ до StreamLab</strong></div>
                <span className="integration-status integration-status--active">активний</span>
              </div>
              <div className="profile-owner">
                <span className="profile-owner-avatar" aria-hidden="true">{owner.slice(0, 1).toUpperCase()}</span>
                <div><strong>{owner}</strong><span>Власник робочого простору</span></div>
              </div>
              <p>Поточна сесія захищена HttpOnly cookie та автоматично завершується через 12 годин.</p>
              <button className="button button--danger profile-logout" type="button" onClick={logout}>Вийти з профілю</button>
            </article>

            <article className="profile-card profile-integration-card">
              <div className="profile-card-heading">
                <div><span>Інтеграція</span><strong>YouTube</strong></div>
                <span className={`integration-status ${youtube?.connected ? "integration-status--active" : ""}`}>
                  {youtube?.connected ? "підключено" : "не підключено"}
                </span>
              </div>
              {youtube?.connected ? (
                <div className="integration-connected">
                  <span className="youtube-avatar profile-youtube-avatar" aria-hidden="true">
                    {(youtube.channel?.title || "Y").slice(0, 1).toUpperCase()}
                    {youtube.channel?.thumbnailUrl && failedChannelAvatarUrl !== youtube.channel.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={youtube.channel.thumbnailUrl}
                        alt=""
                        referrerPolicy="no-referrer"
                        onError={() => setFailedChannelAvatarUrl(youtube.channel?.thumbnailUrl || "")}
                      />
                    )}
                  </span>
                  <div>
                    <strong>{youtube.channel?.title || "YouTube-канал"}</strong>
                    <span>Аналітика й дані трансляцій доступні</span>
                  </div>
                </div>
              ) : (
                <div className="integration-empty">
                  <span className="youtube-logo" aria-hidden="true">▶</span>
                  <div>
                    <strong>Підключіть канал через Google</strong>
                    <p>StreamLab запитує лише доступ для читання каналу, ефірів і показників.</p>
                  </div>
                </div>
              )}
              {!youtube?.configured && (
                <p className="integration-warning">Спочатку додайте GOOGLE_OAUTH змінні на сервері.</p>
              )}
              <div className="profile-card-actions">
                {youtube?.connected ? (
                  <>
                    <button className="button button--quiet" type="button" onClick={() => setActiveTab("youtube")}>Відкрити YouTube</button>
                    <button className="button button--danger" type="button" onClick={disconnectYouTube} disabled={Boolean(youtubeAction)}>
                      {youtubeAction === "disconnect" ? "Відключаємо…" : "Відключити"}
                    </button>
                  </>
                ) : (
                  <button className="button button--primary button--full" type="button" onClick={connectYouTube} disabled={!youtube?.configured || Boolean(youtubeAction)}>
                    {youtubeAction === "connect" ? "Переходимо до Google…" : "Підключити YouTube"}
                  </button>
                )}
              </div>
            </article>

            <article className="profile-card profile-integration-card profile-telegram-card">
              <div className="profile-card-heading">
                <div><span>Інтеграція</span><strong>Telegram Bot</strong></div>
                <span className={`integration-status ${telegram?.connected ? "integration-status--active" : ""}`}>
                  {telegram?.connected ? "підключено" : "не підключено"}
                </span>
              </div>
              {telegram?.connected && (
                <div className="integration-connected telegram-connected">
                  <span className="telegram-bot-avatar" aria-hidden="true">TG</span>
                  <div>
                    <strong>{telegram.bot?.displayName || telegram.bot?.username || "Telegram-бот"}</strong>
                    <span>{telegram.bot?.username ? `@${telegram.bot.username}` : `Bot ID ${telegram.bot?.id}`} · {telegram.tokenMasked}</span>
                  </div>
                </div>
              )}
              <form
                className="telegram-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connectTelegram();
                }}
              >
                <label className="field">
                  <span>{telegram?.connected ? "Новий bot token" : "Bot token від @BotFather"}</span>
                  <div className="secret-input">
                    <input
                      type={telegramTokenVisible ? "text" : "password"}
                      value={telegramToken}
                      onChange={(event) => setTelegramToken(event.target.value)}
                      placeholder={telegram?.connected ? "Вставте токен, щоб замінити поточний" : "123456789:AA…"}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={Boolean(telegramAction)}
                    />
                    <button type="button" onClick={() => setTelegramTokenVisible((visible) => !visible)} disabled={!telegramToken}>
                      {telegramTokenVisible ? "Сховати" : "Показати"}
                    </button>
                  </div>
                  <small>Перед збереженням StreamLab перевірить токен через Telegram API. Повне значення більше не показується.</small>
                </label>
                <div className="profile-card-actions">
                  <button className="button button--primary" type="submit" disabled={!telegramToken.trim() || Boolean(telegramAction)}>
                    {telegramAction === "connect" ? "Перевіряємо…" : telegram?.connected ? "Замінити токен" : "Підключити бота"}
                  </button>
                  {telegram?.connected && (
                    <button className="button button--danger" type="button" onClick={disconnectTelegram} disabled={Boolean(telegramAction)}>
                      {telegramAction === "disconnect" ? "Відключаємо…" : "Відключити"}
                    </button>
                  )}
                </div>
              </form>
            </article>
          </div>
        </section>
        )}

        {activeTab === "playlists" && (
        <section id="workspace-playlists" className="panel playlists-panel" aria-labelledby="playlists-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon" aria-hidden="true">☷</span>
              <h2 id="playlists-title">Збережені плейлисти</h2>
            </div>
            <span className="panel-kicker">{playlists.length}</span>
          </div>

          <div className="playlist-manager">
            <label className="field">
              <span>Активний плейлист</span>
              <select
                value={selectedPlaylistId}
                onChange={(event) => {
                  setSelectedPlaylistId(event.target.value);
                  setPlaylistName("");
                }}
                disabled={Boolean(playlistAction) || playlists.length === 0}
              >
                {playlists.length === 0 && <option value="">Плейлистів ще немає</option>}
                {playlists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>{playlist.name} · {playlist.items.length}</option>
                ))}
              </select>
            </label>
            <label className="field playlist-name-field">
              <span>Назва</span>
              <input
                value={playlistName}
                onChange={(event) => setPlaylistName(event.target.value)}
                placeholder={selectedPlaylist ? selectedPlaylist.name : "Наприклад, Нічний ефір"}
                maxLength={120}
                disabled={Boolean(playlistAction)}
              />
            </label>
            <div className="playlist-manager-actions">
              <button className="button button--primary" type="button" onClick={createPlaylist} disabled={!playlistName.trim() || Boolean(playlistAction)}>Створити</button>
              <button className="button button--quiet" type="button" onClick={renamePlaylist} disabled={!selectedPlaylist || !playlistName.trim() || Boolean(playlistAction)}>Перейменувати</button>
              <button className="button button--danger" type="button" onClick={deletePlaylist} disabled={!selectedPlaylist || Boolean(playlistAction)}>Видалити</button>
            </div>
          </div>

          {selectedPlaylist ? (
            <div className="playlist-workspace">
              <div className="playlist-column">
                <div className="video-list-heading"><h3>{selectedPlaylist.name}</h3><span>{selectedPlaylist.items.length}</span></div>
                {selectedPlaylist.items.length === 0 ? (
                  <div className="empty-state">Додайте готові відео з колонки бібліотеки.</div>
                ) : (
                  <div className="playlist-item-list">
                    {selectedPlaylist.items.map((item, index) => (
                      <div className="playlist-item" key={item.id}>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <div><strong>{item.video?.name || "Відео недоступне"}</strong><small>{item.video ? videoMeta(item.video) : "Файл видалено"}</small></div>
                        <div>
                          <button type="button" onClick={() => movePlaylistItem(item.id, -1)} disabled={index === 0 || Boolean(playlistAction)} aria-label="Перемістити вище">↑</button>
                          <button type="button" onClick={() => movePlaylistItem(item.id, 1)} disabled={index === selectedPlaylist.items.length - 1 || Boolean(playlistAction)} aria-label="Перемістити нижче">↓</button>
                          <button type="button" onClick={() => removePlaylistItem(item.id)} disabled={Boolean(playlistAction)}>Прибрати</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <button className="button button--secondary button--full" type="button" onClick={loadPlaylist} disabled={active || selectedPlaylist.items.length === 0 || Boolean(playlistAction)}>
                  {active ? "Зупиніть ефір, щоб замінити чергу" : playlistAction === "load" ? "Завантажуємо…" : "Завантажити плейлист у чергу"}
                </button>
              </div>
              <div className="playlist-column playlist-library-column">
                <div className="video-list-heading"><h3>Готові відео</h3><span>{videos.filter((video) => video.status === "READY").length}</span></div>
                <div className="playlist-library-list">
                  {videos.filter((video) => video.status === "READY").map((video) => (
                    <div className="playlist-library-item" key={video.id}>
                      <div><strong>{video.name}</strong><small>{videoMeta(video)}</small></div>
                      <button type="button" onClick={() => addVideoToPlaylist(video.id)} disabled={Boolean(playlistAction)}>
                        {playlistAction === `add:${video.id}` ? "Додаємо…" : "+ Додати"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-state">Створіть перший плейлист, щоб зберігати набори відео.</div>
          )}
        </section>
        )}

        {activeTab === "queue" && (
        <section id="workspace-queue" className="panel queue-panel" aria-labelledby="queue-title">
          <div className="panel-heading">
            <div>
              <span className="section-icon" aria-hidden="true">≡</span>
              <h2 id="queue-title">Черга трансляції</h2>
            </div>
            <span className="panel-kicker">{queue.items.length} · LOOP</span>
          </div>

          <div className="queue-summary">
            <div>
              <span>Зараз</span>
              <strong>{stream.videoName || "Ефір не запущено"}</strong>
            </div>
            <div>
              <span>Наступне</span>
              <strong>{stream.nextVideoName || nextQueueItem?.video?.name || "Черга порожня"}</strong>
            </div>
            <div>
              <span>Режим</span>
              <strong>Циклічно</strong>
            </div>
          </div>

          {queue.items.length === 0 ? (
            <div className="queue-empty">
              Черга порожня. Додайте готові відео кнопкою «До черги» в бібліотеці.
            </div>
          ) : (
            <div className="queue-list">
              {queue.items.map((item, index) => {
                const isCurrent = active && (stream.queueItemId
                  ? stream.queueItemId === item.id
                  : stream.videoId === item.videoId);
                return (
                <div
                  className={`queue-row ${isCurrent ? "queue-row--locked queue-row--current" : ""} ${draggedQueueItemId === item.id ? "queue-row--dragging" : ""} ${queueDropTarget?.itemId === item.id ? `queue-row--drop-${queueDropTarget.edge}` : ""}`}
                  key={item.id}
                  draggable={!queueAction && !isCurrent}
                  onDragStart={(event) => handleQueueDragStart(event, item.id)}
                  onDragOver={(event) => handleQueueDragOver(event, item.id)}
                  onDrop={(event) => handleQueueDrop(event, item.id)}
                  onDragEnd={() => {
                    setDraggedQueueItemId("");
                    setQueueDropTarget(null);
                  }}
                  aria-grabbed={draggedQueueItemId === item.id}
                >
                  <span className="queue-grip" aria-hidden="true">⋮⋮</span>
                  <span className="queue-position">{String(index + 1).padStart(2, "0")}</span>
                  <span className="queue-copy">
                    <strong>{item.video?.name || "Відео недоступне"}</strong>
                    <span>
                      {item.video ? videoMeta(item.video) : "Файл видалено з бібліотеки"}
                      {isCurrent ? " · зараз в ефірі" : ""}
                    </span>
                  </span>
                  <div className="queue-actions">
                    <button
                      type="button"
                      title="Перемістити вище"
                      aria-label={`Перемістити ${item.video?.name || "відео"} вище`}
                      onClick={() => moveQueueItem(item.id, -1)}
                      disabled={isCurrent || index === 0 || Boolean(queueAction)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Перемістити нижче"
                      aria-label={`Перемістити ${item.video?.name || "відео"} нижче`}
                      onClick={() => moveQueueItem(item.id, 1)}
                      disabled={isCurrent || index === queue.items.length - 1 || Boolean(queueAction)}
                    >
                      ↓
                    </button>
                    <button
                      className="queue-next"
                      type="button"
                      onClick={() => playQueueItemNext(item.id)}
                      disabled={isCurrent || stream.nextQueueItemId === item.id || (!active && index === 0) || Boolean(queueAction)}
                    >
                      {queueAction === `next:${item.id}` ? "Зберігаємо…" : "Наступним"}
                    </button>
                    <button
                      className="queue-remove"
                      type="button"
                      title="Прибрати з черги"
                      aria-label={`Прибрати ${item.video?.name || "відео"} з черги`}
                      onClick={() => removeQueueItem(item.id)}
                      disabled={isCurrent || Boolean(queueAction)}
                    >
                      ×
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
          )}

          <p className="queue-note">
            {active
              ? "Майбутню чергу можна змінювати прямо під час ефіру. Поточне відео захищене; для переходу скористайтеся кнопкою «Пропустити відео»."
              : "Перетягніть відео у потрібне місце. Після останнього елемента черга автоматично почнеться з першого."}
          </p>
        </section>
        )}
      </div>

      <footer>
        <span>
          OWNER-захист активний · {stream.autoResumeEnabled ? "автовідновлення увімкнене" : "стрім зупинений вручну"}
        </span>
        <span className={health?.ffmpeg.available ? "footer-ok" : "footer-muted"}>
          FFmpeg {health?.ffmpeg.available ? "готовий" : "не підключений"}
        </span>
      </footer>
        </div>
      </main>
    </div>
  );
}
