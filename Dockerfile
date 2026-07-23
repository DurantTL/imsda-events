# Production image for the IMSDA Events Next.js application.
#
# build stage : install all dependencies, generate the Prisma client, build Next.
# runner stage: apply migrations (and optional seed) on start, then serve the app.
#
# Debian slim is used (rather than Alpine) for reliable Prisma engine/OpenSSL support.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first. `postinstall` runs `prisma generate`, so the schema
# must be present before `npm ci`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Build the app. The placeholder DATABASE_URL only satisfies env-shape validation
# at build time; `next build` does not contact a database.
COPY . .
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build?schema=public"
RUN npx prisma generate && npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Bring over the fully built app. Dependencies include the Prisma CLI and tsx,
# which the entrypoint needs at runtime for `migrate deploy` and `db seed`
# (the seed imports application modules, so the source tree is retained too).
COPY --from=build /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
