const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cashctrl = require('../cashctrl');
const { getDb, getSetting, lastId } = require('../db');
const { analyzeReceipt, normalizeVendor } = require('../receiptAnalyzer');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const safe = String(file.originalname || 'beleg').replace(/[^\w.\-äöüÄÖÜ]+/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /pdf|jpeg|jpg|png|webp|tiff/i.test(file.mimetype || '')
      || /\.(pdf|jpe?g|png|webp|tiff?)$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Nur PDF- und Bilddateien sind erlaubt.'), ok);
  },
});

const router = express.Router();

router.get('/', (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM receipts ORDER BY created_at DESC LIMIT 50')
    .all()
    .map(mapReceipt);
  res.json({ receipts: rows });
});

router.post('/upload', (req, res, next) => {
  upload.array('files', 12)(req, res, (err) => {
    if (err) {
      err.status = 400;
      return next(err);
    }
    return uploadAndAnalyze(req, res, next);
  });
});

async function uploadAndAnalyze(req, res, next) {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ error: 'Bitte mindestens eine Datei hochladen.' });
    }
    const logic = req.body?.logic === 'historic' ? 'historic' : 'new';
    const now = new Date().toISOString();
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO receipts (original_name, stored_name, mime_type, size, logic, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'uploaded', ?)
    `);

    const created = files.map((file) => {
      const info = insert.run(file.originalname, file.filename, file.mimetype, file.size, logic, now);
      return { id: lastId(info), file };
    });

    const analyzed = [];
    for (const item of created) {
      analyzed.push(await analyzeOne(item.id, logic));
    }

    res.json({ receipts: analyzed });
  } catch (error) {
    next(error);
  }
}

router.post('/:id/analyze', async (req, res, next) => {
  try {
    const logic = req.body?.logic === 'historic' ? 'historic' : 'new';
    const receipt = await analyzeOne(Number(req.params.id), logic);
    res.json({ receipt });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/preview', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Beleg nicht gefunden.' });

  const suggestion = {
    ...safeJson(row.suggestion_json, {}),
    ...(req.body?.suggestion || {}),
  };
  db.prepare('UPDATE receipts SET suggestion_json = ?, status = ? WHERE id = ?')
    .run(JSON.stringify(suggestion), 'preview', row.id);

  res.json({ receipt: mapReceipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(row.id)) });
});

router.post('/:id/book', async (req, res, next) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Beleg nicht gefunden.' });

    const suggestion = {
      ...safeJson(row.suggestion_json, {}),
      ...(req.body?.suggestion || {}),
    };

    if (!suggestion.debitId || !suggestion.creditId || !suggestion.amount) {
      return res.status(400).json({ error: 'Soll-Konto, Haben-Konto und Betrag sind für die Buchung Pflicht.' });
    }

    const filePath = path.join(UPLOAD_DIR, row.stored_name);
    const buffer = fs.readFileSync(filePath);
    const fileId = await cashctrl.uploadAndPersistFile({
      name: row.original_name,
      mimeType: row.mime_type || 'application/pdf',
      buffer,
      description: suggestion.title || row.original_name,
    });

    const payload = {
      dateAdded: suggestion.dateAdded,
      title: suggestion.title || row.original_name,
      amount: suggestion.amount,
      debitId: suggestion.debitId,
      creditId: suggestion.creditId,
      attachments: [{ fileId }],
      notes: suggestion.notes || 'Verbucht durch CashCtrl-AI',
    };
    if (suggestion.taxId) payload.taxId = suggestion.taxId;
    const sequenceId = getSetting('defaultSequenceNumberId');
    if (sequenceId) payload.sequenceNumberId = sequenceId;

    const created = await cashctrl.createJournal(payload);
    const journalId = created?.insertId || null;

    db.prepare(
      `UPDATE receipts
       SET suggestion_json = ?, status = 'booked', cashctrl_file_id = ?, cashctrl_journal_id = ?, booked_at = ?
       WHERE id = ?`
    ).run(JSON.stringify(suggestion), fileId, journalId, new Date().toISOString(), row.id);

    db.prepare(
      `INSERT INTO booking_memory (vendor_norm, title, amount, debit_id, credit_id, tax_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalizeVendor(suggestion.vendor || suggestion.title || row.original_name),
      suggestion.title || row.original_name,
      Number(suggestion.amount) || 0,
      suggestion.debitId || null,
      suggestion.creditId || null,
      suggestion.taxId || null,
      new Date().toISOString()
    );

    res.json({
      ok: true,
      receipt: mapReceipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(row.id)),
    });
  } catch (error) {
    const db = getDb();
    db.prepare('UPDATE receipts SET status = ?, error_message = ? WHERE id = ?')
      .run('error', error.message, req.params.id);
    next(error);
  }
});

router.get('/:id/file', (req, res) => {
  const row = getDb().prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Beleg nicht gefunden.' });
  const filePath = path.join(UPLOAD_DIR, row.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Datei nicht mehr vorhanden.' });
  res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
  res.sendFile(filePath);
});

async function analyzeOne(id, logic) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  if (!row) {
    const error = new Error('Beleg nicht gefunden.');
    error.status = 404;
    throw error;
  }

  const filePath = path.join(UPLOAD_DIR, row.stored_name);
  const buffer = fs.readFileSync(filePath);

  let accounts = [];
  let taxes = [];
  let history = [];

  if (cashctrl.isConfigured()) {
    accounts = await cashctrl.listAccounts({ onlyActive: true }).then(cashctrl.mapList).catch(() => []);
    taxes = await cashctrl.listTaxes().then(cashctrl.mapList).catch(() => []);
    const journal = await cashctrl.listJournal({ limit: 200, sort: 'dateAdded', dir: 'DESC' })
      .then(cashctrl.mapList)
      .catch(() => []);
    history = [
      ...getDb().prepare('SELECT vendor_norm AS vendor, title, amount, debit_id, credit_id, tax_id FROM booking_memory ORDER BY created_at DESC LIMIT 200').all(),
      ...journal.map((entry) => ({
        vendor: entry.associateName || entry.title,
        title: entry.title,
        amount: entry.amount,
        debit_id: entry.debitId,
        credit_id: entry.creditId,
        tax_id: entry.taxId,
      })),
    ];
  } else {
    history = getDb()
      .prepare('SELECT vendor_norm AS vendor, title, amount, debit_id, credit_id, tax_id FROM booking_memory ORDER BY created_at DESC LIMIT 200')
      .all();
  }

  const result = await analyzeReceipt({
    buffer,
    mimeType: row.mime_type,
    filename: row.original_name,
    logic,
    accounts,
    taxes,
    history,
    defaults: {
      defaultBankAccountId: getSetting('defaultBankAccountId'),
      defaultExpenseAccountId: getSetting('defaultExpenseAccountId'),
    },
  });

  db.prepare(
    `UPDATE receipts
     SET extracted_json = ?, suggestion_json = ?, logic = ?, status = 'analyzed', error_message = NULL
     WHERE id = ?`
  ).run(JSON.stringify(result.extracted), JSON.stringify(result.suggestion), logic, row.id);

  return mapReceipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(row.id));
}

function mapReceipt(row) {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    logic: row.logic,
    status: row.status,
    extracted: safeJson(row.extracted_json, null),
    suggestion: safeJson(row.suggestion_json, null),
    cashctrlFileId: row.cashctrl_file_id,
    cashctrlJournalId: row.cashctrl_journal_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    bookedAt: row.booked_at,
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
