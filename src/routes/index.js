const express = require('express');
const settings = require('./settings');
const review = require('./review');
const receipts = require('./receipts');
const dashboard = require('./dashboard');
const { CashCtrlError } = require('../cashctrl');

function createRouter() {
  const router = express.Router();
  router.use('/settings', settings);
  router.use('/review', review);
  router.use('/receipts', receipts);
  router.use('/dashboard', dashboard);

  router.use((error, _req, res, _next) => {
    const status = error instanceof CashCtrlError ? error.status : (error.status || 500);
    res.status(status).json({
      error: error.message || 'Interner Fehler',
      details: error.details || null,
    });
  });

  return router;
}

module.exports = { createRouter };
