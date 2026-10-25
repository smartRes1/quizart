'use strict';

// Wertung für alle Modi: mehr Punkte vor weniger, bei Gleichstand gewinnt,
// wer seine richtigen Antworten insgesamt schneller abgegeben hat.

// Sortiert rows ({name, score, ms}) und setzt rank; gleiche Punkte und Zeit = gleicher Platz
function rankRows(rows) {
  rows.sort((a, b) => b.score - a.score || a.ms - b.ms || a.name.localeCompare(b.name, 'de'));
  let rank = 0;
  rows.forEach((row, i) => {
    if (i === 0 || row.score !== rows[i - 1].score || row.ms !== rows[i - 1].ms) rank = i + 1;
    row.rank = rank;
  });
  return rows;
}

// Wie oft jede Antwort gewählt wurde; answers: { spielerId: {choice} }
function distribution(question, answers) {
  const counts = question.options.map(() => 0);
  for (const a of Object.values(answers || {})) if (counts[a.choice] !== undefined) counts[a.choice]++;
  return counts;
}

module.exports = { rankRows, distribution };
