FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY contracts ./contracts
RUN pnpm install --frozen-lockfile
RUN node scripts/generate-postgres-schema.mjs
RUN pnpm build
RUN pnpm db:generate:postgres

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
ARG SERVICE
ENV RUGKILLER_SERVICE=${SERVICE}
CMD ["sh", "-c", "pnpm --filter @rugkiller/${RUGKILLER_SERVICE} start"]
