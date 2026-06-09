# SecureVault GDPR Scanner — Backend

Node.js + Express API that runs 6 security/GDPR scanners against a domain in parallel.
All scans are ephemeral — no database, results are in-memory only.

## Setup

```bash
cd backend
npm install
npm run dev        # development (nodemon)
npm start          # production
```

Server starts on `http://localhost:3001` by default.

## Endpoints

### GET /health
```bash
curl http://localhost:3001/health
```
```json
{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }
```

### POST /api/scan
```bash
curl -X POST http://localhost:3001/api/scan \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}'
```

**Response shape:**
```json
{
  "success": true,
  "domain": "example.com",
  "scannedAt": "2024-01-01T00:00:00.000Z",
  "results": {
    "ssl":        { "module": "ssl",        "status": "pass|warn|fail|error", "details": {}, "issues": [] },
    "headers":    { "module": "headers",    "status": "...", "details": {}, "issues": [] },
    "dns":        { "module": "dns",        "status": "...", "details": {}, "issues": [] },
    "subdomains": { "module": "subdomains", "status": "...", "details": {}, "issues": [] },
    "tech":       { "module": "tech",       "status": "...", "details": {}, "issues": [] },
    "gdpr":       { "module": "gdpr",       "status": "...", "details": {}, "issues": [] }
  },
  "pdfUrl": null
}
```

## Scanner modules

| Module | What it checks |
|---|---|
| `ssl` | Certificate validity, TLS version (1.2+), cipher strength |
| `headers` | CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy |
| `dns` | SPF, DKIM (common selectors), DMARC records |
| `subdomains` | Passive enumeration via crt.sh certificate transparency logs |
| `tech` | CMS/framework fingerprinting (WordPress, React, Next.js, etc.), server header leaks |
| `gdpr` | Privacy policy, cookie consent banner, trackers, data subject rights |

## Security notes

- Domain input is validated against a strict regex and blocks `localhost`, private IP ranges (10.x, 192.168.x, 172.16–31.x), and `0.0.0.0` to prevent SSRF.
- No data is persisted — all scan results exist only in the response payload.
- Subdomain enumeration is passive only (crt.sh) — no active probing.
- Scanner errors are isolated: one failing scanner does not abort the others.

## Project structure

```
backend/
├── server.js
├── routes/
│   └── scan.js
├── scanners/
│   ├── ssl-check.js
│   ├── headers-check.js
│   ├── dns-check.js
│   ├── subdomains.js
│   ├── tech-detect.js
│   └── gdpr-check.js
├── utils/
│   ├── validators.js
│   ├── logger.js
│   └── errors.js
├── .env
├── .gitignore
└── package.json
```
