# path/filename: Dockerfile
# Purpose: Containerize the Thingproxy Node.js server for deployment with Kamal v2 or any Docker workflow.  
# Uses a lightweight Alpine-based Node image, installs production dependencies, and exposes the service on the port defined by the PORT env var (defaults to 3000).

# ---- Build stage ----
FROM node:22-alpine AS base

# Install useful runtime packages (curl is used by the HEALTHCHECK)
RUN apk add --no-cache curl

# Create app directory
WORKDIR /usr/src/app

# Copy dependency declarations first for better layer caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production  --no-optional --quiet

# ---- Runtime stage ----
# (Using the same image keeps the final image tiny while avoiding multi-stage complexity)
COPY . .

ENV NODE_ENV=production \
    PORT=3000

# Expose the port that the app listens on
EXPOSE $PORT

# Default command – start the proxy server
CMD ["node", "server.js"] 