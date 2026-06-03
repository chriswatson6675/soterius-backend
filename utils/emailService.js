const Mailgun   = require('mailgun.js');
const FormData  = require('form-data');
const logger    = require('./logger');

const mailgun = new Mailgun(FormData);

function getClient() {
  return mailgun.client({
    username: 'api',
    key: process.env.MAILGUN_API_KEY,
    // EU region: uncomment if your Mailgun domain is on the EU endpoint
    // url: 'https://api.eu.mailgun.net',
  });
}

async function sendConfirmationEmail(email, domain, scanScore) {
  if (!process.env.MAILGUN_API_KEY || !process.env.MAILGUN_DOMAIN) {
    logger.warn('[EMAIL] MAILGUN_API_KEY or MAILGUN_DOMAIN not configured — skipping confirmation email');
    return;
  }

  const scoreDisplay = typeof scanScore === 'number' ? `${scanScore}/100` : 'N/A';
  const from         = `Soterius Scanner <noreply@${process.env.MAILGUN_DOMAIN}>`;

  logger.info(`[EMAIL] Mailgun domain: ${process.env.MAILGUN_DOMAIN}`);
  logger.info(`[EMAIL] Sending to: ${email} | domain: ${domain} | score: ${scoreDisplay}`);

  try {
    const mg   = getClient();
    const result = await mg.messages.create(process.env.MAILGUN_DOMAIN, {
      from,
      to:      [email],
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

    logger.info(`[EMAIL] Successfully sent to ${email} — Mailgun ID: ${result.id}`);
  } catch (err) {
    logger.error(`[EMAIL] Failed to send to ${email} — ${err.message}`);
    logger.error(`[EMAIL] Status: ${err.status || 'none'} | Details: ${JSON.stringify(err.details || err.response || 'none')}`);
  }
}

module.exports = { sendConfirmationEmail };
