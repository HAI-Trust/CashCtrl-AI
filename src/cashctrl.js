const axios = require('axios');
const { getSetting } = require('./db');
const { decryptSecret } = require('./crypto');

class CashCtrlError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'CashCtrlError';
    this.status = status || 500;
    this.details = details;
  }
}

function getCredentials() {
  const subdomain = (getSetting('subdomain') || '').trim().replace(/^https?:\/\//, '').replace(/\.cashctrl\.com.*$/i, '');
  const apiKey = decryptSecret(getSetting('apiKeyEnc') || '');
  return { subdomain, apiKey };
}

function isConfigured() {
  const { subdomain, apiKey } = getCredentials();
  return Boolean(subdomain && apiKey);
}

function getBaseUrl(subdomain) {
  return `https://${subdomain}.cashctrl.com/api/v1`;
}

function createClient() {
  const { subdomain, apiKey } = getCredentials();
  if (!subdomain || !apiKey) {
    throw new CashCtrlError('CashCtrl ist noch nicht konfiguriert. Bitte Subdomain und API-Key hinterlegen.', 400);
  }

  return axios.create({
    baseURL: getBaseUrl(subdomain),
    timeout: 30000,
    auth: {
      username: apiKey,
      password: '',
    },
    params: {
      lang: getSetting('lang') || 'de',
    },
    headers: {
      Accept: 'application/json',
    },
    maxRedirects: 5,
  });
}

function unwrap(response) {
  const data = response.data;
  if (data && data.success === false) {
    const messages = Array.isArray(data.errors)
      ? data.errors.map((err) => err.message || JSON.stringify(err)).join(' ')
      : data.message || 'CashCtrl hat die Anfrage abgelehnt.';
    throw new CashCtrlError(messages, response.status || 200, data);
  }
  return data;
}

async function request(method, url, options = {}) {
  const client = createClient();
  try {
    const response = await client.request({ method, url, ...options });
    return unwrap(response);
  } catch (error) {
    if (error instanceof CashCtrlError) throw error;
    const status = error.response?.status;
    if (status === 401) {
      throw new CashCtrlError('API-Key wurde abgelehnt. Bitte Zugangsdaten prüfen.', 401);
    }
    if (status === 403) {
      throw new CashCtrlError('Der API-Benutzer hat keine Berechtigung für diesen Aufruf.', 403);
    }
    if (status === 404) {
      throw new CashCtrlError(`CashCtrl-Endpunkt nicht gefunden: ${url}`, 404);
    }
    const apiMessage = error.response?.data?.message
      || error.response?.data?.errors?.[0]?.message
      || error.message;
    throw new CashCtrlError(apiMessage || 'Unbekannter CashCtrl-Fehler', status || 502, error.response?.data);
  }
}

function asForm(fields) {
  const params = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  });
  return params;
}

async function listAccounts(params = {}) {
  return request('GET', '/account/list.json', {
    params: { onlyActive: true, sort: 'number', ...params },
  });
}

async function listJournal(params = {}) {
  return request('GET', '/journal/list.json', {
    params: { sort: 'dateAdded', dir: 'ASC', limit: 500, ...params },
  });
}

async function listJournalByDate(startDate, endDate) {
  const dayBefore = shiftDate(startDate, -1);
  const dayAfter = shiftDate(endDate, 1);
  const filter = [
    { field: 'dateAdded', comparison: 'gt', value: dayBefore },
    { field: 'dateAdded', comparison: 'lt', value: dayAfter },
  ];

  const collected = [];
  let start = 0;
  const limit = 500;

  while (true) {
    const page = await listJournal({
      start,
      limit,
      filter: JSON.stringify(filter),
    });
    const rows = page?.data || page?.list || [];
    collected.push(...rows);
    if (rows.length < limit) break;
    start += limit;
    if (start > 10000) break;
  }

  return collected.filter((entry) => {
    const date = normalizeDate(entry.dateAdded || entry.date);
    return date && date >= startDate && date <= endDate;
  });
}

async function listTaxes() {
  return request('GET', '/tax/list.json');
}

async function listSequenceNumbers() {
  return request('GET', '/sequencenumber/list.json');
}

async function listFiscalPeriods() {
  return request('GET', '/fiscalperiod/list.json');
}

async function createJournal(payload) {
  return request('POST', '/journal/create.json', {
    data: asForm(payload),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function updateJournal(payload) {
  return request('POST', '/journal/update.json', {
    data: asForm(payload),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function prepareFiles(files) {
  return request('POST', '/file/prepare.json', {
    data: asForm({ files }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function putFile(writeUrl, buffer, mimeType) {
  await axios.put(writeUrl, buffer, {
    headers: {
      'Content-Type': mimeType || 'application/octet-stream',
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 120000,
  });
}

async function persistFile(payload) {
  return request('POST', '/file/create.json', {
    data: asForm(payload),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function uploadAndPersistFile({ name, mimeType, buffer, description }) {
  const prepared = await prepareFiles([{ name, mimeType }]);
  const first = prepared?.data?.[0];
  if (!first?.fileId || !first?.writeUrl) {
    throw new CashCtrlError('CashCtrl hat keine Upload-URL geliefert.', 502, prepared);
  }
  await putFile(first.writeUrl, buffer, mimeType);
  await persistFile({
    id: first.fileId,
    name,
    description: description || `CashCtrl-AI Upload: ${name}`,
  });
  return first.fileId;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function normalizeDate(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function mapList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.list)) return payload.list;
  return [];
}

module.exports = {
  CashCtrlError,
  getCredentials,
  isConfigured,
  getBaseUrl,
  listAccounts,
  listJournal,
  listJournalByDate,
  listTaxes,
  listSequenceNumbers,
  listFiscalPeriods,
  createJournal,
  updateJournal,
  uploadAndPersistFile,
  mapList,
  normalizeDate,
};
