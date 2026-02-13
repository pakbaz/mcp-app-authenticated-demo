# ── Stage 1: Build ───────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# ── Stage 2: Production ─────────────────────────────────────────────────
FROM node:22-alpine AS production

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy dependency files and install production deps only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built output from build stage
COPY --from=build --chown=app:app /app/dist ./dist

# Switch to non-root user
USER app

# Expose the server port
EXPOSE 80

# Health check for Azure Container Apps
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:80/health || exit 1

# Start the server
ENV NODE_ENV=production
ENV PORT=80
CMD ["node", "dist/server.js"]
