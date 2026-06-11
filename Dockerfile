FROM node:20-slim

# Install the OS-level libraries that Chrome needs to run.
# Puppeteer downloads its own matching Chrome binary during npm ci —
# we do NOT use the system chromium package so versions always align.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# npm ci triggers Puppeteer's postinstall which downloads the matching Chrome
# binary into ~/.cache/puppeteer — layer is cached until package-lock.json changes.
COPY package*.json ./
RUN npm ci --only=production

# Copy application source.
COPY . .

# Railway injects PORT at runtime; 3001 is the local fallback.
EXPOSE 3001

CMD ["node", "server.js"]
