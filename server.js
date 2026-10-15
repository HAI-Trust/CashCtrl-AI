const path = require('path');
const express = require('express');
const { initDb } = require('./src/db');
const { createRouter } = require('./src/routes');

initDb();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', createRouter());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'CashCtrl-AI' });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function listen(port) {
  const server = app.listen(port, () => {
    console.log(`CashCtrl-AI läuft unter http://localhost:${port}`);
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && port === PORT && !process.env.PORT) {
      listen(3847);
      return;
    }
    console.error(error);
    process.exit(1);
  });
}

listen(PORT);
