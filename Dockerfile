# syntax=docker/dockerfile:1

# Three stages, so that the toolchain used to build the app is not shipped with it.
# The final image has no compiler, no package manager cache and no source code —
# only the traced server output and the node_modules it actually reaches.
#
# No secret is a build argument. MONGODB_URI and AUTH_SECRET are read at runtime,
# on every request, and must be supplied with `docker run -e` / compose / the host's
# secret store. A value passed with ARG is written into the image's layer history
# and stays readable with `docker history` forever, even if a later line deletes it.

# ---------------------------------------------------------------- dependencies
FROM node:22-alpine AS deps
WORKDIR /app

# mongodb-memory-server downloads a MongoDB binary on install. The tests need it;
# an image does not, and the download is slow and fails on hosts with no route to
# fastdl.mongodb.org.
ENV MONGOMS_DISABLE_POSTINSTALL=1

# Only the manifests, so this layer is reused on every build that does not change
# a dependency — the install is the slow part and it rarely needs to happen.
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------------- builder
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
RUN npm run build

# ---------------------------------------------------------------------- runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Not 3000, so the container does not fight whatever else on the host took the
# default. Only ever reached through the reverse proxy, which listens on 443.
ENV PORT=3007

# Without this the server binds to localhost inside the container, which from the
# outside looks exactly like a container that starts and then refuses connections.
ENV HOSTNAME=0.0.0.0

# An unprivileged user. A container process running as root is root on the host
# kernel, and this one parses uploaded spreadsheets from other people.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# standalone/ carries server.js and the traced node_modules. The static and public
# directories are deliberately not included in it, so they are copied separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3007

# Shallow by design: it answers without touching MongoDB. A health check that
# pings the database turns one slow Atlas moment into every container being
# killed at once, which is a worse outage than the one it was watching for.
#
# Reads $PORT rather than repeating the number, so overriding the port at run time
# cannot leave the probe knocking on a door nobody is behind.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Next registers its own SIGTERM handler and drains in-flight requests, so the
# server is PID 1 on purpose. Give it 10-30s to stop before killing it.
CMD ["node", "server.js"]
