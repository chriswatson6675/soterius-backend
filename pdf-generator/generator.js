const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// Static content maps
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_META = {
  ssl:        { name: 'SSL / TLS Certificate Analysis',      checked: 'Certificate validity, expiry date, TLS version (1.2+), cipher strength.' },
  headers:    { name: 'HTTP Security Headers',                checked: 'CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.' },
  dns:        { name: 'DNS Records — Email Authentication',  checked: 'SPF, DKIM, and DMARC TXT records for email spoofing prevention.' },
  ports:      { name: 'Open Port Scan',                       checked: 'Ports 80, 443, 22 (SSH), 3306 (MySQL), 5432 (PostgreSQL), 8080, 3000, 27017 (MongoDB).' },
  subdomains: { name: 'Subdomain Enumeration',                checked: 'Public certificate transparency logs (crt.sh) — passive, no active probing.' },
  tech:       { name: 'Technology Detection',                 checked: 'CMS, frameworks, server software, and version disclosures in headers and source.' },
  gdpr:       { name: 'GDPR Compliance',                      checked: 'Privacy policy, cookie consent banner, tracking scripts, data subject rights.' },
};

const STATUS_STYLES = {
  pass:  { bg: '#dcfce7', text: '#15803d', label: 'PASS',    icon: '✓' },
  warn:  { bg: '#fef9c3', text: '#a16207', label: 'WARNING', icon: '⚠' },
  fail:  { bg: '#fee2e2', text: '#b91c1c', label: 'FAIL',    icon: '✕' },
  error: { bg: '#f1f5f9', text: '#475569', label: 'ERROR',   icon: '?' },
};

const RISK_STYLES = {
  low:      { bg: '#dcfce7', text: '#15803d' },
  medium:   { bg: '#fef9c3', text: '#a16207' },
  high:     { bg: '#ffedd5', text: '#c2410c' },
  critical: { bg: '#fee2e2', text: '#b91c1c' },
};

const PLAIN_MEANING = {
  ssl: {
    pass:  "Your website uses HTTPS with a valid, trusted certificate. All data between your site and visitors is encrypted. This is the correct baseline for any business website.",
    warn:  "Your HTTPS certificate is valid but requires attention soon — it may be approaching expiry or using an older configuration. Visitors can still connect securely for now.",
    fail:  "Your website has a critical HTTPS problem. Visitors' browsers display full-page security warnings. Data submitted through your site may not be encrypted.",
    error: "The SSL check could not connect. Your site may not support HTTPS, or a firewall blocked the test. Try visiting https://yourdomain.com directly to verify.",
  },
  headers: {
    pass:  "Your web server sends all recommended security headers. These tell visitors' browsers how to handle your content, protecting against script injection, clickjacking, and data-sniffing attacks.",
    warn:  "Some security headers are missing. Your site has partial browser protection, but specific vulnerabilities remain depending on which headers are absent.",
    fail:  "Critical security headers are absent. Visitors' browsers have no guidance to protect against common attacks — leaving your site exposed to script injection, clickjacking, and unencrypted connections.",
    error: "The headers check could not reach your site. Verify your site responds to standard HTTP requests.",
  },
  dns: {
    pass:  "Email authentication (SPF, DKIM, DMARC) is correctly configured. Emails from your domain are verified, protecting your brand from spoofing and improving deliverability.",
    warn:  "Email authentication is only partially configured. Missing or weak records leave a gap that can allow email spoofing.",
    fail:  "Email authentication is not configured. There is nothing preventing an attacker from sending emails that appear to come from your business.",
    error: "DNS lookups for your domain failed. Your nameservers may be unresponsive — check your domain registrar.",
  },
  ports: {
    pass:  "Only expected ports are accessible from the internet. Databases and admin services are properly isolated.",
    warn:  "Some non-standard ports are publicly reachable. Each open port is a potential entry point for automated attack tools.",
    fail:  "Dangerous ports are publicly accessible. Database servers or admin services can be directly reached from the internet — without going through your web application's security.",
    error: "The port scan could not reach your server. A strict firewall may be blocking all probes, which is not necessarily a problem.",
  },
  subdomains: {
    pass:  "Few subdomains are publicly visible. A minimal subdomain footprint means fewer potential attack entry points.",
    warn:  "Multiple subdomains are publicly visible. Some may be old staging environments or decommissioned services that were never removed.",
    fail:  "A significant number of subdomains are publicly visible. Forgotten subdomains are a common attack vector, especially those pointing to decommissioned cloud services.",
    error: "Subdomain lookup via certificate transparency logs failed. This is usually a temporary crt.sh outage — try again later.",
  },
  tech: {
    pass:  "No significant technology disclosures or outdated software versions were detected. Your site does not publicly advertise information that attackers could use to target it.",
    warn:  "Server or software version information is being disclosed in HTTP headers or page source. This acts as a roadmap for automated attack tools.",
    fail:  "Your website is actively disclosing software versions with known, publicly documented vulnerabilities. Automated scanners will find and attempt to exploit these.",
    error: "Technology detection could not load your homepage. Verify the site is publicly accessible.",
  },
  gdpr: {
    pass:  "Your site appears to meet the basic GDPR requirements detectable by automated scanning — a privacy policy, cookie consent mechanism, and data rights information were found.",
    warn:  "Some GDPR compliance requirements are missing or incomplete. The gaps identified represent legal risk under UK and EU data protection law.",
    fail:  "Critical GDPR requirements are missing. You are likely in active breach of UK GDPR, which carries serious regulatory and financial consequences.",
    error: "GDPR checks could not load your homepage. Verify the site is publicly accessible without a login.",
  },
};

const BUSINESS_IMPACT = {
  ssl: {
    warn: {
      headline: "Your certificate is approaching expiry — visitors will soon see security warnings.",
      bullets: [
        "Browsers display a 'Not Secure' warning when the certificate expires, driving visitors away immediately",
        "Google may lower your search ranking in response to certificate issues",
        "Payment and login data could become unencrypted if expiry is not addressed",
        "GDPR requires adequate technical security — an expired certificate is a violation under Article 32",
      ],
      responsible: "Your web host or web developer.",
      cost: "30 minutes. Free renewal via Let's Encrypt.",
    },
    fail: {
      headline: "Visitors see a security warning and leave — you are losing customers right now.",
      bullets: [
        "All major browsers show a full-page 'Not Secure' warning — most visitors leave immediately",
        "Login credentials and customer data transmitted without encryption",
        "Google actively suppresses sites with certificate errors in search results",
        "Any data breach on an unencrypted site triggers mandatory ICO notification within 72 hours",
        "GDPR fine risk: up to £17.5 million or 4% of global annual turnover",
      ],
      responsible: "Your web host or web developer.",
      cost: "1–2 hours. Free certificate via Let's Encrypt.",
    },
  },
  headers: {
    warn: {
      headline: "Partial browser protection — specific attack types remain possible.",
      bullets: [
        "Missing headers leave specific vulnerabilities depending on which are absent",
        "XSS attacks can steal session cookies and redirect customers to fake login pages",
        "Your site may fail third-party security audits or penetration tests",
        "Cyber insurance policies increasingly require security headers to be in place",
      ],
      responsible: "Your web host or web developer.",
      cost: "30 minutes. No code changes required — server configuration only.",
    },
    fail: {
      headline: "No browser security protections — customer data and your reputation are at risk.",
      bullets: [
        "Attackers can inject malicious scripts (XSS) to steal credit card numbers and personal data",
        "Your site can be embedded in a hidden iframe to trick users into submitting credentials (clickjacking)",
        "Google Safe Browsing may blacklist your domain — you disappear from search results",
        "Customers whose data is stolen can sue under GDPR for failing to implement basic security measures",
        "GDPR fine: up to £17.5 million for inadequate technical security",
        "Recovering from a hacked site typically costs £1,000–£10,000+",
      ],
      responsible: "Your web host or web designer.",
      cost: "30 minutes. Server configuration only — no code changes needed.",
    },
  },
  dns: {
    warn: {
      headline: "Email spoofing is partially possible — your domain reputation is at risk.",
      bullets: [
        "Attackers may be able to send emails appearing to come from your domain",
        "Your legitimate emails may land in customers' spam folders",
        "One phishing campaign using your domain can permanently damage customer trust",
        "Incomplete DMARC means monitoring is happening but spoofed emails are not being rejected",
      ],
      responsible: "Your DNS/domain provider or IT administrator.",
      cost: "15–30 minutes. Completely free.",
    },
    fail: {
      headline: "Anyone can send emails pretending to be your business — this is an active fraud risk.",
      bullets: [
        "Attackers send phishing emails to your customers appearing to come from your domain",
        "Customers report fraud, raise chargebacks, and leave negative reviews about your 'scam emails'",
        "Your domain gets permanently blacklisted by email providers",
        "Your legitimate invoices and quotes land in spam — you lose real business",
        "Legal liability if a customer is defrauded using your domain identity",
        "Average cost of an email fraud incident for an SME: £3,000–£30,000",
      ],
      responsible: "Your DNS/domain provider or IT administrator.",
      cost: "15 minutes. Completely free to fix.",
    },
  },
  ports: {
    warn: {
      headline: "Unnecessary services are publicly visible — each is a potential entry point.",
      bullets: [
        "Every open port is scanned by automated attack bots within minutes of going live",
        "Development servers often expose admin panels, debug tools, or unprotected APIs",
        "A single misconfigured service can give an attacker a foothold into your entire server",
        "Cyber insurance may be voided if basic firewall hygiene is not maintained",
      ],
      responsible: "Your web host or server administrator.",
      cost: "15–30 minutes. Firewall configuration only.",
    },
    fail: {
      headline: "Database or admin ports are publicly accessible — this is a critical breach risk.",
      bullets: [
        "Automated bots attempt to brute-force SSH (port 22) continuously, 24 hours a day",
        "A single weak password gives an attacker complete access to your server and all data",
        "Direct database access bypasses all web application security controls",
        "Ransomware operators specifically target exposed databases to encrypt data and demand payment",
        "GDPR mandatory breach notification to ICO within 72 hours — fines up to £17.5 million",
        "Average ransomware demand for UK SMEs: £50,000–£500,000",
      ],
      responsible: "Your web host or server administrator.",
      cost: "15 minutes. A single firewall rule change.",
    },
  },
  subdomains: {
    warn: {
      headline: "Multiple subdomains increase your attack surface — some may be forgotten.",
      bullets: [
        "Old staging or development subdomains often have weaker security than the main site",
        "Forgotten subdomains may still hold customer data or admin access credentials",
        "Subdomain takeover allows attackers to serve malware under your trusted brand name",
        "Google penalises domains when malicious content is found on any subdomain",
      ],
      responsible: "Your IT administrator or web developer.",
      cost: "1–2 hours to audit and remove unused DNS records.",
    },
    fail: {
      headline: "Numerous exposed subdomains create multiple attack vectors under your brand.",
      bullets: [
        "Attackers can take over abandoned subdomains to host phishing pages appearing to be your brand",
        "Old staging environments often contain unprotected databases or admin credentials",
        "Malware served from any subdomain damages your entire domain's reputation",
        "Google may associate your whole domain with malicious content — all pages delist",
      ],
      responsible: "Your IT administrator or domain registrar.",
      cost: "2–4 hours to audit and remediate.",
    },
  },
  tech: {
    warn: {
      headline: "Technology disclosures give attackers a detailed roadmap of your system.",
      bullets: [
        "Knowing your exact server or CMS version lets attackers search for known exploits immediately",
        "Automated vulnerability scanners target disclosed versions within hours of indexing",
        "Outdated CMS plugins are the top cause of SME website compromises",
        "A hacked site costs £1,000–£10,000+ to clean and restore — plus downtime and SEO damage",
      ],
      responsible: "Your web host or web developer.",
      cost: "5–30 minutes to suppress version headers.",
    },
    fail: {
      headline: "Outdated software with known, publicly documented vulnerabilities — high breach risk.",
      bullets: [
        "Hackers use automated tools to scan for your exact software version — yours is in their target list",
        "Malware injected via a known CVE can infect every visitor to your site within hours",
        "Google blacklists hacked sites — you can disappear from search results within 24 hours",
        "Customer data theft via an unpatched vulnerability creates a mandatory ICO report",
        "Recovering from a compromise costs £1,000–£10,000+ in developer time alone",
        "GDPR fine risk for failing to maintain up-to-date software (Article 32)",
      ],
      responsible: "Your web host or web developer.",
      cost: "1–2 hours for updates. Preventing a hack is 100× cheaper than recovering from one.",
    },
  },
  gdpr: {
    warn: {
      headline: "Incomplete GDPR compliance — regulatory risk is building.",
      bullets: [
        "ICO can investigate based on a single complaint from any website visitor",
        "Missing cookie consent means you are processing data without a legal basis",
        "Privacy advocates and competitors can file regulatory complaints against your business",
        "Without consent records, you cannot demonstrate compliance if investigated",
        "Fines for incomplete compliance range from £4,000 to £500,000 depending on severity",
      ],
      responsible: "You are legally responsible as the data controller — this cannot be delegated.",
      cost: "1–2 hours to add missing elements. Consent tools: free to £50/month.",
    },
    fail: {
      headline: "You are actively breaking UK/EU GDPR law — immediate action required.",
      bullets: [
        "ICO fines: up to £17.5 million or 4% of global annual turnover — whichever is higher",
        "Individuals can sue for compensation under UK GDPR Article 82",
        "Every tracking script running without consent is an active, ongoing GDPR violation",
        "ICO can order you to cease all data processing — effectively shutting down your site",
        "Directors can face personal liability in cases of wilful non-compliance",
        "'I didn't know' is not a legal defence — GDPR requires proactive compliance",
      ],
      responsible: "You are the data controller. Legal responsibility cannot be outsourced.",
      cost: "2–4 hours with a developer. ICO fines for non-compliance start at £4,000.",
    },
  },
};

const SME_CASES = {
  ssl: {
    warn: {
      business: "SaaS platform, 100 active users", year: "2023",
      happened: "SSL certificate expired over a weekend. Auto-renewal had silently failed months earlier.",
      result: "Site inaccessible for 8 hours on a Monday morning. Customers unable to log in.",
      cost: "£3,000 in lost revenue + emergency developer call-out",
      lesson: "Certificate monitoring and auto-renewal are critical — expiry is always preventable.",
    },
    fail: {
      business: "E-commerce retailer, ~2,000 monthly customers", year: "2023",
      happened: "Weak TLS 1.0 configuration enabled a protocol downgrade attack on public Wi-Fi.",
      result: "200+ customer session tokens captured. Accounts accessed without authorisation. ICO notified.",
      cost: "£12,000 in remediation, legal fees, and customer notification",
      lesson: "TLS 1.0 and 1.1 are deprecated and actively exploited. Only 1.2 and 1.3 should be supported.",
    },
  },
  headers: {
    warn: {
      business: "Professional services firm, 20 staff", year: "2023",
      happened: "Missing X-Frame-Options header. Attacker used clickjacking to overlay the contact form.",
      result: "Several clients submitted sensitive enquiries through a fake overlay page.",
      cost: "£6,000 in incident response and refunds. No ICO fine, but significant reputation damage.",
      lesson: "Security headers prevent specific, well-documented attacks — adding them takes minutes.",
    },
    fail: {
      business: "E-commerce site, ~50,000 registered customers", year: "2022",
      happened: "Missing CSP and HSTS. Attacker injected a payment skimmer script into checkout pages.",
      result: "400 customers' credit card details stolen. Mandatory ICO breach report filed.",
      cost: "£15,000 remediation + £8,000 legal fees + ongoing ICO investigation",
      lesson: "CSP and HSTS together prevent the most common client-side attacks. Both are free to add.",
    },
  },
  dns: {
    warn: {
      business: "Recruitment agency, 8 staff", year: "2023",
      happened: "DMARC set to p=none (monitoring only, not enforced). Spoofed emails were not blocked.",
      result: "Fake 'job offer' emails sent to candidates from the agency's domain, harvesting personal data.",
      cost: "£3,000 in legal advice and breach notifications. Long-term brand damage.",
      lesson: "p=none monitors but does not protect. Escalate to p=quarantine, then p=reject.",
    },
    fail: {
      business: "Accounting firm, 5 staff", year: "2023",
      happened: "No SPF, DKIM, or DMARC. Criminals spoofed the domain to send fake invoices to 12 clients.",
      result: "Clients paid fraudulent invoices totalling £50,000. Several clients pursued the firm legally.",
      cost: "£8,000 in legal settlements + significant reputation damage",
      lesson: "Without email authentication, your domain can be impersonated by anyone.",
    },
  },
  ports: {
    warn: {
      business: "Digital marketing agency, 6 staff", year: "2023",
      happened: "Port 8080 left open, exposing a dev build with debug mode and verbose error logging.",
      result: "Attacker accessed internal API via debug mode. Client campaign data harvested.",
      cost: "£4,000 incident response. Loss of two major client contracts.",
      lesson: "Non-standard ports are scanned by automated bots within hours of going live.",
    },
    fail: {
      business: "WordPress hosting reseller", year: "2022",
      happened: "MySQL port 3306 publicly accessible. Automated scanner accessed it within 4 hours of launch.",
      result: "5,000 customer records stolen. Mandatory ICO data breach notification filed.",
      cost: "£4,000 remediation + ICO notification costs + reputation damage",
      lesson: "Database ports must never be publicly accessible. No exceptions.",
    },
  },
  subdomains: {
    warn: {
      business: "Property management company, 15 staff", year: "2023",
      happened: "Old staging subdomain left public after a redesign, containing a live database copy.",
      result: "Staging site held tenant personal data including payment history.",
      cost: "£5,000 remediation + ICO breach notification. Under formal investigation.",
      lesson: "Audit subdomains at every redesign. Remove unused DNS records immediately.",
    },
    fail: {
      business: "Web development agency, 10 staff", year: "2023",
      happened: "Multiple staging subdomains public. One contained database credentials in a config file.",
      result: "Attacker accessed production using harvested credentials. All client sites compromised.",
      cost: "£6,000 emergency response + client notifications + loss of 4 contracts",
      lesson: "Old DNS records pointing to decommissioned cloud services enable subdomain takeover.",
    },
  },
  tech: {
    warn: {
      business: "Restaurant chain, 3 locations", year: "2024",
      happened: "PHP and server version disclosed in response headers. Known CVE targeted within 24 hours.",
      result: "Admin panel compromised via known PHP vulnerability. Reservation data exfiltrated.",
      cost: "£3,500 remediation + 6 hours downtime + emergency redeployment",
      lesson: "Hiding version information removes your site from automated exploit target lists.",
    },
    fail: {
      business: "Small business e-commerce site", year: "2024",
      happened: "Outdated WooCommerce plugin version visible in source code. Automated bot exploited known CVE.",
      result: "Ransomware injected via the plugin. Both the website and backups were encrypted.",
      cost: "£8,000 recovery costs + 2 weeks downtime + permanent Google ranking damage",
      lesson: "Every outdated plugin is a published, searchable vulnerability. Bots scan millions of sites daily.",
    },
  },
  gdpr: {
    warn: {
      business: "Marketing agency, 12 staff", year: "2023",
      happened: "Facebook Pixel and Google Analytics firing without a compliant consent mechanism.",
      result: "ICO investigation following a single customer complaint. Consent deemed non-compliant.",
      cost: "£12,000 ICO fine + £3,000 to implement compliant consent management",
      lesson: "Running tracking scripts without a lawful consent basis is an active, ongoing GDPR violation.",
    },
    fail: {
      business: "Online retailer, 8,000 registered customers", year: "2024",
      happened: "No privacy policy, no consent banner, multiple tracking pixels on every page.",
      result: "ICO formal investigation. Multiple simultaneous violations. Enforcement notice issued.",
      cost: "£18,000 ICO fine + £5,000 legal fees + mandatory compliance audit",
      lesson: "GDPR is a legal requirement. The ICO investigates complaints from a single individual.",
    },
  },
};

const HOW_TO_FIX = {
  ssl: {
    warn: {
      steps: [
        "Log in to your hosting control panel and locate certificate management",
        "Check the expiry date and enable auto-renewal if available",
        "Use Let's Encrypt via your host (cPanel, Plesk, Cloudflare all support free auto-renewing certificates)",
        "Verify TLS 1.2 and 1.3 are enabled and TLS 1.0/1.1 are disabled in your server config",
        "Test your result at https://www.ssllabs.com/ssltest/",
      ],
      time: "30 minutes", cost: "Free (Let's Encrypt) to £100/year (paid cert)",
      who: "Web host or web developer", urgency: "Within 30 days",
    },
    fail: {
      steps: [
        "Contact your web host immediately and report the certificate issue",
        "Install a new certificate using Let's Encrypt (free) via your host's control panel",
        "Ensure the certificate covers your exact domain (including www and non-www variants)",
        "Set up automatic renewal to prevent recurrence",
        "Test at https://www.ssllabs.com/ssltest/ to confirm the fix",
      ],
      time: "1–2 hours", cost: "Free (Let's Encrypt) to £200/year",
      who: "Web host or web developer", urgency: "Immediately — visitors are being turned away",
    },
  },
  headers: {
    warn: {
      steps: [
        "Share the specific missing headers listed in this report with your web developer or host",
        "For Nginx: add headers in the server block; for Apache: add to .htaccess or httpd.conf",
        "For Cloudflare users: add headers via Transform Rules or Page Rules",
        "Test your headers at https://securityheaders.com — aim for an A or A+ rating",
      ],
      time: "30 minutes", cost: "Free — configuration change only",
      who: "Web host or developer with server access", urgency: "Within 7–14 days",
    },
    fail: {
      steps: [
        "Treat this as urgent — contact your web host or developer today",
        "Priority headers to add first: Content-Security-Policy and Strict-Transport-Security (HSTS)",
        "Then add: X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy",
        "Each header is a single configuration line — no application code changes needed",
        "Verify at https://securityheaders.com until you achieve an A rating",
      ],
      time: "30–60 minutes", cost: "Free — server configuration only",
      who: "Web host or developer with server access", urgency: "Immediately — within 7 days maximum",
    },
  },
  dns: {
    warn: {
      steps: [
        "Log in to your DNS provider (GoDaddy, Cloudflare, Route 53, etc.)",
        "Add or update the missing TXT record(s) identified above",
        "For DMARC, start with monitoring mode: v=DMARC1; p=none; rua=mailto:you@yourdomain.com",
        "Test with https://mxtoolbox.com/dmarc.aspx",
        "After 2–4 weeks of monitoring, upgrade to p=quarantine, then p=reject",
      ],
      time: "15–30 minutes", cost: "Free",
      who: "Domain registrar admin or IT administrator", urgency: "Within 30 days",
    },
    fail: {
      steps: [
        "Log in to your DNS management console",
        "Add SPF: v=spf1 include:_spf.[youremailprovider].com ~all",
        "Contact your email provider (Google Workspace, Microsoft 365) for your DKIM public key",
        "Add DMARC: v=DMARC1; p=quarantine; rua=mailto:admin@yourdomain.com",
        "Verify all three at https://mxtoolbox.com",
        "After confirming legitimate mail flows correctly, upgrade DMARC to p=reject",
      ],
      time: "30–45 minutes", cost: "Free",
      who: "Domain registrar admin or IT administrator", urgency: "Immediately — attackers may be spoofing your domain now",
    },
  },
  ports: {
    warn: {
      steps: [
        "Log in to your server's firewall or cloud provider (AWS Security Groups, GCP Firewall, Azure NSG)",
        "Identify which open ports are not required for public access",
        "Create deny rules for unnecessary ports",
        "If you need SSH, restrict port 22 to your specific office IP address only",
      ],
      time: "15–30 minutes", cost: "Free",
      who: "Web host or server administrator", urgency: "Within 14 days",
    },
    fail: {
      steps: [
        "Log in to your cloud provider or hosting control panel today",
        "Close all database ports from public access: 3306 (MySQL), 5432 (PostgreSQL), 27017 (MongoDB)",
        "Restrict SSH (port 22) to your specific IP address — not 0.0.0.0/0",
        "Close development server ports (3000, 8080) unless specifically required",
        "Access databases via SSH tunnel or private VPN instead of direct public connection",
      ],
      time: "15–30 minutes", cost: "Free — firewall configuration. VPN: £5–15/month if needed",
      who: "Web host or server administrator", urgency: "Immediately — automated bots are scanning these ports right now",
    },
  },
  subdomains: {
    warn: {
      steps: [
        "Export all DNS records from your domain registrar",
        "Cross-reference each subdomain against active services",
        "Delete DNS records for subdomains pointing to decommissioned services",
        "Ensure remaining staging/dev subdomains require authentication to access",
        "Implement a quarterly DNS record review process",
      ],
      time: "1–2 hours", cost: "Free",
      who: "IT administrator or web developer", urgency: "Within 30 days",
    },
    fail: {
      steps: [
        "Audit every subdomain listed in this report — confirm whether the service is still active",
        "Delete DNS records for any subdomains pointing to services no longer running",
        "Check for subdomain takeover vulnerabilities (DNS pointing to removed cloud service)",
        "Move all staging/dev environments behind authentication immediately",
        "Remove or restrict public access to any admin interfaces on subdomains",
      ],
      time: "2–4 hours", cost: "Free. Professional audit: £1,000–3,000",
      who: "IT administrator or web developer", urgency: "Within 7 days",
    },
  },
  tech: {
    warn: {
      steps: [
        "Ask your host or developer to suppress server version headers (X-Powered-By, Server)",
        "For Nginx: server_tokens off; | For Apache: ServerTokens Prod + ServerSignature Off | PHP: expose_php = Off",
        "Update all CMS plugins to their latest versions from the admin dashboard",
        "Set up automatic plugin updates for security releases",
      ],
      time: "30–60 minutes", cost: "Free",
      who: "Web host or web developer", urgency: "Within 14 days",
    },
    fail: {
      steps: [
        "Update all CMS software, themes, and plugins to the latest versions immediately",
        "Remove all unused or inactive plugins — they remain exploitable even when disabled",
        "Contact your host to suppress all version information from server response headers",
        "Search https://cve.mitre.org for the specific versions identified in this report",
        "If critical CVEs (CVSS 9+) exist for your versions, treat this as an emergency update",
        "Enable automatic updates for security releases going forward",
      ],
      time: "1–3 hours", cost: "Free if self-managed. Managed hosting with auto-updates: £20–100/month",
      who: "Web developer or managed hosting provider", urgency: "Immediately — known CVEs are actively exploited at scale",
    },
  },
  gdpr: {
    warn: {
      steps: [
        "Implement a cookie consent management platform (Cookiebot, CookieYes, or Usercentrics)",
        "Ensure the consent banner blocks all tracking until the visitor actively accepts",
        "Add a footer link to your privacy policy on every page",
        "Update your privacy policy to include: data collected, purpose, legal basis, retention periods, and data subject rights",
        "Add a clear data subject rights contact method (email or online form)",
      ],
      time: "2–4 hours", cost: "Free consent tools available. Paid: £10–50/month",
      who: "Web developer (implementation) + business owner (policy content)", urgency: "Within 30 days",
    },
    fail: {
      steps: [
        "Stop all tracking scripts (Analytics, Facebook Pixel, etc.) loading without consent — this is legally required now",
        "Implement a consent management platform that blocks tracking until active consent is given",
        "Create or commission a GDPR-compliant privacy policy — do not copy from another site",
        "Add data subject rights contact details (right to access, erasure, portability)",
        "Register with the ICO as a data controller if processing UK resident data (£40–60/year)",
        "Consider consulting a Data Protection Officer (DPO) for a compliance review",
        "Document everything — consent mechanisms, processing activities, legitimate interests assessments",
      ],
      time: "4–8 hours initial. 1–2 hours/month ongoing",
      cost: "£0–200 implementation. ICO registration: £40–60/year. DPO review: £200–500",
      who: "Web developer + business owner + potentially a legal/DPO advisor",
      urgency: "Immediately — you are in active breach of UK GDPR",
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function sanitize(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function statusBadge(status) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.error;
  return `<span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:10px;font-weight:700;letter-spacing:0.05em;background:${s.bg};color:${s.text}">${s.icon} ${s.label}</span>`;
}

function getScoreColor(score) {
  if (score >= 80) return '#16a34a';
  if (score >= 60) return '#d97706';
  if (score >= 40) return '#ea580c';
  return '#dc2626';
}

function generateReportId() {
  return 'SV-' + Date.now().toString(36).toUpperCase();
}

function sectionLabel(text, color = '#1f2937', bgColor = '#f1f5f9') {
  return `<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:${color};background:${bgColor};padding:3px 7px;border-radius:3px;display:inline-block;margin-bottom:5px">${text}</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────────────────────────────────────

function buildCriticalFindings(results) {
  const items = Object.entries(results || {}).filter(([, r]) => r.status === 'fail');
  if (!items.length) {
    return '<p style="color:#15803d;font-size:12px;font-style:italic;padding:10px">No critical failures detected.</p>';
  }
  return items.map(([key, result]) => {
    const meta = MODULE_META[key] || { name: key };
    const impact = BUSINESS_IMPACT[key]?.fail;
    const sme = SME_CASES[key]?.fail;
    const issuesHtml = result.issues?.length
      ? result.issues.map(i => `<li style="font-size:12px;margin-bottom:3px;color:#374151">${sanitize(i)}</li>`).join('')
      : '<li style="font-size:12px;color:#374151">Check failed — see detailed results section</li>';
    const smeHtml = sme ? `
      <div style="margin-top:8px;padding:8px 10px;background:#fff7ed;border-radius:4px;border-left:3px solid #ea580c">
        <div style="font-size:10px;font-weight:700;color:#c2410c;margin-bottom:4px">REAL-WORLD EXAMPLE — ${sanitize(sme.business)}, ${sanitize(sme.year)}</div>
        <div style="font-size:11px;color:#374151;margin-bottom:2px"><strong>What happened:</strong> ${sanitize(sme.happened)}</div>
        <div style="font-size:11px;color:#374151;margin-bottom:2px"><strong>Result:</strong> ${sanitize(sme.result)}</div>
        <div style="font-size:11px;color:#dc2626;font-weight:700"><strong>Cost:</strong> ${sanitize(sme.cost)}</div>
      </div>` : '';
    return `<div style="margin-bottom:14px;border:1px solid #fca5a5;border-left:4px solid #dc2626;border-radius:6px;overflow:hidden;page-break-inside:avoid">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#fee2e2">
        <div style="font-size:13px;font-weight:700;color:#7f1d1d">${sanitize(meta.name)}</div>
        <span style="font-size:10px;font-weight:700;color:#dc2626;background:#fff;padding:2px 8px;border-radius:3px">⛔ CRITICAL FAIL</span>
      </div>
      <div style="padding:10px 12px">
        <div style="margin-bottom:6px">${sectionLabel('What failed', '#b91c1c', '#fee2e2')}</div>
        <ul style="margin:0 0 8px 0;padding-left:18px">${issuesHtml}</ul>
        ${impact ? `<div style="margin-bottom:6px">${sectionLabel('Business impact', '#92400e', '#fef9c3')}</div>
        <div style="font-size:12px;font-weight:600;color:#1f2937;margin-bottom:4px">${sanitize(impact.headline)}</div>` : ''}
        ${smeHtml}
        <div style="margin-top:8px;font-size:11px;color:#b91c1c;font-weight:700">⏰ Timeline: Fix within 7 days</div>
      </div>
    </div>`;
  }).join('');
}

function buildAdvisoryFindings(results) {
  const items = Object.entries(results || {}).filter(([, r]) => r.status === 'warn');
  if (!items.length) {
    return '<p style="color:#15803d;font-size:12px;font-style:italic;padding:10px">No advisory warnings detected.</p>';
  }
  return items.map(([key, result]) => {
    const meta = MODULE_META[key] || { name: key };
    const impact = BUSINESS_IMPACT[key]?.warn;
    const sme = SME_CASES[key]?.warn;
    const issuesHtml = result.issues?.length
      ? result.issues.map(i => `<li style="font-size:12px;margin-bottom:3px;color:#374151">${sanitize(i)}</li>`).join('')
      : '<li style="font-size:12px;color:#374151">Warning detected — see detailed results section</li>';
    const smeHtml = sme ? `
      <div style="margin-top:8px;padding:8px 10px;background:#fff7ed;border-radius:4px;border-left:3px solid #f59e0b">
        <div style="font-size:10px;font-weight:700;color:#b45309;margin-bottom:4px">REAL-WORLD EXAMPLE — ${sanitize(sme.business)}, ${sanitize(sme.year)}</div>
        <div style="font-size:11px;color:#374151;margin-bottom:2px"><strong>What happened:</strong> ${sanitize(sme.happened)}</div>
        <div style="font-size:11px;color:#374151"><strong>Cost:</strong> ${sanitize(sme.cost)}</div>
      </div>` : '';
    return `<div style="margin-bottom:14px;border:1px solid #fcd34d;border-left:4px solid #d97706;border-radius:6px;overflow:hidden;page-break-inside:avoid">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#fef9c3">
        <div style="font-size:13px;font-weight:700;color:#78350f">${sanitize(meta.name)}</div>
        <span style="font-size:10px;font-weight:700;color:#d97706;background:#fff;padding:2px 8px;border-radius:3px">⚠ ADVISORY WARNING</span>
      </div>
      <div style="padding:10px 12px">
        <div style="margin-bottom:6px">${sectionLabel('What was found', '#92400e', '#fef9c3')}</div>
        <ul style="margin:0 0 8px 0;padding-left:18px">${issuesHtml}</ul>
        ${impact ? `<div style="font-size:12px;color:#374151;margin-bottom:6px">${sanitize(impact.headline)}</div>` : ''}
        ${smeHtml}
        <div style="margin-top:8px;font-size:11px;color:#d97706;font-weight:700">📅 Timeline: Plan to address within 30 days</div>
      </div>
    </div>`;
  }).join('');
}

function buildScannerCards(results) {
  return Object.entries(results || {}).map(([key, result]) => {
    const meta = MODULE_META[key] || { name: key, checked: '' };
    const status = result.status;
    const s = STATUS_STYLES[status] || STATUS_STYLES.error;
    const meaning = PLAIN_MEANING[key]?.[status] || '';
    const impact = BUSINESS_IMPACT[key]?.[status];
    const sme = SME_CASES[key]?.[status];
    const fix = HOW_TO_FIX[key]?.[status];

    // b) Issues
    const issuesHtml = result.issues?.length
      ? `<ul style="margin:6px 0 0 0;padding-left:18px">${result.issues.map(i =>
          `<li style="font-size:12px;margin-bottom:3px;color:#374151;line-height:1.5">${sanitize(i)}</li>`).join('')}</ul>`
      : `<p style="font-size:12px;color:#15803d;margin:6px 0 0 0">✓ No issues found for this check.</p>`;

    // c) Plain meaning
    const meaningHtml = meaning
      ? `<div style="margin-top:10px">
           ${sectionLabel('What this means')}
           <p style="font-size:12px;color:#374151;line-height:1.6;margin:0">${sanitize(meaning)}</p>
         </div>` : '';

    // d) Business impact (warn/fail only)
    const impactHtml = impact
      ? `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border-radius:4px;border-left:3px solid #f59e0b;page-break-inside:avoid">
           ${sectionLabel('What could happen if not fixed', '#92400e', '#fef9c3')}
           <div style="font-size:12px;font-weight:700;color:#1f2937;margin-bottom:6px">${sanitize(impact.headline)}</div>
           <ul style="margin:0 0 8px 0;padding-left:16px">
             ${impact.bullets.map(b => `<li style="font-size:11px;margin-bottom:3px;color:#374151;line-height:1.5">${sanitize(b)}</li>`).join('')}
           </ul>
           <div style="font-size:11px;padding-top:6px;border-top:1px solid #fde68a">
             <span style="font-weight:700;color:#92400e">Responsible: </span><span style="color:#374151">${sanitize(impact.responsible)}</span>
           </div>
         </div>` : '';

    // e) Real-world SME example
    const smeHtml = sme
      ? `<div style="margin-top:10px;padding:10px 12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:4px;border-left:3px solid #64748b;page-break-inside:avoid">
           ${sectionLabel('Real-world example — similar business')}
           <table style="width:100%;border-collapse:collapse;font-size:11px">
             <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;white-space:nowrap;vertical-align:top">Business:</td><td style="color:#374151">${sanitize(sme.business)}, ${sanitize(sme.year)}</td></tr>
             <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;white-space:nowrap;vertical-align:top">What happened:</td><td style="color:#374151">${sanitize(sme.happened)}</td></tr>
             <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;white-space:nowrap;vertical-align:top">Result:</td><td style="color:#374151">${sanitize(sme.result)}</td></tr>
             <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#dc2626;white-space:nowrap;vertical-align:top">Cost / Fine:</td><td style="color:#dc2626;font-weight:600">${sanitize(sme.cost)}</td></tr>
             <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;white-space:nowrap;vertical-align:top">Lesson:</td><td style="color:#374151;font-style:italic">${sanitize(sme.lesson)}</td></tr>
           </table>
         </div>` : '';

    // f) How to fix
    const fixHtml = fix
      ? `<div style="margin-top:10px;padding:10px 12px;background:#eff6ff;border-radius:4px;border-left:3px solid #2563eb;page-break-inside:avoid">
           ${sectionLabel('How to fix this', '#1d4ed8', '#dbeafe')}
           <ol style="margin:6px 0 8px 0;padding-left:18px">
             ${fix.steps.map(step => `<li style="font-size:11px;margin-bottom:4px;color:#1e3a5f;line-height:1.5">${sanitize(step)}</li>`).join('')}
           </ol>
           <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:11px;padding-top:6px;border-top:1px solid #bfdbfe">
             <div><span style="font-weight:700;color:#1d4ed8">Time: </span><span style="color:#1e3a5f">${sanitize(fix.time)}</span></div>
             <div><span style="font-weight:700;color:#1d4ed8">Cost: </span><span style="color:#1e3a5f">${sanitize(fix.cost)}</span></div>
             <div><span style="font-weight:700;color:#1d4ed8">Who: </span><span style="color:#1e3a5f">${sanitize(fix.who)}</span></div>
             <div><span style="font-weight:700;color:#1d4ed8">Urgency: </span><span style="color:#dc2626;font-weight:700">${sanitize(fix.urgency)}</span></div>
           </div>
         </div>` : '';

    return `<div style="margin-bottom:24px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:10px 14px;background:#f9fafb;border-bottom:2px solid ${s.text}">
        <div>
          <div style="font-size:14px;font-weight:800;color:#1f2937">${sanitize(meta.name)}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px"><em>Checks:</em> ${sanitize(meta.checked)}</div>
        </div>
        ${statusBadge(status)}
      </div>
      <div style="padding:12px 14px">
        <div>${sectionLabel('Status &amp; findings')}</div>
        ${result.error ? `<p style="font-size:12px;color:#b91c1c;margin:0 0 6px 0">Error: ${sanitize(result.error)}</p>` : ''}
        ${issuesHtml}
        ${meaningHtml}
        ${impactHtml}
        ${smeHtml}
        ${fixHtml}
      </div>
    </div>`;
  }).join('');
}

function buildPriorityRecommendations(results) {
  const p1 = []; // Critical: fix within 7 days
  const p2 = []; // Advisory: fix within 30 days
  for (const [key, result] of Object.entries(results || {})) {
    if (result.status === 'pass' || result.status === 'error') continue;
    const entry = { name: MODULE_META[key]?.name || key, status: result.status, fix: HOW_TO_FIX[key]?.[result.status] };
    if (result.status === 'fail') p1.push(entry);
    else p2.push(entry);
  }

  const renderBlock = (items, priority, color, bg, timeline) => {
    if (!items.length) return '';
    return `<div style="margin-bottom:20px">
      <div style="background:${bg};color:${color};padding:8px 12px;border-radius:6px;font-size:12px;font-weight:700;margin-bottom:10px;border-left:4px solid ${color}">
        Priority ${priority} — ${timeline}
      </div>
      ${items.map((item, i) => `
        <div style="display:flex;gap:10px;padding:8px 10px;margin-bottom:8px;border:1px solid #e5e7eb;border-radius:4px;page-break-inside:avoid">
          <div style="font-weight:800;font-size:13px;color:#9ca3af;min-width:18px">${i + 1}.</div>
          <div style="flex:1">
            <div style="font-size:12px;font-weight:700;color:${color};margin-bottom:3px">${sanitize(item.name)}</div>
            <div style="font-size:11px;color:#374151">Estimated effort: ${sanitize(item.fix?.time || 'See detailed results')}</div>
            <div style="font-size:11px;color:#374151">Who: ${sanitize(item.fix?.who || 'Web developer or web host')}</div>
          </div>
        </div>`).join('')}
    </div>`;
  };

  const p3Html = `<div style="margin-bottom:20px">
    <div style="background:#f1f5f9;color:#475569;padding:8px 12px;border-radius:6px;font-size:12px;font-weight:700;margin-bottom:10px;border-left:4px solid #94a3b8">
      Priority 3 — Ongoing best practice
    </div>
    ${[
      'Set up SSL certificate monitoring and auto-renewal alerts',
      'Schedule a quarterly security re-scan to track improvements',
      'Keep all CMS plugins, themes, and frameworks updated monthly',
      'Review DNS records every time a service is decommissioned',
      'Conduct an annual full security and GDPR compliance review',
    ].map((item, i) => `<div style="display:flex;gap:10px;padding:7px 10px;margin-bottom:6px;border:1px solid #e5e7eb;border-radius:4px">
      <div style="font-weight:800;font-size:13px;color:#9ca3af;min-width:18px">${i + 1}.</div>
      <div style="font-size:11px;color:#374151">${sanitize(item)}</div>
    </div>`).join('')}
  </div>`;

  if (!p1.length && !p2.length) {
    return `<p style="color:#15803d;font-style:italic;font-size:12px">No remediation required — all checks passed.</p>${p3Html}`;
  }

  return [
    renderBlock(p1, '1 (Critical)', '#dc2626', '#fee2e2', 'Fix within 7 days'),
    renderBlock(p2, '2 (Advisory)', '#d97706', '#fef9c3', 'Fix within 30 days'),
    p3Html,
  ].join('');
}

function buildComplianceChecklist(results) {
  const gdpr = results?.gdpr?.details || {};
  const items = [
    { label: 'HTTPS enabled (SSL/TLS certificate present and active)',  pass: results?.ssl?.status !== 'fail' && results?.ssl?.status !== 'error' },
    { label: 'SSL certificate valid and not expired or expiring soon',  pass: results?.ssl?.status === 'pass' },
    { label: 'Critical security headers configured (CSP and HSTS)',     pass: results?.headers?.status !== 'fail' },
    { label: 'All recommended security headers configured',             pass: results?.headers?.status === 'pass' },
    { label: 'Email authentication configured (SPF / DKIM / DMARC)',   pass: results?.dns?.status === 'pass' },
    { label: 'No dangerous ports exposed to the internet',             pass: results?.ports?.status !== 'fail' },
    { label: 'Privacy policy present and linked on website',           pass: !!gdpr.privacyPolicy },
    { label: 'Cookie consent mechanism implemented',                   pass: !!gdpr.cookieConsent },
    { label: 'No tracking scripts running without user consent',       pass: !(gdpr.trackers?.length > 0 && !gdpr.cookieConsent) },
    { label: 'Data subject rights information present',                pass: !!gdpr.dataRightsPresent },
  ];
  const passCount = items.filter(i => i.pass).length;
  const pct = Math.round((passCount / items.length) * 100);
  const scoreColor = pct >= 80 ? '#15803d' : pct >= 60 ? '#a16207' : '#b91c1c';

  const listHtml = items.map(item => {
    const icon = item.pass ? '✓' : '✗';
    const color = item.pass ? '#15803d' : '#b91c1c';
    const bg = item.pass ? '#f0fdf4' : '#fef2f2';
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;margin-bottom:5px;border-radius:4px;background:${bg}">
      <span style="font-weight:800;color:${color};font-size:13px;min-width:14px">${icon}</span>
      <span style="font-size:12px;color:#374151">${sanitize(item.label)}</span>
    </div>`;
  }).join('');

  const scoreHtml = `<div style="margin-top:12px;padding:10px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;text-align:center">
    <span style="font-size:22px;font-weight:800;color:${scoreColor}">${passCount}/${items.length}</span>
    <span style="font-size:13px;color:#6b7280;margin-left:8px">requirements passing (${pct}%)</span>
  </div>`;

  return listHtml + scoreHtml;
}

function buildRiskMatrix(results) {
  const entries = Object.values(results || {});
  const criticalCount = entries.filter(r => r.status === 'fail').length;
  const warnCount = entries.filter(r => r.status === 'warn').length;
  const passCount = entries.filter(r => r.status === 'pass').length;
  const errorCount = entries.filter(r => r.status === 'error').length;
  const overall = criticalCount > 0 ? { label: 'CRITICAL', color: '#dc2626', bg: '#fee2e2' }
    : warnCount > 2 ? { label: 'HIGH', color: '#c2410c', bg: '#ffedd5' }
    : warnCount > 0 ? { label: 'MEDIUM', color: '#d97706', bg: '#fef9c3' }
    : { label: 'LOW', color: '#15803d', bg: '#dcfce7' };

  const row = (label, count, color, bg) =>
    `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;margin-bottom:5px;border-radius:4px;background:${bg}">
       <span style="font-weight:800;font-size:20px;color:${color};min-width:30px">${count}</span>
       <span style="font-size:12px;color:#374151">${label}</span>
     </div>`;

  return `<div style="margin-bottom:10px">
    ${row('Critical issues (failed checks)', criticalCount, '#dc2626', '#fee2e2')}
    ${row('Warnings (advisory issues)', warnCount, '#d97706', '#fef9c3')}
    ${row('Passed checks', passCount, '#15803d', '#f0fdf4')}
    ${errorCount > 0 ? row('Checks with errors (could not complete)', errorCount, '#475569', '#f1f5f9') : ''}
    <div style="margin-top:10px;padding:10px 14px;background:${overall.bg};border-left:4px solid ${overall.color};border-radius:4px">
      <div style="font-size:11px;font-weight:700;color:${overall.color};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">Overall Risk Level</div>
      <div style="font-size:20px;font-weight:800;color:${overall.color}">${overall.label}</div>
    </div>
  </div>`;
}

function buildRemediationTimeline(results) {
  const immediate = []; // 0–7 days
  const shortTerm = []; // 8–30 days
  for (const [key, result] of Object.entries(results || {})) {
    const name = MODULE_META[key]?.name || key;
    if (result.status === 'fail') immediate.push(name);
    else if (result.status === 'warn') shortTerm.push(name);
  }
  const ongoing = [
    'Set up SSL certificate monitoring and auto-renewal',
    'Schedule a quarterly Soterius security re-scan to track improvements',
    'Monthly: update CMS plugins, themes, and dependencies',
    'Annually: review and update privacy policy and cookie consent',
  ];

  const block = (title, items, color, bg, isCheckbox = true) => {
    if (!items.length && isCheckbox) return '';
    return `<div style="margin-bottom:14px;padding:10px 12px;background:${bg};border-radius:6px;border-left:4px solid ${color}">
      <div style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px">${sanitize(title)}</div>
      ${items.map(i => `<div style="font-size:12px;color:#374151;margin-bottom:4px">${isCheckbox ? '□ ' : '• '}${sanitize(i)}</div>`).join('')}
      ${isCheckbox && items.length ? `<div style="font-size:11px;color:${color};margin-top:6px;font-weight:600">Estimated effort: See detailed results section</div>` : ''}
    </div>`;
  };

  return [
    immediate.length ? block('Immediate action required (0–7 days)', immediate, '#dc2626', '#fee2e2') : '<div style="padding:8px 12px;background:#f0fdf4;border-radius:6px;border-left:4px solid #15803d;font-size:12px;color:#15803d;margin-bottom:14px">✓ No immediate actions required</div>',
    shortTerm.length ? block('Short-term (8–30 days)', shortTerm, '#d97706', '#fef9c3') : '',
    block('Ongoing (recommended best practice)', ongoing, '#2563eb', '#eff6ff', false),
  ].join('');
}

function buildNextSteps() {
  const steps = [
    'Review this report with your web designer, web host, or IT team',
    'Share the priority list — red items must be fixed within 7 days',
    'Request a specific timeline and written confirmation for each fix',
    'Implement fixes starting with Critical (red) items first',
    'Schedule a follow-up scan in 30 days to verify all fixes are in place',
    'Set up SSL certificate monitoring to prevent unexpected expiry',
    'Contact Soterius if you need help interpreting or acting on any findings',
  ];
  return `<ol style="padding-left:18px;margin:0">
    ${steps.map(s => `<li style="font-size:12px;color:#374151;margin-bottom:6px;line-height:1.6">${sanitize(s)}</li>`).join('')}
  </ol>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF generation
// ─────────────────────────────────────────────────────────────────────────────

async function generatePDF(scanData) {
  const templatePath = path.join(__dirname, 'template.html');
  let html = await fs.promises.readFile(templatePath, 'utf8');

  const results    = scanData.results || {};
  const score      = scanData.overallScore ?? 0;
  const RISK_KEY_MAP = { green: 'low', amber: 'medium', red: 'high' };
  const riskRaw    = String(scanData.riskLevel || '').toLowerCase();
  const riskKey    = RISK_KEY_MAP[riskRaw] || 'critical';
  const riskStyle  = RISK_STYLES[riskKey] || RISK_STYLES.critical;
  const scoreColor = getScoreColor(score);
  const RISK_LABELS = { low: 'Low Risk', medium: 'Medium Risk', high: 'High Risk', critical: 'Critical Risk' };
  const riskLabel  = RISK_LABELS[riskKey] || 'Critical Risk';

  const entries      = Object.values(results);
  const totalIssues  = entries.reduce((s, r) => s + (r.issues?.length || 0), 0);
  const passCount    = entries.filter(r => r.status === 'pass').length;
  const warnCount    = entries.filter(r => r.status === 'warn').length;
  const failCount    = entries.filter(r => r.status === 'fail').length;
  const errorCount   = entries.filter(r => r.status === 'error').length;
  const checkCount   = passCount + warnCount + failCount + errorCount;

  html = html
    .replace(/\{\{domain\}\}/g,                 sanitize(scanData.domain))
    .replace(/\{\{timestamp\}\}/g,               sanitize(new Date(scanData.timestamp).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })))
    .replace(/\{\{generatedDate\}\}/g,           sanitize(new Date().toLocaleDateString('en-GB', { dateStyle: 'long' })))
    .replace(/\{\{reportId\}\}/g,                generateReportId())
    .replace(/\{\{overallScore\}\}/g,            sanitize(String(score)))
    .replace(/\{\{scoreColor\}\}/g,              scoreColor)
    .replace(/\{\{riskLabel\}\}/g,               sanitize(riskLabel))
    .replace(/\{\{riskBg\}\}/g,                  riskStyle.bg)
    .replace(/\{\{riskColor\}\}/g,               riskStyle.text)
    .replace(/\{\{checkCount\}\}/g,              sanitize(String(checkCount)))
    .replace(/\{\{totalIssues\}\}/g,             sanitize(String(totalIssues)))
    .replace(/\{\{passCount\}\}/g,               sanitize(String(passCount)))
    .replace(/\{\{warnCount\}\}/g,               sanitize(String(warnCount)))
    .replace(/\{\{failCount\}\}/g,               sanitize(String(failCount)))
    .replace(/\{\{errorCount\}\}/g,              sanitize(String(errorCount)))
    .replace(/\{\{criticalFindings\}\}/g,        buildCriticalFindings(results))
    .replace(/\{\{advisoryFindings\}\}/g,        buildAdvisoryFindings(results))
    .replace(/\{\{scannerCards\}\}/g,            buildScannerCards(results))
    .replace(/\{\{priorityRecommendations\}\}/g, buildPriorityRecommendations(results))
    .replace(/\{\{complianceChecklist\}\}/g,     buildComplianceChecklist(results))
    .replace(/\{\{riskMatrix\}\}/g,              buildRiskMatrix(results))
    .replace(/\{\{remediationTimeline\}\}/g,     buildRemediationTimeline(results))
    .replace(/\{\{nextSteps\}\}/g,               buildNextSteps());

  const browser = await puppeteer.launch({
    headless: true,
    // PUPPETEER_EXECUTABLE_PATH is set in production (Railway/Docker) to point at
    // the system Chromium. Unset locally → puppeteer uses its bundled Chrome.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: `<div style="font-family:Arial,sans-serif;font-size:9px;color:#9ca3af;width:100%;text-align:center;padding:0 15mm">
        Soterius Security Report &mdash; Page <span class="pageNumber"></span> of <span class="totalPages"></span>
      </div>`,
      margin: { top: '12mm', bottom: '18mm', left: '15mm', right: '15mm' },
    });
    logger.info(`PDF generated for ${scanData.domain} (${pdf.length} bytes)`);
    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generatePDF };
