# Dockerfile (root of repo)
FROM node:24-alpine 

# Install ffmpeg (small on Alpine) and tini for clean PID1 handling
RUN apk add --no-cache ffmpeg ca-certificates tini

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app
COPY . .

# Create temp dir for jobs (matches your .env TEMP_DIR=/tmp/video-jobs)
RUN mkdir -p /tmp/video-jobs

# Health and port
EXPOSE 3000

# Drop root for safety (optional; comment out if you need root)
# USER node

# Use tini to reap zombies (esp. during ffmpeg spawns)
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "server.js"]

