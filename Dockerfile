FROM node:18-slim

# Install Chromium for Puppeteer PDF generation.
# node:18-slim is Debian Bullseye; chromium is available in the default repos.
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chrome bundle and use system Chromium.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install production dependencies only (separate layer for better cache reuse).
COPY package*.json ./
RUN npm ci --only=production

# Copy application source.
COPY . .

# Railway injects PORT at runtime; 3001 is the local fallback.
EXPOSE 3001

CMD ["node", "server.js"]
