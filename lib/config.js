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
};
