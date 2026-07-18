FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY media-server ./media-server

ENV MEDIA_API_HOST=0.0.0.0 \
    MEDIA_API_PORT=8788 \
    MEDIA_DATA_DIR=/app/data \
    FFMPEG_PATH=ffmpeg

EXPOSE 8788
VOLUME ["/app/data"]

CMD ["node", "media-server/server.mjs"]

