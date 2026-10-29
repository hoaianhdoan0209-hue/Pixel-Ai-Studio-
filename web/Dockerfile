# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=extra_ca \
    if [ -f /run/secrets/extra_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm ci --no-audit --no-fund; \
    else npm ci --no-audit --no-fund; fi
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
