const titles = {
  dashboard: ['Übersicht', 'Dashboard'],
  review: ['Modul 1', 'Buchhaltungs-Review'],
  upload: ['Modul 2', 'Beleg-Upload & Verbuchung'],
  settings: ['Konfiguration', 'Einstellungen'],
};

const state = {
  settings: null,
  lookups: { accounts: [], taxes: [], sequenceNumbers: [] },
};

async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(path, {
    headers: isForm ? {} : { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body && !isForm && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Anfrage fehlgeschlagen');
  }
  return data;
}

function toast(message, type = 'ok') {
  const root = document.getElementById('toast-root');
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : ''}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function money(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('de-CH', { style: 'currency', currency: 'CHF' }).format(amount);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function optionList(items, selected, labelFn) {
  return ['<option value="">Bitte wählen</option>']
    .concat(items.map((item) => {
      const label = labelFn(item);
      const isSelected = String(item.id) === String(selected || '');
      return `<option value="${item.id}" ${isSelected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }))
    .join('');
}

function accountLabel(account) {
  return [account.number, account.name].filter(Boolean).join(' ');
}

function taxLabel(tax) {
  return [tax.name, tax.percentage != null ? `${tax.percentage}%` : ''].filter(Boolean).join(' ');
}

const statusLabels = {
  pending: 'Manuell prüfen',
  approved: 'Okay',
  corrected: 'Korrigiert',
  uploaded: 'Hochgeladen',
  analyzed: 'Analysiert',
  preview: 'Vorschau',
  booked: 'Verbucht',
  error: 'Fehler',
  high: 'Hoch',
  medium: 'Mittel',
  low: 'Niedrig',
};

function badge(kind, text) {
  const label = statusLabels[text] || text;
  return `<span class="badge badge-${kind}">${escapeHtml(label)}</span>`;
}

function setStatus(ok, text) {
  const pill = document.getElementById('sidebar-status');
  const label = document.getElementById('sidebar-status-text');
  pill.classList.toggle('ok', ok === true);
  pill.classList.toggle('bad', ok === false);
  label.textContent = text;
}

async function refreshMeta() {
  try {
    state.settings = await api('/api/settings');
    if (state.settings.configured) {
      setStatus(true, `${state.settings.subdomain}.cashctrl.com`);
      document.getElementById('topbar-meta').innerHTML = badge('approved', 'API verbunden');
      state.lookups = await api('/api/settings/lookups');
    } else {
      setStatus(false, 'API nicht konfiguriert');
      document.getElementById('topbar-meta').innerHTML = badge('pending', 'Einrichtung offen');
    }
  } catch (error) {
    setStatus(false, 'Keine Verbindung');
    document.getElementById('topbar-meta').innerHTML = badge('error', 'Offline');
  }
}

function routeName() {
  const hash = location.hash.replace('#/', '') || 'dashboard';
  return titles[hash] ? hash : 'dashboard';
}

function setActiveNav(name) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.route === name);
  });
  const [eyebrow, title] = titles[name];
  document.getElementById('page-eyebrow').textContent = eyebrow;
  document.getElementById('page-title').textContent = title;
}

async function render() {
  const name = routeName();
  setActiveNav(name);
  const view = document.getElementById('view');
  view.innerHTML = '<div class="card p-8 text-slate-500">Ansicht wird geladen…</div>';
  try {
    if (name === 'dashboard') view.innerHTML = await renderDashboard();
    if (name === 'review') view.innerHTML = await renderReview();
    if (name === 'upload') view.innerHTML = await renderUpload();
    if (name === 'settings') view.innerHTML = await renderSettings();
    bindView(name);
  } catch (error) {
    view.innerHTML = `<div class="card p-8 text-rose-700">${escapeHtml(error.message)}</div>`;
  }
}

async function renderDashboard() {
  const data = await api('/api/dashboard');
  const stats = [
    ['Offene Reviews', data.stats.pendingFindings],
    ['Geprüfte Auffälligkeiten', data.stats.resolvedFindings],
    ['Hochgeladene Belege', data.stats.uploadedReceipts],
    ['Verbuchte Belege', data.stats.bookedReceipts],
  ];

  return `
    <div class="stat-grid mb-6">
      ${stats.map(([label, value]) => `
        <article class="card stat">
          <div class="stat-label">${label}</div>
          <div class="stat-value">${value}</div>
        </article>
      `).join('')}
    </div>
    <div class="grid lg:grid-cols-2 gap-5">
      <article class="card p-6">
        <h2 class="text-lg font-semibold mb-2">CashCtrl-Status</h2>
        <p class="text-slate-500 mb-4">${data.remote.connected
          ? `Organisation <strong>${escapeHtml(data.remote.organization)}</strong> · ${data.remote.accountCount} Konten`
          : 'Noch keine funktionierende API-Verbindung. Unter Einstellungen kannst du Subdomain und API-Key hinterlegen.'}</p>
        <div class="flex gap-3">
          <a class="btn btn-primary" href="#/settings">Zu den Einstellungen</a>
          <a class="btn btn-ghost" href="#/review">Review starten</a>
        </div>
      </article>
      <article class="card p-6">
        <h2 class="text-lg font-semibold mb-4">Letzte Aktivität</h2>
        <div class="space-y-3">
          ${[...data.recentFindings.map((item) => `${badge(item.severity, item.severity)} ${escapeHtml(item.title)}`),
             ...data.recentReceipts.map((item) => `${badge(item.status, item.status)} ${escapeHtml(item.name)}`)].slice(0, 6)
            .map((line) => `<div class="text-sm">${line}</div>`).join('') || '<p class="text-slate-500">Noch keine lokalen Vorgänge.</p>'}
        </div>
      </article>
    </div>
  `;
}

async function renderReview() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const end = today.toISOString().slice(0, 10);
  return `
    <article class="card p-6 mb-5">
      <form id="review-form" class="grid md:grid-cols-[1fr_1fr_auto] gap-4 items-end">
        <div class="field">
          <label for="startDate">Startdatum</label>
          <input id="startDate" name="startDate" type="date" value="${start}" required>
        </div>
        <div class="field">
          <label for="endDate">Enddatum</label>
          <input id="endDate" name="endDate" type="date" value="${end}" required>
        </div>
        <button class="btn btn-primary" type="submit">Journal prüfen</button>
      </form>
    </article>
    <article class="card overflow-hidden">
      <div class="px-6 py-4 border-b border-slate-100 flex justify-between">
        <div>
          <h2 class="font-semibold">Review-Tabelle</h2>
          <p class="text-sm text-slate-500" id="review-summary">Zeitraum wählen und prüfen.</p>
        </div>
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th>Status</th>
              <th>Datum</th>
              <th>Buchung</th>
              <th>Betrag</th>
              <th>Soll / Haben</th>
              <th>Auffälligkeit</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="review-body">
            <tr><td colspan="7" class="text-slate-500">Noch keine Prüfung ausgeführt.</td></tr>
          </tbody>
        </table>
      </div>
    </article>
  `;
}

function reviewRows(findings) {
  if (!findings.length) {
    return '<tr><td colspan="7" class="text-slate-500">Keine Auffälligkeiten im gewählten Zeitraum.</td></tr>';
  }
  return findings.map((finding) => {
    const entry = finding.entry || {};
    const statusLabel = {
      pending: 'Manuell prüfen',
      approved: 'Okay',
      corrected: 'Korrigiert',
    }[finding.status] || finding.status;
    return `
      <tr data-id="${finding.id}">
        <td>${badge(finding.status, statusLabel)}</td>
        <td class="font-mono text-xs">${escapeHtml(entry.date || '–')}</td>
        <td>
          <div class="font-medium">${escapeHtml(entry.title || 'Ohne Text')}</div>
          <div class="text-xs text-slate-500">${escapeHtml(entry.reference || '')}</div>
        </td>
        <td class="font-mono">${money(entry.amount)}</td>
        <td class="text-xs leading-5">
          <div>Soll: ${escapeHtml(entry.debitName || '–')}</div>
          <div>Haben: ${escapeHtml(entry.creditName || '–')}</div>
          <div>MWST: ${escapeHtml(entry.taxName || '–')}</div>
        </td>
        <td>
          <div class="mb-1">${badge(finding.severity, finding.title)}</div>
          <div class="text-slate-600">${escapeHtml(finding.message)}</div>
        </td>
        <td>
          ${finding.status === 'pending'
            ? `<button class="btn btn-ghost" data-resolve="${finding.id}">Manuelles Okay / Korrigieren</button>`
            : badge('approved', 'Erledigt')}
        </td>
      </tr>
    `;
  }).join('');
}

async function renderUpload() {
  const { receipts } = await api('/api/receipts');
  return `
    <article class="card p-6 mb-5">
      <form id="upload-form">
        <div id="dropzone" class="dropzone">
          <p class="text-lg font-semibold">Belege hierher ziehen</p>
          <p class="text-slate-500 mt-1">PDF, JPG, PNG oder WEBP · mehrere Dateien möglich</p>
          <input id="file-input" name="files" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff" class="mt-4">
        </div>
        <div class="grid md:grid-cols-2 gap-4 mt-5">
          <label class="card p-4 cursor-pointer border-brand-500">
            <input type="radio" name="logic" value="new" checked>
            <div class="font-semibold">Neue Logik</div>
            <p class="text-sm text-slate-500 mt-1">Automatischer Buchungsvorschlag auf Basis der Belegdaten.</p>
          </label>
          <label class="card p-4 cursor-pointer">
            <input type="radio" name="logic" value="historic">
            <div class="font-semibold">Bisherige Logik</div>
            <p class="text-sm text-slate-500 mt-1">Abgleich mit ähnlichen, bereits verarbeiteten Belegen.</p>
          </label>
        </div>
        <div class="mt-5">
          <button class="btn btn-primary" type="submit">Belege analysieren</button>
        </div>
      </form>
    </article>
    <div id="receipt-list" class="space-y-4">${receipts.map(receiptCard).join('') || '<p class="text-slate-500">Noch keine Belege vorhanden.</p>'}</div>
  `;
}

function receiptCard(receipt) {
  const extracted = receipt.extracted || {};
  const suggestion = receipt.suggestion || {};
  const accounts = state.lookups.accounts || [];
  const taxes = state.lookups.taxes || [];
  return `
    <article class="card p-6" data-receipt="${receipt.id}">
      <div class="flex flex-wrap justify-between gap-3 mb-4">
        <div>
          <h3 class="font-semibold">${escapeHtml(receipt.originalName)}</h3>
          <p class="text-sm text-slate-500">${escapeHtml(extracted.vendor || 'Lieferant wird ermittelt')} · ${badge(receipt.status, receipt.status)}</p>
        </div>
        <div class="text-right font-mono">${money(extracted.amount || suggestion.amount)}</div>
      </div>
      <div class="grid md:grid-cols-4 gap-3 mb-4">
        <div class="field"><label>Datum</label><input data-field="dateAdded" value="${escapeHtml(suggestion.dateAdded || extracted.date || '')}"></div>
        <div class="field"><label>Text</label><input data-field="title" value="${escapeHtml(suggestion.title || '')}"></div>
        <div class="field"><label>Betrag</label><input data-field="amount" value="${escapeHtml(suggestion.amount || extracted.amount || '')}"></div>
        <div class="field"><label>Lieferant</label><input data-field="vendor" value="${escapeHtml(suggestion.vendor || extracted.vendor || '')}"></div>
        <div class="field"><label>Soll-Konto</label><select data-field="debitId">${optionList(accounts, suggestion.debitId, accountLabel)}</select></div>
        <div class="field"><label>Haben-Konto</label><select data-field="creditId">${optionList(accounts, suggestion.creditId, accountLabel)}</select></div>
        <div class="field"><label>MWST</label><select data-field="taxId">${optionList(taxes, suggestion.taxId, taxLabel)}</select></div>
        <div class="field"><label>Logik</label><select data-reanalyze="${receipt.id}">
          <option value="new" ${receipt.logic === 'new' ? 'selected' : ''}>Neue Logik</option>
          <option value="historic" ${receipt.logic === 'historic' ? 'selected' : ''}>Bisherige Logik</option>
        </select></div>
      </div>
      <p class="text-sm text-slate-500 mb-4">${escapeHtml(suggestion.rationale || 'Nach der Analyse erscheint hier die Buchungsvorschau.')}</p>
      ${receipt.status === 'booked'
        ? `<div>${badge('booked', 'In CashCtrl verbucht')}</div>`
        : `<button class="btn btn-primary" data-book="${receipt.id}">Manuelles Okay & Buchen</button>`}
    </article>
  `;
}

async function renderSettings() {
  const settings = state.settings || await api('/api/settings');
  const accounts = state.lookups.accounts || [];
  const sequences = state.lookups.sequenceNumbers || [];
  return `
    <article class="card p-6 max-w-3xl">
      <p class="text-slate-500 mb-6">Die Zugangsdaten bleiben lokal in der SQLite-Datenbank und werden verschlüsselt gespeichert. Authentifizierung erfolgt per HTTP Basic Auth: API-Key als Benutzername, leeres Passwort.</p>
      <form id="settings-form" class="space-y-4">
        <div class="field">
          <label for="subdomain">Subdomain / Organisations-Name</label>
          <input id="subdomain" name="subdomain" value="${escapeHtml(settings.subdomain)}" placeholder="meinefirma">
          <p class="text-xs text-slate-500">Basis-URL: https://[subdomain].cashctrl.com/api/v1</p>
        </div>
        <div class="field">
          <label for="apiKey">API-Key</label>
          <input id="apiKey" name="apiKey" type="password" value="${escapeHtml(settings.apiKeyMasked)}" placeholder="API-Key aus CashCtrl">
        </div>
        <div class="grid md:grid-cols-2 gap-4">
          <div class="field">
            <label>Standard-Bankkonto</label>
            <select name="defaultBankAccountId">${optionList(accounts, settings.defaultBankAccountId, accountLabel)}</select>
          </div>
          <div class="field">
            <label>Standard-Aufwandkonto</label>
            <select name="defaultExpenseAccountId">${optionList(accounts, settings.defaultExpenseAccountId, accountLabel)}</select>
          </div>
        </div>
        <div class="field">
          <label>Nummernkreis</label>
          <select name="defaultSequenceNumberId">${optionList(sequences, settings.defaultSequenceNumberId, (item) => item.name || item.description || `Kreis ${item.id}`)}</select>
        </div>
        <div class="flex gap-3 pt-2">
          <button class="btn btn-primary" type="submit">Speichern</button>
          <button class="btn btn-ghost" id="test-connection" type="button">Verbindung testen</button>
        </div>
        <p class="text-sm text-slate-500" id="settings-hint">${escapeHtml(settings.lastTestMessage || '')}</p>
      </form>
    </article>
  `;
}

function bindView(name) {
  if (name === 'review') {
    document.getElementById('review-form').addEventListener('submit', onReview);
    document.getElementById('review-body').addEventListener('click', onReviewClick);
  }
  if (name === 'upload') {
    const form = document.getElementById('upload-form');
    const dropzone = document.getElementById('dropzone');
    const input = document.getElementById('file-input');
    form.addEventListener('submit', onUpload);
    ['dragenter', 'dragover'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove('dragover');
      });
    });
    dropzone.addEventListener('drop', (event) => {
      input.files = event.dataTransfer.files;
    });
    document.getElementById('receipt-list').addEventListener('click', onReceiptClick);
    document.getElementById('receipt-list').addEventListener('change', onReceiptChange);
  }
  if (name === 'settings') {
    document.getElementById('settings-form').addEventListener('submit', onSaveSettings);
    document.getElementById('test-connection').addEventListener('click', onTestConnection);
  }
}

async function onReview(event) {
  event.preventDefault();
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const body = document.getElementById('review-body');
  body.innerHTML = '<tr><td colspan="7">Prüfung läuft…</td></tr>';
  try {
    const result = await api('/api/review/analyze', {
      method: 'POST',
      body: { startDate, endDate },
    });
    document.getElementById('review-summary').textContent =
      `${result.entryCount} Journal-Einträge, ${result.findingCount} Auffälligkeiten`;
    body.innerHTML = reviewRows(result.findings);
    toast('Review abgeschlossen');
  } catch (error) {
    body.innerHTML = `<tr><td colspan="7" class="text-rose-700">${escapeHtml(error.message)}</td></tr>`;
    toast(error.message, 'error');
  }
}

function onReviewClick(event) {
  const button = event.target.closest('[data-resolve]');
  if (!button) return;
  const id = button.dataset.resolve;
  const row = button.closest('tr');
  openResolveModal(id, row);
}

async function openResolveModal(id) {
  const { finding } = await api(`/api/review/findings/${id}`).catch(() => ({ finding: { correction: {} } }));
  const correction = finding.correction || {};
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <h2 class="text-xl font-semibold mb-2">Manuelles Okay / Korrigieren</h2>
        <p class="text-slate-500 mb-5">${escapeHtml(finding.message || 'Die Auffälligkeit bleibt ungeprüft, bis du sie freigibst. Bei einer Korrektur wird die Buchung an CashCtrl gesendet.')}</p>
        <form id="resolve-form" class="grid md:grid-cols-2 gap-4">
          <div class="field"><label>Datum</label><input name="dateAdded" type="date" value="${escapeHtml(correction.dateAdded || '')}"></div>
          <div class="field"><label>Betrag</label><input name="amount" value="${escapeHtml(correction.amount ?? '')}"></div>
          <div class="field md:col-span-2"><label>Text</label><input name="title" value="${escapeHtml(correction.title || '')}"></div>
          <div class="field"><label>Soll-Konto</label><select name="debitId">${optionList(state.lookups.accounts, correction.debitId, accountLabel)}</select></div>
          <div class="field"><label>Haben-Konto</label><select name="creditId">${optionList(state.lookups.accounts, correction.creditId, accountLabel)}</select></div>
          <div class="field md:col-span-2"><label>MWST</label><select name="taxId">${optionList(state.lookups.taxes, correction.taxId, taxLabel)}</select></div>
          <div class="md:col-span-2 flex gap-3 mt-2">
            <button class="btn btn-ghost" name="action" value="approve" type="submit">Nur als geprüft markieren</button>
            <button class="btn btn-primary" name="action" value="correct" type="submit">Korrektur an CashCtrl senden</button>
            <button class="btn" type="button" id="close-modal">Abbrechen</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('resolve-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const action = event.submitter?.value || 'approve';
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
      await api(`/api/review/findings/${id}/resolve`, {
        method: 'POST',
        body: { action, correction: payload },
      });
      root.innerHTML = '';
      toast(action === 'correct' ? 'Korrektur wurde gesendet' : 'Als geprüft markiert');
      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      const result = await api(`/api/review/findings?startDate=${startDate}&endDate=${endDate}`);
      document.getElementById('review-body').innerHTML = reviewRows(result.findings);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  document.getElementById('close-modal').addEventListener('click', () => {
    root.innerHTML = '';
  });
}

async function onUpload(event) {
  event.preventDefault();
  const input = document.getElementById('file-input');
  if (!input.files.length) {
    toast('Bitte mindestens eine Datei wählen', 'error');
    return;
  }
  const form = new FormData();
  [...input.files].forEach((file) => form.append('files', file));
  form.append('logic', document.querySelector('input[name="logic"]:checked').value);
  try {
    const result = await api('/api/receipts/upload', { method: 'POST', body: form });
    document.getElementById('receipt-list').innerHTML = result.receipts.map(receiptCard).join('');
    toast('Belege analysiert');
  } catch (error) {
    toast(error.message, 'error');
  }
}

function readSuggestion(card) {
  const suggestion = {};
  card.querySelectorAll('[data-field]').forEach((field) => {
    suggestion[field.dataset.field] = field.value;
  });
  return suggestion;
}

async function onReceiptClick(event) {
  const button = event.target.closest('[data-book]');
  if (!button) return;
  const card = button.closest('[data-receipt]');
  const suggestion = readSuggestion(card);
  try {
    await api(`/api/receipts/${card.dataset.receipt}/preview`, {
      method: 'POST',
      body: { suggestion },
    });
    const result = await api(`/api/receipts/${card.dataset.receipt}/book`, {
      method: 'POST',
      body: { suggestion },
    });
    card.outerHTML = receiptCard(result.receipt);
    toast('Beleg wurde in CashCtrl verbucht');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function onReceiptChange(event) {
  const select = event.target.closest('[data-reanalyze]');
  if (!select) return;
  try {
    const result = await api(`/api/receipts/${select.dataset.reanalyze}/analyze`, {
      method: 'POST',
      body: { logic: select.value },
    });
    select.closest('[data-receipt]').outerHTML = receiptCard(result.receipt);
    toast('Buchungsvorschlag aktualisiert');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function onSaveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  try {
    await api('/api/settings', { method: 'POST', body: payload });
    await refreshMeta();
    toast('Einstellungen gespeichert');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function onTestConnection(event) {
  event.preventDefault();
  const form = new FormData(document.getElementById('settings-form'));
  try {
    const result = await api('/api/settings/test', {
      method: 'POST',
      body: Object.fromEntries(form.entries()),
    });
    document.getElementById('settings-hint').textContent = result.message;
    await refreshMeta();
    toast(result.message);
  } catch (error) {
    document.getElementById('settings-hint').textContent = error.message;
    toast(error.message, 'error');
  }
}

window.addEventListener('hashchange', render);
await refreshMeta();
await render();
