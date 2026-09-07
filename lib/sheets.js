'use strict';

/**
 * Google Sheets adapter for ShieldTX site.
 *
 * Server-to-server auth via a GCP service account: signs an RS256 JWT with
 * the service account private key, exchanges it for an OAuth token, then
 * appends rows through the Sheets API v4. No third-party dependency —
 * everything below uses Node's built-in crypto and fetch.
 *
 * Contract mirrors lib/db.js's Airtable mirror:
 *  - A broken Sheets write must never block (or fail) the form response.
 *  - Every failure is logged loudly under a stable token
 *    (GOOGLE_SHEETS_APPEND_FAILED) carrying the full row, so the function
 *    log is a recovery buffer of last resort. Grep/alert on that token.
 *
 * Env vars required:
 *   GOOGLE_SERVICE_ACCOUNT_EMAIL  — the service account's email
 *   GOOGLE_PRIVATE_KEY            — its RSA private key (\n escapes handled)
 *   GOOGLE_SHEET_ID               — the spreadsheet ID from its URL
 *
 * The spreadsheet must be shared with the service account email as Editor.
 * Tabs are created on demand — you only need one blank spreadsheet.
 */

const MIRROR_FAILED = 'GOOGLE_SHEETS_APPEND_FAILED';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

const serviceEmail = () => process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const sheetId = () => process.env.GOOGLE_SHEET_ID;

function isProduction() {
  return process.env.VERCEL_ENV === 'production';
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let cachedToken = null; // { token, expiresAtMs }

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function privateKey() {
  const raw = process.env.GOOGLE_PRIVATE_KEY || '';
  // Keys pasted into env vars often carry literal "\n" instead of newlines.
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

function signJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: serviceEmail(),
      scope: SHEETS_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = require('crypto').createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(privateKey()));
  return `${header}.${claims}.${signature}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAtMs) return cachedToken.token;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signJwt(),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const err = new Error(`token exchange failed: HTTP ${res.status} ${body.error || ''}`.trim());
    err.status = res.status;
    throw err;
  }
  // Refresh 5 minutes before actual expiry.
  cachedToken = { token: body.access_token, expiresAtMs: Date.now() + (body.expires_in - 300) * 1000 };
  return cachedToken.token;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const knownTabs = new Set();

async function ensureTab(token, tabName) {
  if (knownTabs.has(tabName)) return;

  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId()}?fields=sheets.properties.title`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json().catch(() => ({}));
  if (!metaRes.ok) {
    const err = new Error(`spreadsheet metadata fetch failed: HTTP ${metaRes.status}`);
    err.status = metaRes.status;
    throw err;
  }
  const titles = ((meta.sheets || []).map((s) => s.properties && s.properties.title)).filter(Boolean);
  if (titles.includes(tabName)) {
    knownTabs.add(tabName);
    return;
  }

  const addRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId()}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] }),
  });
  if (!addRes.ok) {
    const errBody = await addRes.text().catch(() => '');
    const err = new Error(`addSheet failed: HTTP ${addRes.status} ${errBody.slice(0, 200)}`);
    err.status = addRes.status;
    throw err;
  }
  knownTabs.add(tabName);
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

/**
 * Append one row to a tab, creating the tab if needed.
 * Returns { ok: true } or { ok: false, reason } — never throws. Callers use
 * the result for logging only.
 */
async function appendRow(tabName, values) {
  const email = serviceEmail();
  const id = sheetId();
  const key = privateKey();

  if (!email || !id || !key) {
    const missing = [!email && 'GOOGLE_SERVICE_ACCOUNT_EMAIL', !id && 'GOOGLE_SHEET_ID', !key && 'GOOGLE_PRIVATE_KEY'].filter(Boolean);
    // Not configured in dev/preview is normal — don't spam alerts there.
    console.warn('[sheets] append skipped — not configured', { missing_env: missing });
    return { ok: false, reason: 'config_missing' };
  }

  try {
    const token = await getAccessToken();
    await ensureTab(token, tabName);

    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(tabName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [values] }),
      }
    );
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      reportFailure('http_error', { status: res.status, raw_body: errBody.slice(0, 300) }, tabName, values);
      return { ok: false, reason: `http_error:${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    reportFailure('network_error', { message: String((err && err.message) || err).slice(0, 300) }, tabName, values);
    return { ok: false, reason: 'network_error' };
  }
}

// One line, one stable token, one JSON blob — same shape as the Airtable
// mirror's failure log so log drains can watch both with one pattern.
function reportFailure(reason, detail, tabName, values) {
  console.error(`[sheets] ${MIRROR_FAILED}`, JSON.stringify({
    alert: MIRROR_FAILED,
    reason,
    sheet_id: sheetId(),
    tab: tabName,
    lost_row: values,
    ...detail,
  }));
}

module.exports = {
  appendRow,
};