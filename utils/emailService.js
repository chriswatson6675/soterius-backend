const { Resend } = require('resend');
const logger     = require('./logger');

async function sendConfirmationEmail(email, domain, scanScore) {
  if (!process.env.RESEND_API_KEY) {
    logger.warn('[EMAIL] RESEND_API_KEY not set — skipping confirmation email');
    return;
  }

  const scoreDisplay = typeof scanScore === 'number' ? `${scanScore}/100` : 'N/A';
  const from         = 'noreply@mail.soterius.co.uk';

  logger.info(`[EMAIL] Sending via Resend to: ${email} | domain: ${domain} | score: ${scoreDisplay}`);

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    const { data, error } = await resend.emails.send({
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

    if (error) {
      logger.error(`[EMAIL] Resend API error — ${error.message}`);
      logger.error(`[EMAIL] Error details: ${JSON.stringify(error)}`);
      return;
    }

    logger.info(`[EMAIL] Successfully sent via Resend — Message ID: ${data.id}`);
  } catch (err) {
    logger.error(`[EMAIL] Resend threw an exception — ${err.message}`);
    logger.error(`[EMAIL] Full error: ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`);
  }
}

module.exports = { sendConfirmationEmail };
