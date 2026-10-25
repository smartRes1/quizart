'use strict';

// Einstellungen aus Umgebungsvariablen, an einer Stelle für alle Module

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DATA_DIR,
  QUIZ_DIR: process.env.QUIZ_DIR || path.join(DATA_DIR, 'quizzes'),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  PUBLIC_URL: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  MAX_TEAMS: parseInt(process.env.MAX_TEAMS || '60', 10),
  // Anmeldung für die Online-Modi; ein Anbieter erscheint nur, wenn seine Daten gesetzt sind
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET || '',
  FACEBOOK_APP_ID: process.env.FACEBOOK_APP_ID || '',
  FACEBOOK_APP_SECRET: process.env.FACEBOOK_APP_SECRET || '',
  // Ohne SMTP_URL landen Anmelde-Links in der Konsole (zum Testen)
  SMTP_URL: process.env.SMTP_URL || '',
  MAIL_FROM: process.env.MAIL_FROM || 'Quiz-Party <quiz@localhost>',
};
