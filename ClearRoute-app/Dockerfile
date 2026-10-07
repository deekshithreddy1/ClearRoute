FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run verify

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001 CLEARROUTE_BIND_HOST=0.0.0.0 CLEARROUTE_DATA_DIR=/app/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir data && chown node:node data
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-backend ./dist-backend
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-backend/index.js"]
