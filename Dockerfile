FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN npx playwright install --with-deps chromium \
    && mkdir -p /data \
    && chown -R node:node /app /data /ms-playwright

USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["daemon"]
