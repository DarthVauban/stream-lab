FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node media-server ./media-server
COPY --chmod=755 docker-entrypoint-media.sh /usr/local/bin/streamlab-media-entrypoint

ENV MEDIA_API_HOST=0.0.0.0 \
    MEDIA_API_PORT=8788 \
    MEDIA_DATA_DIR=/app/data \
    FFMPEG_PATH=ffmpeg

EXPOSE 8788
VOLUME ["/app/data"]

ENTRYPOINT ["streamlab-media-entrypoint"]
CMD ["node", "media-server/server.mjs"]

