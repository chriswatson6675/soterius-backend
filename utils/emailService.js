const nodemailer = require('nodemailer');
const logger     = require('./logger');

// Transporter is created once at module load.
// If SMTP credentials are missing it won't throw — sendConfirmationEmail guards for that.
// Host/port can be overridden via SMTP_HOST / SMTP_PORT env vars for easy provider switching.
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'mail.privateemail.com',
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: false,   // false = STARTTLS on port 587; set SMTP_PORT=465 + SMTP_SECURE=true for SSL
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendConfirmationEmail(email, domain, scanScore) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn('[EMAIL] SMTP credentials not configured — skipping confirmation email');
    return;
  }

  const scoreDisplay = typeof scanScore === 'number' ? `${scanScore}/100` : 'N/A';

  logger.info('[EMAIL] SMTP config — host: ' + (process.env.SMTP_HOST || 'mail.privateemail.com') +
    ' | port: ' + (process.env.SMTP_PORT || 587) +
    ' | user: ' + process.env.SMTP_USER);
  logger.info('[EMAIL] Sending to: ' + email + ' | domain: ' + domain + ' | score: ' + scoreDisplay);

  try {
    await transporter.sendMail({
      from:    `"Soterius Scanner" <${process.env.SMTP_USER}>`,
      to:      email,
      subject: `Soterius Scan Complete: ${domain}`,
      text: [
        `Thank you for scanning ${domain}.`,
        `Your security score: ${scoreDisplay}`,
        '',
        'Your full report is ready — visit https://soterius-frontend.vercel.app to run a new scan.',
        '',
        'If you have questions, reply to this email.',
        '',
        '— The Soterius Team',
      ].join('\n'),
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
          <h2 style="color:#185FA5">Your Security Scan is Complete</h2>
          <p>Thank you for scanning <strong>${domain}</strong>.</p>
          <p>Your security score: <strong style="font-size:1.2em">${scoreDisplay}</strong></p>
          <p>
            <a href="https://soterius-frontend.vercel.app"
               style="display:inline-block;padding:10px 20px;background:#185FA5;color:#fff;text-decoration:none;border-radius:4px">
              Run Another Scan →
            </a>
          </p>
          <hr style="border:none;border-top:1px solid #e0e0e0;margin:24px 0">
          <p style="font-size:12px;color:#666">
            Soterius — Security + Compliance Scanner for UK Regulated Professions
          </p>
        </div>
      `,
    });
    logger.info(`[EMAIL] Successfully sent to ${email} for ${domain}`);
  } catch (err) {
    logger.error(`[EMAIL] Failed to send to ${email} — ${err.message}`);
    logger.error(`[EMAIL] Error code: ${err.code || 'none'} | Response: ${err.response || 'none'}`);
  }
}

module.exports = { sendConfirmationEmail };
