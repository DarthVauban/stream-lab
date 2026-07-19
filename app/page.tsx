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
  status: "STOPPED" | "STARTING" | "LIVE" | "RECONNECTING" | "STOPPING" | "ERROR";
  videoId: string | null;
  videoName: string | null;
  queueItemId: string | null;
  playlistLength: number;
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

function statusLabel(status: StreamStatus["status"]) {
  return {
    STOPPED: "Зупинено",
    STARTING: "Запуск",
    LIVE: "В ефірі",
    RECONNECTING: "Відновлення",
    STOPPING: "Зупинка",
    ERROR: "Помилка",
  }[status];
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
  const [streamAction, setStreamAction] = useState(false);
  const [notice, setNotice] = useState<{ type: "error" | "success"; text: string } | null>(null);
  const [now, setNow] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const [healthResult, videosResult, streamResult, queueResult] = await Promise.all([
        api<Health>("/api/health"),
        api<{ videos: Video[] }>("/api/videos"),
        api<{ stream: StreamStatus }>("/api/stream/status"),
        api<{ queue: QueueState }>("/api/queue"),
      ]);
      setHealth(healthResult);
      setVideos(videosResult.videos);
      setStream(streamResult.stream);
      setQueue(queueResult.queue);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        setAuthState("anonymous");
        setOwner("");
        setCsrfToken("");
      }
      setHealth(null);
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

  const active = ["LIVE", "STARTING", "RECONNECTING", "STOPPING"].includes(stream.status);
  const currentQueueIndex = stream.queueItemId
    ? queue.items.findIndex((item) => item.id === stream.queueItemId)
    : stream.videoId
      ? queue.items.findIndex((item) => item.videoId === stream.videoId)
    : -1;
  const nextQueueItem = queue.items.length > 0
    ? queue.items[currentQueueIndex >= 0 ? (currentQueueIndex + 1) % queue.items.length : 0]
    : null;
  const readyToStart = Boolean(
    queue.items.length > 0 && streamUrl.trim() && streamKey.trim() && health?.ffmpeg.available,
  );

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
      setNotice({ type: "success", text: "Відео переміщено на початок черги." });
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
    if (!draggedQueueItemId || draggedQueueItemId === targetItemId || queueAction || active) {
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
    if (!sourceItemId || sourceItemId === targetItemId || queueAction || active) {
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

  async function startStream(event: FormEvent) {
    event.preventDefault();
    if (!readyToStart || streamAction) return;
    setStreamAction(true);
    setNotice(null);
    try {
      const result = await api<{ stream: StreamStatus }>("/api/stream/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamUrl, streamKey }),
      }, csrfToken);
      setStream(result.stream);
      setStreamKey("");
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
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="StreamLab">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>StreamLab</span>
          <span className="mvp-tag">MVP</span>
        </div>
        <div className="topbar-actions">
          <div className={`live-indicator live-indicator--${stream.status.toLowerCase()}`}>
            <span className="status-dot" aria-hidden="true" />
            {statusLabel(stream.status)}
          </div>
          <span className="owner-name">{owner}</span>
          <button className="logout-button" type="button" onClick={logout}>Вийти</button>
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">YouTube 24/7 Stream Manager</p>
          <h1>Одне відео. Один ефір. Без зайвого.</h1>
          <p className="hero-copy">
            Завантажте відео, дочекайтеся автоматичної підготовки, додайте дані
            трансляції YouTube і запустіть циклічний стрім через FFmpeg.
          </p>
        </div>
        <div className="hero-stats" aria-label="Поточний стан">
          <div>
            <span>Відео</span>
            <strong>{videos.length}</strong>
          </div>
          <div>
            <span>Uptime</span>
            <strong>{formatDuration(stream.startedAt, now)}</strong>
          </div>
        </div>
      </section>

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

      <div className="workspace-grid">
        <section className="panel upload-panel" aria-labelledby="upload-title">
          <div className="panel-heading">
            <div>
              <span className="step-number">01</span>
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
                            disabled={active || Boolean(queueAction) || Boolean(deletingVideoId)}
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
                          disabled={active || processing || Boolean(deletingVideoId)}
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

        <section className="panel stream-panel" aria-labelledby="stream-title">
          <div className="panel-heading">
            <div>
              <span className="step-number">02</span>
              <h2 id="stream-title">Запуск ефіру</h2>
            </div>
            <span className="panel-kicker">RTMPS</span>
          </div>

          <form onSubmit={startStream}>
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
              <input
                type="password"
                value={streamKey}
                onChange={(event) => setStreamKey(event.target.value)}
                placeholder="xxxx-xxxx-xxxx-xxxx"
                disabled={active}
                autoComplete="off"
              />
              <small>Ключ передається лише під час запуску й не повертається в інтерфейс.</small>
            </label>

            <div className="output-card">
              <span className="output-label">Вихідний профіль</span>
              <div className="output-grid">
                <div><span>Роздільність</span><strong>1080p</strong></div>
                <div><span>Частота</span><strong>30 FPS</strong></div>
                <div><span>Відео</span><strong>H.264</strong></div>
                <div><span>Бітрейт</span><strong>10 Мбіт/с</strong></div>
              </div>
            </div>

            {!active ? (
              <button className="button button--primary button--full" type="submit" disabled={!readyToStart || streamAction}>
                <span className="button-play" aria-hidden="true">▶</span>
                {streamAction ? "Запускаємо…" : "Запустити трансляцію"}
              </button>
            ) : (
              <button className="button button--danger button--full" type="button" onClick={stopStream} disabled={streamAction}>
                <span className="button-stop" aria-hidden="true" />
                {streamAction ? "Зупиняємо…" : "Зупинити трансляцію"}
              </button>
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

        <section className="panel queue-panel" aria-labelledby="queue-title">
          <div className="panel-heading">
            <div>
              <span className="step-number">03</span>
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
              <strong>{nextQueueItem?.video?.name || "Черга порожня"}</strong>
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
              {queue.items.map((item, index) => (
                <div
                  className={`queue-row ${active ? "queue-row--locked" : ""} ${draggedQueueItemId === item.id ? "queue-row--dragging" : ""} ${(stream.queueItemId ? stream.queueItemId === item.id : stream.videoId === item.videoId) ? "queue-row--current" : ""} ${queueDropTarget?.itemId === item.id ? `queue-row--drop-${queueDropTarget.edge}` : ""}`}
                  key={item.id}
                  draggable={!queueAction && !active}
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
                      {(stream.queueItemId ? stream.queueItemId === item.id : stream.videoId === item.videoId) ? " · зараз в ефірі" : ""}
                    </span>
                  </span>
                  <div className="queue-actions">
                    <button
                      type="button"
                      title="Перемістити вище"
                      aria-label={`Перемістити ${item.video?.name || "відео"} вище`}
                      onClick={() => moveQueueItem(item.id, -1)}
                      disabled={active || index === 0 || Boolean(queueAction)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      title="Перемістити нижче"
                      aria-label={`Перемістити ${item.video?.name || "відео"} нижче`}
                      onClick={() => moveQueueItem(item.id, 1)}
                      disabled={active || index === queue.items.length - 1 || Boolean(queueAction)}
                    >
                      ↓
                    </button>
                    <button
                      className="queue-next"
                      type="button"
                      onClick={() => playQueueItemNext(item.id)}
                      disabled={active || index === 0 || Boolean(queueAction)}
                    >
                      {queueAction === `next:${item.id}` ? "Зберігаємо…" : "Наступним"}
                    </button>
                    <button
                      className="queue-remove"
                      type="button"
                      title="Прибрати з черги"
                      aria-label={`Прибрати ${item.video?.name || "відео"} з черги`}
                      onClick={() => removeQueueItem(item.id)}
                      disabled={active || Boolean(queueAction)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <p className="queue-note">
            {active
              ? "Черга зараз відтворюється циклічно. Зупиніть ефір, щоб змінити її порядок або склад."
              : "Перетягніть відео у потрібне місце. Після останнього елемента черга автоматично почнеться з першого."}
          </p>
        </section>
      </div>

      <footer>
        <span>
          OWNER-захист активний · {stream.autoResumeEnabled ? "автовідновлення увімкнене" : "стрім зупинений вручну"}
        </span>
        <span className={health?.ffmpeg.available ? "footer-ok" : "footer-muted"}>
          FFmpeg {health?.ffmpeg.available ? "готовий" : "не підключений"}
        </span>
      </footer>
    </main>
  );
}
