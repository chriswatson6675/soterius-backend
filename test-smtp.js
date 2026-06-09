// Quick SMTP connectivity test — run with:
//   $env:SMTP_USER="support@soterius.co.uk"; $env:SMTP_PASS="yourpassword"; node test-smtp.js
require('dotenv').config();
const nodemailer = require('nodemailer');

const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const host = process.env.SMTP_HOST || 'mail.privateemail.com';
const port = Number(process.env.SMTP_PORT) || 587;

if (!user || !pass) {
  console.error('ERROR: SMTP_USER and SMTP_PASS must be set as environment variables');
  process.exit(1);
}

console.log(`Config: host=${host} port=${port} user=${user}`);

const transporter = nodemailer.createTransport({
  host,
  port,
  secure: false,
  auth: { user, pass },
});

async function run() {
  console.log('Verifying SMTP connection...');
  try {
    await transporter.verify();
    console.log('Connection OK');
  } catch (err) {
    console.error('Connection FAILED:', err.message);
    console.error('Code:', err.code);
    process.exit(1);
  }

  console.log(`Sending test email to ${user}...`);
  try {
    const info = await transporter.sendMail({
      from:    `"Soterius Test" <${user}>`,
      to:      user,
      subject: 'SMTP Test',
      text:    'If you received this, SMTP is working correctly.',
    });
    console.log('Email sent — Message ID:', info.messageId);
    console.log('Accepted by server:', info.accepted);
  } catch (err) {
    console.error('Send FAILED:', err.message);
    console.error('Code:', err.code);
    process.exit(1);
  }

  process.exit(0);
}

run();
