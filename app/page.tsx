"use client";

import {
  ChangeEvent,
  DragEvent as ReactDragEvent,
  FormEvent,
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
  updatedAt: string | null;
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

type AuthSession =
  | { authenticated: false }
  | { authenticated: true; owner: string; csrfToken: string; expiresAt: string };

type WorkspaceTab = "library" | "queue" | "stream" | "monitoring" | "youtube" | "profile";
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
  lastUpdatedAt: string | null;
  lastError: string | null;
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
  const [stream, setStream] = useState<StreamStatus>(emptyStream);
  const [queue, setQueue] = useState<QueueState>(emptyQueue);
  const [streamSettings, setStreamSettings] = useState<StreamSettings | null>(null);
  const [bitrateDraft, setBitrateDraft] = useState(8000);
  const [fallbackVideoDraft, setFallbackVideoDraft] = useState("");
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
  const [monitoringRange, setMonitoringRange] = useState<MonitoringRange>(24);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramTokenVisible, setTelegramTokenVisible] = useState(false);
  const [telegramAction, setTelegramAction] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("stream");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [failedChannelAvatarUrl, setFailedChannelAvatarUrl] = useState("");
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [now, setNow] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [healthResult, videosResult, streamResult, queueResult, youtubeResult] = await Promise.all([
        api<Health>("/api/health"),
        api<{ videos: Video[] }>("/api/videos"),
        api<{ stream: StreamStatus }>("/api/stream/status"),
        api<{ queue: QueueState }>("/api/queue"),
        api<{ youtube: YouTubeStatus }>("/api/youtube/status"),
      ]);
      setHealth(healthResult);
      setVideos(videosResult.videos);
      setStream(streamResult.stream);
      setQueue(queueResult.queue);
      setYoutube(youtubeResult.youtube);
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
      const result = await api<{ monitoring: MonitoringStatus }>(`/api/monitoring/status?hours=${hours}`);
      setMonitoring(result.monitoring);
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
    const poll = window.setInterval(refresh, 2000);
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
    const result = new URLSearchParams(window.location.search).get("youtube");
    if (!result) return;
    const notification = window.setTimeout(() => {
      setActiveTab("profile");
      setNotice(
        result === "connected"
          ? { type: "success", text: "YouTube-канал підключено." }
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
    ])
      .then(([{ settings }, { presets }, { telegram }]) => {
        if (cancelled) return;
        setStreamSettings(settings);
        setBitrateDraft(settings.videoBitrateKbps);
        setFallbackVideoDraft(settings.fallbackVideoId ?? "");
        setStreamPresets(presets);
        setTelegram(telegram);
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
    queue: { eyebrow: "Плейлист", title: "Черга трансляції", description: "Порядок безперервного відтворення в ефірі." },
    stream: { eyebrow: "Трансляція", title: "Керування ефіром", description: "Профіль сигналу, RTMPS-підключення та запуск." },
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
    { id: "queue", icon: "≡", label: "Черга", description: "Порядок ефіру" },
    { id: "stream", icon: "▶", label: "Ефір", description: "Запуск і керування" },
    { id: "monitoring", icon: "⌁", label: "Моніторинг", description: "Якість сигналу" },
    { id: "youtube", icon: "YT", label: "YouTube", description: "Канал і аналітика" },
  ];

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
      setStream(emptyStream);
      setQueue(emptyQueue);
      setStreamSettings(null);
      setBitrateDraft(8000);
      setFallbackVideoDraft("");
      setStreamPresets([]);
      setSelectedPresetId("");
      setPresetName("");
      setStreamKey("");
      setStreamKeyVisible(false);
      setYoutube(null);
      setYoutubeAction("");
      setMonitoring(null);
      setMonitoringRange(24);
      setTelegram(null);
      setTelegramToken("");
      setTelegramTokenVisible(false);
      setTelegramAction("");
      setActiveTab("stream");
      setFailedChannelAvatarUrl("");
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
        }),
      }, csrfToken);

      let offset = created.upload.uploadedBytes;
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
        }),
      }, csrfToken);
      setStreamSettings(result.settings);
      setBitrateDraft(result.settings.videoBitrateKbps);
      setFallbackVideoDraft(result.settings.fallbackVideoId ?? "");
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
        (streamSettings?.fallbackVideoId ?? "") !== fallbackVideoDraft
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
      setNotice({ type: "success", text: "Дані YouTube оновлено." });
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
      setNotice({ type: "success", text: "Активну трансляцію YouTube змінено." });
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
              {item.id === "queue" && <span className="sidebar-nav-value">{queue.items.length}</span>}
              {item.id === "stream" && <span className={`sidebar-state-dot sidebar-state-dot--${stream.status.toLowerCase()}`} aria-hidden="true" />}
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
                      <span className="video-thumb" aria-hidden="true">
                        {video.status === "FAILED" ? "!" : ready ? "▶" : "…"}
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
                    (streamSettings?.fallbackVideoId ?? "") === fallbackVideoDraft
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
                    <strong>{youtube.channel?.title || "Завантажуємо канал…"}</strong>
                  </div>
                </div>
                <div className="youtube-toolbar-actions">
                  <button type="button" onClick={refreshYouTube} disabled={Boolean(youtubeAction)}>
                    {youtubeAction === "refresh" ? "Оновлюємо…" : "Оновити"}
                  </button>
                </div>
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
                  <p>Опитування розподілені так, щоб стандартної денної квоти вистачало на безперервну роботу.</p>
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
