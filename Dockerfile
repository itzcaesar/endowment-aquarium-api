FROM node:26.5.0-alpine AS base
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json eslint.config.mjs .prettierrc.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/game-api/package.json apps/game-api/package.json
COPY apps/mock-endowment-api/package.json apps/mock-endowment-api/package.json
RUN npm ci
COPY packages packages
COPY apps apps
COPY README.md ./
RUN npm run build --workspace=@telu/contracts

FROM base AS build
RUN npm run build

FROM node:26.5.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/contracts ./packages/contracts
COPY --from=build /app/apps/game-api/dist ./apps/game-api/dist
COPY --from=base /app/apps/game-api/public ./apps/game-api/public
COPY --from=build /app/apps/mock-endowment-api/dist ./apps/mock-endowment-api/dist
COPY --from=base /app/apps/game-api/package.json ./apps/game-api/package.json
COPY --from=base /app/apps/mock-endowment-api/package.json ./apps/mock-endowment-api/package.json
ARG APP=game-api
ENV APP=${APP}
CMD sh -c "node apps/${APP}/dist/server.js"
