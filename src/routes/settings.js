const express = require('express');
const cashctrl = require('../cashctrl');
const { getSetting, setSetting } = require('../db');
const { encryptSecret, decryptSecret, maskSecret } = require('../crypto');

const router = express.Router();

router.get('/', (req, res) => {
  const apiKey = decryptSecret(getSetting('apiKeyEnc') || '');
  res.json({
    subdomain: getSetting('subdomain') || '',
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    defaultBankAccountId: getSetting('defaultBankAccountId') || '',
    defaultExpenseAccountId: getSetting('defaultExpenseAccountId') || '',
    defaultSequenceNumberId: getSetting('defaultSequenceNumberId') || '',
    lastTestAt: getSetting('lastTestAt') || '',
    lastTestOk: getSetting('lastTestOk') === '1',
    lastTestMessage: getSetting('lastTestMessage') || '',
    configured: cashctrl.isConfigured(),
    baseUrl: cashctrl.isConfigured()
      ? cashctrl.getBaseUrl(getSetting('subdomain'))
      : '',
  });
});

router.post('/', (req, res) => {
  const {
    subdomain,
    apiKey,
    defaultBankAccountId,
    defaultExpenseAccountId,
    defaultSequenceNumberId,
  } = req.body || {};

  if (typeof subdomain === 'string') {
    const clean = subdomain.trim().replace(/^https?:\/\//, '').replace(/\.cashctrl\.com.*$/i, '').replace(/\/+$/, '');
    setSetting('subdomain', clean);
  }
  if (typeof apiKey === 'string' && apiKey.trim() && !apiKey.includes('•')) {
    setSetting('apiKeyEnc', encryptSecret(apiKey.trim()));
  }
  if (defaultBankAccountId !== undefined) setSetting('defaultBankAccountId', defaultBankAccountId || '');
  if (defaultExpenseAccountId !== undefined) setSetting('defaultExpenseAccountId', defaultExpenseAccountId || '');
  if (defaultSequenceNumberId !== undefined) setSetting('defaultSequenceNumberId', defaultSequenceNumberId || '');

  res.json({ ok: true });
});

router.post('/test', async (req, res, next) => {
  try {
    if (req.body?.subdomain || req.body?.apiKey) {
      if (req.body.subdomain) {
        const clean = String(req.body.subdomain).trim().replace(/^https?:\/\//, '').replace(/\.cashctrl\.com.*$/i, '');
        setSetting('subdomain', clean);
      }
      if (req.body.apiKey && !String(req.body.apiKey).includes('•')) {
        setSetting('apiKeyEnc', encryptSecret(String(req.body.apiKey).trim()));
      }
    }

    const result = await cashctrl.listAccounts({ onlyActive: true });
    const accounts = cashctrl.mapList(result);
    const message = `Verbindung erfolgreich. ${accounts.length} aktive Konten geladen.`;
    setSetting('lastTestAt', new Date().toISOString());
    setSetting('lastTestOk', '1');
    setSetting('lastTestMessage', message);
    res.json({
      ok: true,
      message,
      accountCount: accounts.length,
      sample: accounts.slice(0, 8).map((account) => ({
        id: account.id,
        number: account.number,
        name: account.name,
      })),
    });
  } catch (error) {
    setSetting('lastTestAt', new Date().toISOString());
    setSetting('lastTestOk', '0');
    setSetting('lastTestMessage', error.message);
    next(error);
  }
});

router.get('/lookups', async (req, res, next) => {
  try {
    if (!cashctrl.isConfigured()) {
      return res.json({ accounts: [], taxes: [], sequenceNumbers: [] });
    }
    const [accounts, taxes, sequenceNumbers] = await Promise.all([
      cashctrl.listAccounts({ onlyActive: true }).then(cashctrl.mapList).catch(() => []),
      cashctrl.listTaxes().then(cashctrl.mapList).catch(() => []),
      cashctrl.listSequenceNumbers().then(cashctrl.mapList).catch(() => []),
    ]);
    res.json({ accounts, taxes, sequenceNumbers });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
