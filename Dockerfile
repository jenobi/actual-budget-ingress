# --- Build Stage ---
FROM node:26-alpine AS builder
WORKDIR /app

# Install build dependencies required if any native modules need compilation
RUN apk add --no-cache python3 make g++ 

COPY package*.json ./
RUN npm ci --only=production

# --- Runtime Stage ---
FROM node:26-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy production dependencies and application files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./

# Create the internal data directory and grant node user ownership
RUN mkdir -p /tmp/actual-api-data && chown -R node:node /tmp/actual-api-data

# Install curl in the runtime stage so Docker can use it for the health check
RUN apk add --no-cache curl

# Define the health check (Docker executes this container-side)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node

EXPOSE 3000

CMD ["node", "index.js"]