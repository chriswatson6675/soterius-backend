const nodemailer = require('nodemailer');
const logger     = require('./logger');

async function sendConfirmationEmail(email, domain, scanScore) {
  const user   = process.env.SMTP_USER;
  const pass   = process.env.SMTP_PASS;
  const host   = process.env.SMTP_HOST   || 'mail.privateemail.com';
  const port   = Number(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === 'true';

  if (!user || !pass) {
    logger.warn('[EMAIL] SMTP_USER or SMTP_PASS not set — skipping confirmation email');
    return;
  }

  const scoreDisplay = typeof scanScore === 'number' ? `${scanScore}/100` : 'N/A';

  logger.info(`[EMAIL] SMTP config — host: ${host} | port: ${port} | secure: ${secure} | user: ${user}`);
  logger.info(`[EMAIL] Sending to: ${email} | domain: ${domain} | score: ${scoreDisplay}`);

  const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });

  try {
    logger.info('[EMAIL] Verifying SMTP connection...');
    await transporter.verify();
    logger.info('[EMAIL] SMTP connection OK');
  } catch (err) {
    logger.error(`[EMAIL] SMTP connection failed — ${err.message} | code: ${err.code}`);
    return;
  }

  try {
    const info = await transporter.sendMail({
      from:    `"Soterius Scanner" <${user}>`,
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
    logger.info(`[EMAIL] Successfully sent to ${email} — Message ID: ${info.messageId}`);
  } catch (err) {
    logger.error(`[EMAIL] Send failed — ${err.message} | code: ${err.code} | response: ${err.response || 'none'}`);
  }
}

module.exports = { sendConfirmationEmail };
