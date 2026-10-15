const path = require('path');

let pdfParse;
try {
  pdfParse = require('pdf-parse');
} catch {
  pdfParse = null;
}

const SWISS_VAT = [
  { rate: 8.1, label: 'Normalsatz 8.1%' },
  { rate: 3.8, label: 'Sondersatz 3.8%' },
  { rate: 2.6, label: 'Reduziert 2.6%' },
  { rate: 7.7, label: 'Alter Normalsatz 7.7%' },
  { rate: 2.5, label: 'Alter reduzierter Satz 2.5%' },
];

const KEYWORD_RULES = [
  { keys: ['sbb', 'zug', 'bahn', 'övl', 'oev', 'tram'], hint: 'reise' },
  { keys: ['swisscom', 'sunrise', 'salt', 'init7', 'hostpoint', 'cyon'], hint: 'telekom' },
  { keys: ['migros', 'coop', 'denner', 'aldi', 'lidl'], hint: 'lebensmittel' },
  { keys: ['ikea', 'jumbo', 'hornbach', 'bauhaus'], hint: 'material' },
  { keys: ['office', 'büro', 'buero', 'papier', 'stapler'], hint: 'buero' },
  { keys: ['microsoft', 'adobe', 'google', 'github', 'openai', 'cursor'], hint: 'software' },
  { keys: ['miete', 'rent', 'immobili'], hint: 'miete' },
  { keys: ['hotel', 'airbnb', 'booking'], hint: 'hotel' },
  { keys: ['restaurant', 'lunch', 'beiz', 'café', 'cafe'], hint: 'verpflegung' },
  { keys: ['post', 'dhl', 'ups', 'planzer'], hint: 'porto' },
  { keys: ['versicher', 'axa', 'helvetia', 'mobiliar'], hint: 'versicherung' },
  { keys: ['strom', 'ewz', 'energie', 'primeo'], hint: 'energie' },
];

const ACCOUNT_HINTS = {
  reise: [/reise|spesen|verkehr|fahrzeug/i, /^664/],
  telekom: [/telefon|telekom|kommunikation|internet/i, /^651/],
  lebensmittel: [/verpfleg|lebensmittel|repräsent/i, /^664|665/],
  material: [/material|waren|einkauf/i, /^4/],
  buero: [/büro|buero|verwaltung|sachaufwand/i, /^650/],
  software: [/informatik|software|lizenz|it /i, /^657|650/],
  miete: [/miete|raumaufwand/i, /^600|640/],
  hotel: [/reise|hotel|übernacht/i, /^664/],
  verpflegung: [/verpfleg|spesen|repräsent/i, /^664|665/],
  porto: [/porto|versand|post/i, /^651|650/],
  versicherung: [/versicher/i, /^630|670/],
  energie: [/energie|strom|wasser|heiz/i, /^640|646/],
};

async function analyzeReceipt({ buffer, mimeType, filename, logic, accounts, taxes, history, defaults }) {
  const extracted = await extractReceipt(buffer, mimeType, filename);
  const suggestion = logic === 'historic'
    ? suggestHistoric(extracted, history, accounts, taxes, defaults)
    : suggestNew(extracted, accounts, taxes, defaults);

  return { extracted, suggestion };
}

async function extractReceipt(buffer, mimeType, filename) {
  const text = await extractText(buffer, mimeType);
  const combined = `${filename || ''}\n${text}`;
  const amount = extractAmount(combined);
  const date = extractDate(combined);
  const vat = extractVat(combined, amount);
  const vendor = extractVendor(text, filename);

  return {
    filename: filename || '',
    vendor,
    date,
    amount,
    vatRate: vat.rate,
    vatAmount: vat.amount,
    currency: extractCurrency(combined),
    textPreview: text.slice(0, 1600),
    source: text ? (mimeType?.includes('pdf') ? 'pdf' : 'text') : 'filename',
  };
}

async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf' && pdfParse) {
    try {
      const result = await pdfParse(buffer);
      return String(result.text || '').replace(/\u0000/g, ' ');
    } catch {
      return '';
    }
  }
  return '';
}

function extractAmount(text) {
  const patterns = [
    /(?:total|summe|betrag|amount|brutto|zu\s*zahlen|zahlbetrag)[^\d]{0,20}((?:\d{1,3}(?:[.'\s]\d{3})*|\d+)[.,]\d{2})/gi,
    /(?:chf|eur|usd|sfr)\s*((?:\d{1,3}(?:[.'\s]\d{3})*|\d+)[.,]\d{2})/gi,
    /((?:\d{1,3}(?:[.'\s]\d{3})*|\d+)[.,]\d{2})\s*(?:chf|eur|usd|sfr)/gi,
  ];
  const found = [];
  patterns.forEach((pattern) => {
    for (const match of text.matchAll(pattern)) {
      found.push(parseAmount(match[1]));
    }
  });
  const valid = found.filter((value) => value > 0 && value < 1000000);
  if (!valid.length) return 0;
  return Math.max(...valid);
}

function extractDate(text) {
  const patterns = [
    /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/,
    /(\d{1,2})[./](\d{1,2})[./](\d{4})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    if (pattern === patterns[0]) {
      return isoDate(match[1], match[2], match[3]);
    }
    return isoDate(match[3], match[2], match[1]);
  }
  return new Date().toISOString().slice(0, 10);
}

function extractVat(text, gross) {
  const rateMatch = text.match(/(?:mwst|mwst\.|ust|vat|tva)[^\d]{0,16}(\d{1,2}[.,]\d{1,2})\s*%/i);
  if (rateMatch) {
    const rate = parseAmount(rateMatch[1]);
    return { rate, amount: gross ? round2(gross - gross / (1 + rate / 100)) : 0 };
  }
  if (gross) {
    for (const vat of SWISS_VAT) {
      const net = round2(gross / (1 + vat.rate / 100));
      const vatAmount = round2(gross - net);
      if (text.includes(String(vatAmount).replace('.', ',')) || text.includes(vatAmount.toFixed(2))) {
        return { rate: vat.rate, amount: vatAmount };
      }
    }
  }
  return { rate: 8.1, amount: gross ? round2(gross - gross / 1.081) : 0 };
}

function extractVendor(text, filename) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 3 && line.length <= 60 && !/seite|page|mwst|total|rechnung/i.test(line));

  if (lines[0] && /[a-zäöü]/i.test(lines[0])) {
    return cleanVendor(lines[0]);
  }

  const fromFile = path.parse(filename || '').name.replace(/[_-]+/g, ' ');
  return cleanVendor(fromFile || 'Unbekannter Lieferant');
}

function extractCurrency(text) {
  if (/\beur\b/i.test(text)) return 'EUR';
  if (/\busd\b/i.test(text)) return 'USD';
  return 'CHF';
}

function suggestNew(extracted, accounts, taxes, defaults = {}) {
  const hint = detectHint(`${extracted.vendor} ${extracted.textPreview} ${extracted.filename}`);
  const expense = matchAccount(accounts, hint) || findById(accounts, defaults.defaultExpenseAccountId) || firstByNumber(accounts, /^6/);
  const payment = findById(accounts, defaults.defaultBankAccountId)
    || firstByNumber(accounts, /^1020|^1000|^1021/)
    || accounts.find((account) => /bank|kasse/i.test(account.name || ''));
  const tax = matchTax(taxes, extracted.vatRate);

  const isInvoice = /rechnung|invoice|fällig|zahlbar/i.test(`${extracted.filename} ${extracted.textPreview}`);
  const credit = isInvoice
    ? (firstByNumber(accounts, /^20/) || payment)
    : payment;

  return {
    logic: 'new',
    confidence: hint ? 0.78 : 0.55,
    rationale: hint
      ? `Neue Logik: Beleg wurde als «${hint}» klassifiziert und dem passenden Sachkonto zugeordnet.`
      : 'Neue Logik: allgemeiner Aufwandvorschlag, da kein spezifisches Muster erkannt wurde.',
    vendor: extracted.vendor,
    dateAdded: extracted.date,
    title: `${extracted.vendor} – Beleg`.slice(0, 250),
    amount: extracted.amount,
    debitId: expense?.id || null,
    debitLabel: labelAccount(expense),
    creditId: credit?.id || null,
    creditLabel: labelAccount(credit),
    taxId: tax?.id || null,
    taxLabel: labelTax(tax),
    notes: 'Vorschlag durch CashCtrl-AI (neue Logik).',
  };
}

function suggestHistoric(extracted, history, accounts, taxes, defaults = {}) {
  const vendorNorm = normalizeVendor(extracted.vendor);
  const scored = (history || [])
    .map((row) => ({
      row,
      score: similarity(vendorNorm, normalizeVendor(row.vendor || row.vendor_norm || row.title || '')),
    }))
    .filter((item) => item.score >= 0.35)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const fallback = suggestNew(extracted, accounts, taxes, defaults);
    return {
      ...fallback,
      logic: 'historic',
      confidence: Math.min(fallback.confidence, 0.45),
      rationale: 'Bisherige Logik: kein ähnlicher Altbeleg gefunden. Es wurde auf die neue Logik zurückgegriffen.',
    };
  }

  const best = scored[0].row;
  const debit = findById(accounts, best.debitId || best.debit_id);
  const credit = findById(accounts, best.creditId || best.credit_id);
  const tax = findById(taxes, best.taxId || best.tax_id) || matchTax(taxes, extracted.vatRate);

  return {
    logic: 'historic',
    confidence: Math.min(0.93, 0.55 + scored[0].score * 0.4),
    rationale: `Bisherige Logik: Abgleich mit ähnlichem Beleg «${best.title || best.vendor || 'Historie'}».`,
    vendor: extracted.vendor,
    dateAdded: extracted.date,
    title: `${extracted.vendor} – ${best.title || 'Beleg'}`.slice(0, 250),
    amount: extracted.amount || Number(best.amount) || 0,
    debitId: debit?.id || best.debitId || best.debit_id || null,
    debitLabel: labelAccount(debit),
    creditId: credit?.id || best.creditId || best.credit_id || null,
    creditLabel: labelAccount(credit),
    taxId: tax?.id || best.taxId || best.tax_id || null,
    taxLabel: labelTax(tax),
    notes: 'Vorschlag durch CashCtrl-AI (historischer Abgleich).',
  };
}

function detectHint(text) {
  const hay = text.toLowerCase();
  const hit = KEYWORD_RULES.find((rule) => rule.keys.some((key) => hay.includes(key)));
  return hit?.hint || '';
}

function matchAccount(accounts, hint) {
  if (!hint || !ACCOUNT_HINTS[hint]) return null;
  const [nameRx, numberRx] = ACCOUNT_HINTS[hint];
  return accounts.find((account) => nameRx.test(account.name || '') || numberRx.test(String(account.number || ''))) || null;
}

function matchTax(taxes, rate) {
  if (!taxes.length) return null;
  if (!rate) return taxes[0];
  return taxes.find((tax) => Math.abs(Number(tax.percentage ?? tax.rate ?? 0) - Number(rate)) < 0.15)
    || taxes.find((tax) => String(tax.name || '').includes(String(rate)))
    || taxes[0];
}

function firstByNumber(accounts, pattern) {
  return accounts.find((account) => pattern.test(String(account.number || ''))) || null;
}

function findById(list, id) {
  if (id == null || id === '') return null;
  return list.find((item) => Number(item.id) === Number(id)) || null;
}

function labelAccount(account) {
  if (!account) return '–';
  return [account.number, account.name].filter(Boolean).join(' ');
}

function labelTax(tax) {
  if (!tax) return '–';
  return [tax.name, tax.percentage != null ? `${tax.percentage}%` : ''].filter(Boolean).join(' ');
}

function parseAmount(raw) {
  const normalized = String(raw).replace(/\s/g, '').replace(/'/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : 0;
}

function isoDate(year, month, day) {
  const y = String(year).padStart(4, '0');
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function cleanVendor(value) {
  return String(value).replace(/\s+/g, ' ').replace(/[^A-Za-zÄÖÜäöü0-9 .&-]/g, '').trim().slice(0, 80);
}

function normalizeVendor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ag|gmbh|sa|inc|ltd|gmbh|sarl/g, '')
    .replace(/[^a-z0-9äöü]/g, '');
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  let inter = 0;
  setA.forEach((ch) => {
    if (setB.has(ch)) inter += 1;
  });
  return inter / Math.max(setA.size, setB.size);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

module.exports = {
  analyzeReceipt,
  extractReceipt,
  suggestNew,
  suggestHistoric,
  normalizeVendor,
};
