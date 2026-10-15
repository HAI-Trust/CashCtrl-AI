const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeJournal } = require('./reviewAnalyzer');

test('erkennt fehlendes Gegenkonto und MWST-Lücke', () => {
  const accounts = [
    { id: 1, number: '1020', name: 'Bank' },
    { id: 2, number: '6500', name: 'Büroaufwand' },
    { id: 3, number: '1090', name: 'Abklärungskonto' },
  ];
  const taxes = [{ id: 9, name: 'Normalsatz', percentage: 8.1 }];
  const findings = analyzeJournal([
    {
      id: 11,
      dateAdded: '2026-03-02',
      title: 'Unklarer Beleg',
      amount: 120,
      debitId: 2,
    },
    {
      id: 12,
      dateAdded: '2026-03-12',
      title: 'Papier',
      amount: 40,
      debitId: 2,
      creditId: 1,
    },
  ], accounts, taxes);

  assert.ok(findings.some((item) => item.type === 'missing_account'));
  assert.ok(findings.some((item) => item.type === 'missing_vat'));
  assert.ok(findings.some((item) => item.type === 'date_gap'));
});

test('erkennt Doppelbuchungen', () => {
  const entry = {
    id: 1,
    dateAdded: '2026-01-15',
    title: 'Swisscom',
    amount: 89.9,
    debitId: 2,
    creditId: 1,
    taxId: 9,
  };
  const findings = analyzeJournal([entry, { ...entry, id: 2 }], [], []);
  assert.equal(findings.filter((item) => item.type === 'duplicate').length, 2);
});
