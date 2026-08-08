FROM node:22-bookworm-slim

ARG HIGGSFIELD_CLI_VERSION=1.1.22

WORKDIR /app

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global "@higgsfield/cli@${HIGGSFIELD_CLI_VERSION}"

COPY services/higgsfield-worker/server.mjs services/higgsfield-worker/server.mjs
COPY services/higgsfield-worker/start.sh services/higgsfield-worker/start.sh
RUN chmod 755 services/higgsfield-worker/start.sh

ENV NODE_ENV=production
ENV HIGGSFIELD_WORKER_HOST=0.0.0.0

EXPOSE 8788

CMD ["/app/services/higgsfield-worker/start.sh"]
