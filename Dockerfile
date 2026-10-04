# Two stages. The first has everything needed to compile the code and to run
# the tests. The second is the image that runs the service. It holds only the
# compiled code, the migrations and the packages needed at run time.

# ---- Stage 1: build ----
FROM node:22-slim AS build
WORKDIR /app

# Install packages first. Docker reuses this layer until package.json or the
# lock file changes, so a code change does not reinstall everything.
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the project (.dockerignore lists what is left out) and
# compile TypeScript into dist/.
COPY . .
RUN npm run build

# ---- Stage 2: run ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Runtime packages only. No TypeScript, no test tools.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# Do not run as root. The "node" user comes with the base image.
USER node
EXPOSE 3000

# Apply any migrations that have not run, insert the seed products if they
# are missing, then start the service. The first two steps are safe to repeat,
# so the container can be restarted at any time.
# "exec" makes node the main process of the container, so it receives the
# stop signal and can finish running requests before it exits.
CMD ["sh", "-c", "node dist/cli/migrate.js && node dist/cli/seed.js && exec node dist/server.js"]
