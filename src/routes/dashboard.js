const express = require('express');
const cashctrl = require('../cashctrl');
const { getDb, getSetting } = require('../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const pendingFindings = db.prepare("SELECT COUNT(*) AS count FROM review_findings WHERE status = 'pending'").get().count;
    const resolvedFindings = db.prepare("SELECT COUNT(*) AS count FROM review_findings WHERE status != 'pending'").get().count;
    const uploadedReceipts = db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count;
    const bookedReceipts = db.prepare("SELECT COUNT(*) AS count FROM receipts WHERE status = 'booked'").get().count;
    const recentReceipts = db.prepare('SELECT * FROM receipts ORDER BY created_at DESC LIMIT 5').all();
    const recentFindings = db.prepare('SELECT * FROM review_findings ORDER BY created_at DESC LIMIT 5').all();

    let remote = {
      connected: cashctrl.isConfigured(),
      accountCount: 0,
      journalCount: 0,
      organization: getSetting('subdomain') || '',
    };

    if (cashctrl.isConfigured()) {
      try {
        const [accounts, journal] = await Promise.all([
          cashctrl.listAccounts({ onlyActive: true }),
          cashctrl.listJournal({ limit: 1 }),
        ]);
        remote.accountCount = cashctrl.mapList(accounts).length;
        remote.journalCount = journal?.total ?? cashctrl.mapList(journal).length;
      } catch (error) {
        remote.connected = false;
        remote.error = error.message;
      }
    }

    res.json({
      remote,
      stats: {
        pendingFindings,
        resolvedFindings,
        uploadedReceipts,
        bookedReceipts,
      },
      recentReceipts: recentReceipts.map((row) => ({
        id: row.id,
        name: row.original_name,
        status: row.status,
        createdAt: row.created_at,
      })),
      recentFindings: recentFindings.map((row) => ({
        id: row.id,
        title: row.title,
        severity: row.severity,
        status: row.status,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
