FROM node:22.12.0-slim

# Install system Chromium — apt resolves all required dependencies automatically.
# This is more reliable than manually listing Chrome's runtime libs.
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Skip puppeteer's bundled Chrome download; point it at system Chromium instead.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# npm ci is now faster — no Chrome binary download during postinstall.
COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
