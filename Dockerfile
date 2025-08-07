# use the official Bun image
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install system dependencies for Canvas (required for CAPTCHA generation)
RUN apt-get update && apt-get install -y \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    build-essential \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# install dependencies into temp directory
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# generate database migrations if db:gen script exists
ENV NODE_ENV=production
# RUN bun run db:gen 2>/dev/null || echo "No db:gen script found, skipping..."

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src ./src
COPY --from=prerelease /usr/src/app/package.json .
COPY --from=prerelease /usr/src/app/tsconfig.json* ./
COPY --from=prerelease /usr/src/app/drizzle.config.ts* ./
# COPY --from=prerelease /usr/src/app/drizzle* ./drizzle/ 2>/dev/null || mkdir -p drizzle

# run the app
USER bun
EXPOSE 4000/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
