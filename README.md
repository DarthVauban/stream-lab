# StreamLab MVP

Мінімальний локальний застосунок для двох дій:

1. завантажити один або декілька готових відеофайлів;
2. вибрати файл і запустити його циклічну RTMPS-трансляцію на YouTube через FFmpeg.

Це свідомо вузький MVP. Тут ще немає авторизації, черги, транскодування бібліотеки,
автоматичного reconnect, промоматеріалів, Telegram і статистики YouTube.

## Що потрібно

- Node.js 22.13 або новіший;
- FFmpeg у `PATH`, або Docker Desktop;
- RTMPS URL та stream key із YouTube Live Control Room;
- стабільний upload приблизно 12–15 Мбіт/с для профілю 1080p30.

## Найпростіший запуск через Docker

Локально досить підняти лише медіасервер (містить FFmpeg), а вебінтерфейс запустити
окремо в dev-режимі:

```powershell
docker compose up --build media-server
```

В іншому терміналі:

```powershell
npm install
npm run dev:web
```

Відкрийте `http://127.0.0.1:5173`.

### Продакшн (обидва сервіси в Docker)

`compose.yaml` містить також сервіс `web` (Next.js, standalone-збірка з `Dockerfile.web`).
Для нього `NEXT_PUBLIC_MEDIA_API_URL` вшивається під час *збірки* образу, тож перед
`docker compose up -d --build` пропишіть у `.env` реальну публічну адресу сервера:

```
NEXT_PUBLIC_MEDIA_API_URL=http://<SERVER_IP>:8788
MEDIA_ALLOWED_ORIGINS=http://<SERVER_IP>:3000
```

Якщо образ `web` збирається в CI (`.github/workflows/deploy.yml`), те саме значення
треба задати як GitHub Actions secret `NEXT_PUBLIC_MEDIA_API_URL` — інакше в
задеплоєному образі залишиться дефолтний `http://127.0.0.1:8788`.

```powershell
docker compose up -d --build
```

## Запуск із локальним FFmpeg

Скопіюйте `.env.example` у `.env`. Якщо FFmpeg не доданий до `PATH`, задайте
абсолютний `FFMPEG_PATH`.

```powershell
npm install
npm run dev
```

Команда одночасно запустить вебінтерфейс на порту `5173` і медіасервер на
порту `8788`.

## Як запустити тестовий ефір

1. У YouTube Studio створіть трансляцію через encoder. Для першого тесту оберіть
   доступ «За посиланням».
2. У StreamLab завантажте MP4, MOV, MKV, WEBM або M4V.
3. Виберіть готовий файл.
4. Вставте RTMPS Server URL і Stream key.
5. Натисніть «Запустити трансляцію» та перевірте появу сигналу в YouTube Live
   Control Room.

Stream key не записується до каталогу відео й не повертається через API. Цей MVP
не має авторизації, тому медіасервер за замовчуванням слухає лише `127.0.0.1`.
Не відкривайте порт `8788` у публічний інтернет.

## Перевірка

```powershell
npm test
npm run build
```

Завантажені файли та локальний каталог зберігаються у `data/`, який виключений із Git.

