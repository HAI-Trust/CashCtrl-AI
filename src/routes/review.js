const express = require('express');
const cashctrl = require('../cashctrl');
const { getDb, getSetting, transaction, lastId } = require('../db');
const { analyzeJournal } = require('../reviewAnalyzer');

const router = express.Router();

router.post('/analyze', async (req, res, next) => {
  try {
    const startDate = String(req.body?.startDate || '').slice(0, 10);
    const endDate = String(req.body?.endDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return res.status(400).json({ error: 'Bitte gültiges Start- und Enddatum angeben.' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ error: 'Das Startdatum darf nicht nach dem Enddatum liegen.' });
    }

    const [entries, accounts, taxes] = await Promise.all([
      cashctrl.listJournalByDate(startDate, endDate),
      cashctrl.listAccounts({ onlyActive: true }).then(cashctrl.mapList).catch(() => []),
      cashctrl.listTaxes().then(cashctrl.mapList).catch(() => []),
    ]);

    const findings = analyzeJournal(entries, accounts, taxes);
    const db = getDb();
    const now = new Date().toISOString();

    const insert = db.prepare(`
      INSERT INTO review_findings (
        journal_id, period_start, period_end, type, severity, title, message,
        suggestion, entry_json, correction_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    const stored = transaction(() => {
      db.prepare(
        `DELETE FROM review_findings
         WHERE period_start = ? AND period_end = ? AND status = 'pending'`
      ).run(startDate, endDate);

      return findings.map((finding) => {
        const info = insert.run(
          finding.journalId,
          startDate,
          endDate,
          finding.type,
          finding.severity,
          finding.title,
          finding.message,
          finding.suggestion,
          JSON.stringify(finding.entry),
          JSON.stringify(finding.correction),
          now
        );
        return {
          id: lastId(info),
          status: 'pending',
          ...finding,
        };
      });
    });

    res.json({
      startDate,
      endDate,
      entryCount: entries.length,
      findingCount: stored.length,
      findings: stored,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/findings/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM review_findings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Auffälligkeit nicht gefunden.' });
  res.json({ finding: mapFinding(row) });
});

router.get('/findings', (req, res) => {
  const startDate = req.query.startDate;
  const endDate = req.query.endDate;
  let sql = 'SELECT * FROM review_findings';
  const params = [];
  if (startDate && endDate) {
    sql += ' WHERE period_start = ? AND period_end = ?';
    params.push(startDate, endDate);
  }
  sql += ' ORDER BY CASE severity WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, created_at DESC';
  const rows = getDb().prepare(sql).all(...params).map(mapFinding);
  res.json({ findings: rows });
});

router.post('/findings/:id/resolve', async (req, res, next) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM review_findings WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Auffälligkeit nicht gefunden.' });

    const action = req.body?.action === 'correct' ? 'correct' : 'approve';
    const incoming = req.body?.correction || {};
    const stored = safeJson(row.correction_json, {});
    const correction = { ...stored, ...incoming };

    let cashctrlJournalId = row.cashctrl_journal_id;
    let status = 'approved';

    if (action === 'correct') {
      const payload = buildJournalPayload(correction);
      try {
        if (correction.journalId) {
          const updated = await cashctrl.updateJournal({ id: correction.journalId, ...payload });
          cashctrlJournalId = updated?.insertId || correction.journalId;
        } else {
          throw new Error('no-id');
        }
      } catch {
        const created = await cashctrl.createJournal(payload);
        cashctrlJournalId = created?.insertId || null;
      }
      status = 'corrected';
    }

    db.prepare(
      `UPDATE review_findings
       SET status = ?, correction_json = ?, cashctrl_journal_id = ?, resolved_at = ?
       WHERE id = ?`
    ).run(status, JSON.stringify(correction), cashctrlJournalId, new Date().toISOString(), row.id);

    res.json({
      ok: true,
      finding: mapFinding(db.prepare('SELECT * FROM review_findings WHERE id = ?').get(row.id)),
    });
  } catch (error) {
    next(error);
  }
});

function buildJournalPayload(correction) {
  const payload = {
    dateAdded: correction.dateAdded,
    title: correction.title || 'CashCtrl-AI Korrektur',
    amount: correction.amount,
    debitId: correction.debitId,
    creditId: correction.creditId,
    notes: correction.notes || 'Korrektur durch CashCtrl-AI',
  };
  if (correction.taxId) payload.taxId = correction.taxId;
  const sequenceId = getSetting('defaultSequenceNumberId');
  if (sequenceId) payload.sequenceNumberId = sequenceId;
  return payload;
}

function mapFinding(row) {
  return {
    id: row.id,
    journalId: row.journal_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    type: row.type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    suggestion: row.suggestion,
    entry: safeJson(row.entry_json, {}),
    correction: safeJson(row.correction_json, {}),
    status: row.status,
    cashctrlJournalId: row.cashctrl_journal_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function safeJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

module.exports = router;
