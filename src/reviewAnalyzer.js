const { normalizeDate } = require('./cashctrl');

const SUSPENSE_PATTERNS = [
  /unklar|abklär|durchlauf|zwischen|unbestimmt|offen|klärungskonto|transitor/i,
  /suspense|unassigned|tbd|todo/i,
];

const SUSPENSE_NUMBERS = new Set(['1090', '1091', '1099', '9900', '9999', '2300']);

function analyzeJournal(entries, accounts = [], taxes = []) {
  const accountMap = indexBy(accounts, 'id');
  const taxMap = indexBy(taxes, 'id');
  const findings = [];

  entries.forEach((entry) => {
    const context = describeEntry(entry, accountMap, taxMap);

    if (isMissingAccount(entry)) {
      findings.push(makeFinding(entry, context, {
        type: 'missing_account',
        severity: 'high',
        title: 'Ungeklärtes Gegenkonto',
        message: 'Soll- oder Haben-Konto fehlt. Die Buchung ist buchhalterisch unvollständig.',
        suggestion: 'Bitte fehlendes Konto ergänzen und als Korrektur buchen.',
        correction: suggestedAccountFix(entry, accounts),
      }));
    }

    if (sameDebitCredit(entry)) {
      findings.push(makeFinding(entry, context, {
        type: 'same_account',
        severity: 'high',
        title: 'Soll und Haben identisch',
        message: 'Dieselbe Kontonummer steht auf beiden Seiten. Es fehlt ein echtes Gegenkonto.',
        suggestion: 'Gegenkonto auf den tatsächlichen Aufwand, Ertrag oder das Bankkonto ändern.',
        correction: suggestedAccountFix(entry, accounts),
      }));
    }

    if (looksLikeSuspense(entry, accountMap)) {
      findings.push(makeFinding(entry, context, {
        type: 'suspense_account',
        severity: 'medium',
        title: 'Klärungs- oder Durchlaufkonto',
        message: 'Die Buchung hängt auf einem typischen Abklärungs- oder Zwischenkonto.',
        suggestion: 'Auf das fachlich richtige Sachkonto umbuchen.',
        correction: suggestedAccountFix(entry, accounts),
      }));
    }

    if (isMissingTitle(entry)) {
      findings.push(makeFinding(entry, context, {
        type: 'missing_title',
        severity: 'low',
        title: 'Unvollständiger Buchungstext',
        message: 'Es fehlt ein sprechender Buchungstext oder eine Referenz.',
        suggestion: 'Text mit Lieferant und Leistungsinhalt ergänzen.',
        correction: {
          title: entry.title || entry.description || 'Beleg prüfen – Text ergänzen',
        },
      }));
    }

    if (isZeroOrEmptyAmount(entry)) {
      findings.push(makeFinding(entry, context, {
        type: 'zero_amount',
        severity: 'high',
        title: 'Betrag fehlt oder ist 0',
        message: 'Ohne Betrag entsteht keine wirksame Buchung.',
        suggestion: 'Betrag aus dem Beleg nachtragen.',
      }));
    }

    if (isMissingVat(entry, accountMap, taxMap)) {
      findings.push(makeFinding(entry, context, {
        type: 'missing_vat',
        severity: 'medium',
        title: 'Unvollständige MWST-Zuordnung',
        message: 'Aufwand- oder Ertragskonto ohne Steuer-Code. Typisch für unvollständige MWST-Zuordnung.',
        suggestion: 'Passenden MWST-Satz zuweisen oder bewusst als nicht steuerbar kennzeichnen.',
        correction: suggestedTaxFix(entry, taxes),
      }));
    }
  });

  findings.push(...findDuplicates(entries, accountMap, taxMap));
  findings.push(...findDateGaps(entries, accountMap, taxMap));

  return findings;
}

function makeFinding(entry, context, extra) {
  return {
    journalId: entry.id ?? null,
    type: extra.type,
    severity: extra.severity,
    title: extra.title,
    message: extra.message,
    suggestion: extra.suggestion || '',
    entry: context,
    correction: {
      journalId: entry.id ?? null,
      dateAdded: context.date,
      title: extra.correction?.title || context.title,
      amount: extra.correction?.amount ?? context.amount,
      debitId: extra.correction?.debitId ?? context.debitId,
      creditId: extra.correction?.creditId ?? context.creditId,
      taxId: extra.correction?.taxId ?? context.taxId,
      notes: extra.suggestion || '',
    },
  };
}

function describeEntry(entry, accountMap, taxMap) {
  const debit = resolveAccount(entry, ['debitId', 'debitAccountId', 'accountDebitId'], ['debitName', 'debitAccountName'], accountMap);
  const credit = resolveAccount(entry, ['creditId', 'creditAccountId', 'accountCreditId'], ['creditName', 'creditAccountName'], accountMap);
  const tax = resolveTax(entry, taxMap);

  return {
    id: entry.id ?? null,
    date: normalizeDate(entry.dateAdded || entry.date),
    title: entry.title || entry.description || entry.name || '',
    reference: entry.reference || '',
    amount: toNumber(entry.amount ?? entry.debit ?? entry.credit),
    debitId: debit.id,
    debitName: debit.label,
    creditId: credit.id,
    creditName: credit.label,
    taxId: tax.id,
    taxName: tax.label,
    associate: entry.associateName || entry.associate || '',
  };
}

function resolveAccount(entry, idKeys, nameKeys, accountMap) {
  let id = null;
  for (const key of idKeys) {
    if (entry[key] != null && entry[key] !== '') {
      id = Number(entry[key]);
      break;
    }
  }
  const account = id ? accountMap.get(id) : null;
  const name = account?.name || nameKeys.map((key) => entry[key]).find(Boolean) || '';
  const number = account?.number || entry.debitNumber || entry.creditNumber || '';
  return {
    id,
    number: String(number || ''),
    name: String(name || ''),
    label: [number, name].filter(Boolean).join(' ') || '–',
  };
}

function resolveTax(entry, taxMap) {
  const id = entry.taxId != null && entry.taxId !== '' ? Number(entry.taxId) : null;
  const tax = id ? taxMap.get(id) : null;
  return {
    id,
    label: tax ? `${tax.name || tax.percentage || id}` : (entry.taxName || ''),
  };
}

function isMissingAccount(entry) {
  const debit = entry.debitId ?? entry.debitAccountId;
  const credit = entry.creditId ?? entry.creditAccountId;
  const items = entry.items || entry.journalItems;
  if (Array.isArray(items) && items.length >= 2) return false;
  return debit == null || debit === '' || credit == null || credit === '';
}

function sameDebitCredit(entry) {
  const debit = entry.debitId ?? entry.debitAccountId;
  const credit = entry.creditId ?? entry.creditAccountId;
  return debit != null && credit != null && Number(debit) === Number(credit);
}

function looksLikeSuspense(entry, accountMap) {
  const ids = [entry.debitId, entry.creditId, entry.debitAccountId, entry.creditAccountId]
    .filter((value) => value != null && value !== '')
    .map(Number);

  return ids.some((id) => {
    const account = accountMap.get(id);
    if (!account) return false;
    const number = String(account.number || '');
    const name = String(account.name || '');
    return SUSPENSE_NUMBERS.has(number) || SUSPENSE_PATTERNS.some((rx) => rx.test(name) || rx.test(number));
  });
}

function isMissingTitle(entry) {
  const title = String(entry.title || entry.description || '').trim();
  return title.length < 3;
}

function isZeroOrEmptyAmount(entry) {
  const amount = toNumber(entry.amount ?? entry.debit ?? entry.credit);
  return !amount;
}

function isMissingVat(entry, accountMap, taxMap) {
  if (entry.taxId) {
    return !taxMap.size ? false : !taxMap.has(Number(entry.taxId));
  }
  const ids = [entry.debitId, entry.creditId].filter(Boolean).map(Number);
  return ids.some((id) => {
    const account = accountMap.get(id);
    if (!account) return false;
    const number = String(account.number || '');
    const name = String(account.name || '').toLowerCase();
    const isPl = /^[3456]/.test(number);
    const vatRelevant = /aufwand|ertrag|waren|dienst|honorar|miete|werbung/i.test(name);
    return isPl && (vatRelevant || account.taxId);
  });
}

function findDuplicates(entries, accountMap, taxMap) {
  const groups = new Map();
  entries.forEach((entry) => {
    const date = normalizeDate(entry.dateAdded || entry.date);
    const amount = toNumber(entry.amount ?? entry.debit ?? entry.credit).toFixed(2);
    const title = normalizeText(entry.title || entry.description || '');
    const key = `${date}|${amount}|${title}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });

  const findings = [];
  groups.forEach((group) => {
    if (group.length < 2) return;
    group.forEach((entry) => {
      const context = describeEntry(entry, accountMap, taxMap);
      findings.push(makeFinding(entry, context, {
        type: 'duplicate',
        severity: 'medium',
        title: 'Mögliche Doppelbuchung',
        message: `Gleicher Tag, Betrag und Text kommen ${group.length}× vor.`,
        suggestion: 'Prüfen, ob eine Buchung storniert oder belassen werden soll.',
      }));
    });
  });
  return findings;
}

function findDateGaps(entries, accountMap, taxMap) {
  const dated = entries
    .map((entry) => ({ entry, date: normalizeDate(entry.dateAdded || entry.date) }))
    .filter((row) => row.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (dated.length < 2) return [];

  const findings = [];
  for (let i = 1; i < dated.length; i += 1) {
    const prev = new Date(`${dated[i - 1].date}T12:00:00`);
    const curr = new Date(`${dated[i].date}T12:00:00`);
    const diff = Math.round((curr - prev) / 86400000);
    if (diff >= 10) {
      const context = describeEntry(dated[i].entry, accountMap, taxMap);
      findings.push(makeFinding(dated[i].entry, context, {
        type: 'date_gap',
        severity: 'low',
        title: 'Buchungslücke',
        message: `Zwischen ${dated[i - 1].date} und ${dated[i].date} liegen ${diff} Tage ohne Journal-Eintrag.`,
        suggestion: 'Prüfen, ob Belege in diesem Zeitraum fehlen.',
      }));
    }
  }
  return findings;
}

function suggestedAccountFix(entry, accounts) {
  const bank = accounts.find((account) => /^10(20|21|00)/.test(String(account.number || '')))
    || accounts.find((account) => /bank|kasse/i.test(account.name || ''));
  const expense = accounts.find((account) => /^6/.test(String(account.number || '')));
  return {
    debitId: entry.debitId || expense?.id || null,
    creditId: entry.creditId || bank?.id || null,
  };
}

function suggestedTaxFix(entry, taxes) {
  const normal = taxes.find((tax) => /8\.1|7\.7|normal/i.test(`${tax.name || ''} ${tax.percentage || ''}`));
  return {
    taxId: entry.taxId || normal?.id || taxes[0]?.id || null,
  };
}

function indexBy(list, key) {
  const map = new Map();
  list.forEach((item) => {
    if (item && item[key] != null) map.set(Number(item[key]), item);
  });
  return map;
}

function toNumber(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(String(value).replace(/\s/g, '').replace("'", '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = {
  analyzeJournal,
  describeEntry,
};
