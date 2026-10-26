'use strict';

// E-Mails über SMTP_URL; ohne SMTP_URL nur ins Log (zum Testen der Anmelde-Links)

const cfg = require('./config');

let transport = null;

async function sendMail(to, subject, text) {
  if (!cfg.SMTP_URL) {
    console.log(`[Mail an ${to}] ${subject}\n${text}\n`);
    return;
  }
  transport = transport || require('nodemailer').createTransport(cfg.SMTP_URL);
  await transport.sendMail({ from: cfg.MAIL_FROM, to, subject, text });
}

// Benachrichtigungen sind freiwillig: nur mit echtem Versand, Fehler werden nur geloggt
function notify(to, subject, text) {
  if (!cfg.SMTP_URL || !to) return;
  sendMail(to, subject, text).catch((e) => console.error('Benachrichtigung nicht gesendet:', e.message));
}

module.exports = { sendMail, notify };
