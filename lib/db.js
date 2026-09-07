'use strict';

const sheets = require('./sheets');

/**
 * DB adapter for ShieldTX site.
 *
 * Phase 1: in-memory stub. Submissions are logged to the function log and
 * held in a module-scope array that vanishes on the next cold start.
 *
 * Plugging in a real DB later: replace insertRequestAccess below. The API
 * handlers and the public-script clients don't import any internals of
 * this module — they only call the exports.
 */

// Stable token for log-drain alerting. Grep/alert on this exact string —
// it is emitted once per submission that failed to reach Airtable, and
// never for any other reason. Don't rename it without updating the drain.
const MIRROR_FAILED = 'AIRTABLE_MIRROR_FAILED';
const MIRROR_OK = 'AIRTABLE_MIRROR_OK';

const requestAccessSubmissions = [];

async function insertRequestAccess(submission) {
  const row = { ...submission, id: cryptoRandomId(), created_at: new Date().toISOString() };
  requestAccessSubmissions.push(row);

  const mirror = await appendToAirtable(
    {
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      trade_type: row.trade_type,
      platforms: row.platforms,
      volume: row.volume,
      protection: row.protection,
      api_interest: row.api_interest,
      use_type: row.use_type,
      ip_hash: row.ip_hash,
      user_agent: row.user_agent,
      created_at: row.created_at,
    },
    row.id,
  );

  console.log('[request-access] submission stored', {
    id: row.id,
    email_domain: emailDomain(row.email),
    mirror: mirror.ok ? 'ok' : `failed:${mirror.reason}`,
  });
  return { id: row.id, mirror };
}

// API waitlist — same phase-1 stub pattern: in-memory row plus a log line.
// Deliberately no Airtable mirror yet; wire one here when a table exists.
const apiWaitlistSubmissions = [];

async function insertApiWaitlist(submission) {
  const row = { ...submission, id: cryptoRandomId(), created_at: new Date().toISOString() };
  apiWaitlistSubmissions.push(row);

  console.log('[api-waitlist] signup stored', {
    id: row.id,
    email_domain: emailDomain(row.email),
  });
  return { id: row.id };
}

// API access requests — same phase-1 stub pattern: in-memory row plus a log
// line. Deliberately no Airtable mirror yet; wire one here when a table exists.
const apiAccessSubmissions = [];

async function insertApiAccess(submission) {
  const row = { ...submission, id: cryptoRandomId(), created_at: new Date().toISOString() };
  apiAccessSubmissions.push(row);

  // Mirror into Google Sheets ("API Access Requests" tab, created on demand)
  // — same contract as the invite-request Airtable mirror: never blocks the
  // response, failures are logged loudly under a stable alert token.
  const mirror = await sheets.appendRow('API Access Requests', [
    row.created_at,
    row.email,
    row.use_case,
    row.venue_coverage,
    Array.isArray(row.other_venues) ? row.other_venues.join(', ') : row.other_venues,
    row.setup,
    row.walkthrough,
    row.ip_hash,
    row.user_agent,
  ]);

  console.log('[api-access] request stored', {
    id: row.id,
    email_domain: emailDomain(row.email),
    use_case: row.use_case,
    venue_coverage: row.venue_coverage,
    setup: row.setup,
    walkthrough: row.walkthrough,
    mirror: mirror.ok ? 'ok' : `failed:${mirror.reason}`,
  });
  return { id: row.id, mirror };
}

// Mirror a submission into an Airtable base via the REST API.
// Token-based auth (Bearer PAT) instead of resource-level sharing, so it
// can't be blocked by Workspace admin policy the way the Apps Script route was.
//
// The mirror never blocks the form response — a broken Airtable must not cost
// us a lead. But it is also the only durable store we have (the array above
// dies on cold start), so every failure is reported loudly and carries the
// full submission, making the function log a recovery buffer of last resort.
//
// Returns { ok: true, recordId } or { ok: false, reason } — callers use this
// for logging only; nothing upstream changes its response based on it.
// tableOverride: optional table name — defaults to AIRTABLE_TABLE/'Invite Requests'.
// Used by the API-access mirror to land in its own "API Access Requests" table.
async function appendToAirtable(fields, submissionId, tableOverride) {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = tableOverride || process.env.AIRTABLE_TABLE || 'Invite Requests';

  if (!token || !baseId) {
    // Previously a silent return, which made an unconfigured production
    // deploy look identical to a healthy one. Now it reports — except on
    // preview/dev, where the vars are legitimately absent and alerting on
    // every fork PR would just train everyone to ignore the alert.
    const missing = [!token && 'AIRTABLE_TOKEN', !baseId && 'AIRTABLE_BASE_ID'].filter(Boolean);
    if (isProduction()) {
      reportMirrorFailure('config_missing', { missing_env: missing }, fields, submissionId);
    } else {
      console.warn('[airtable] mirror skipped — not configured', { missing_env: missing });
    }
    return { ok: false, reason: 'config_missing' };
  }

  // Airtable plain-text/single-line columns can't take arrays — join the
  // multi-select fields into comma-separated strings.
  const record = {
    ...fields,
    platforms: Array.isArray(fields.platforms) ? fields.platforms.join(', ') : fields.platforms,
    protection: Array.isArray(fields.protection) ? fields.protection.join(', ') : fields.protection,
  };

  let res;
  try {
    res = await postRecord({ token, baseId, table, record });
  } catch (err) {
    const detail = { message: String((err && err.message) || err).slice(0, 300) };
    const rescue = await appendFailureRecord({ token, baseId, fields, summary: `network_error: ${detail.message}` });
    reportMirrorFailure('network_error', { ...detail, ...rescue }, fields, submissionId);
    return { ok: false, reason: 'network_error' };
  }

  if (!res.ok) {
    // Airtable returns { error: { type, message } }. Surface both — the type
    // names the fix (UNKNOWN_FIELD_NAME = column mismatch, NOT_FOUND = wrong
    // base/table id, INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND = token scope).
    const airtableError = (res.body && res.body.parsed && res.body.parsed.error) || null;
    const detail = {
      status: res.status,
      airtable_error_type: (airtableError && airtableError.type) || null,
      airtable_error_message: (airtableError && airtableError.message) || null,
      table,
      raw_body: res.body.raw,
    };
    const rescue = await appendFailureRecord({
      token,
      baseId,
      fields,
      summary: `http_error ${res.status} ${detail.airtable_error_type || ''}: ${detail.airtable_error_message || res.body.raw}`,
    });
    reportMirrorFailure('http_error', { ...detail, ...rescue }, fields, submissionId);
    return { ok: false, reason: 'http_error', status: res.status };
  }

  const recordId =
    (res.body.parsed && res.body.parsed.records && res.body.parsed.records[0] && res.body.parsed.records[0].id) || null;

  // Logged on success too, so "no MIRROR_OK lines in 24h" is itself alertable
  // — that catches an outage that stops submissions from arriving at all,
  // which a failure-only alert can never see.
  console.log(`[airtable] ${MIRROR_OK}`, JSON.stringify({
    alert: MIRROR_OK,
    submission_id: submissionId,
    record_id: recordId,
    table,
  }));

  return { ok: true, recordId };
}

/**
 * Low-level Airtable create. Resolves { ok, status, body } for any HTTP
 * response; throws only on a transport failure, which callers treat as
 * network_error. Shared by the main mirror and the failure-table fallback so
 * there is exactly one place that knows the request shape.
 */
async function postRecord({ token, baseId, table, record }) {
  const res = await fetch(
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [{ fields: record }], typecast: true }),
    },
  );
  return { ok: res.ok, status: res.status, body: await readBodySafely(res) };
}

/**
 * Last-resort rescue for a submission the main mirror rejected.
 *
 * Writes the lead into a separate table using only three columns we control —
 * so it survives the failure that most often breaks the main table: someone
 * adds a field to the form and the matching Airtable column never gets
 * created, and Airtable then 422s the whole record. It also puts the alert
 * somewhere reachable without Vercel access, which is the point: a log line
 * nobody can read is not an alert.
 *
 * Deliberately does NOT recurse through appendToAirtable — one attempt, and
 * if that fails the log is all that's left. Never throws.
 *
 * Failure table schema (create it in the same base):
 *   email   — single line text
 *   payload — long text (JSON of the submission)
 *   error   — single line text
 */
async function appendFailureRecord({ token, baseId, fields, summary }) {
  const table = process.env.AIRTABLE_FAILURE_TABLE || 'Mirror Failures';
  try {
    const res = await postRecord({
      token,
      baseId,
      table,
      record: {
        email: fields.email,
        payload: JSON.stringify(recoverableFields(fields)),
        error: String(summary).slice(0, 500),
      },
    });
    if (res.ok) return { rescued_to: table, rescued: true };
    return {
      rescued: false,
      rescue_error: `${res.status} ${res.body.raw}`.slice(0, 300),
    };
  } catch (err) {
    return { rescued: false, rescue_error: String((err && err.message) || err).slice(0, 300) };
  }
}

/**
 * One line, one stable token, one JSON blob — the shape log drains can both
 * substring-match and parse. Carries the full submission so a lead lost to a
 * broken mirror can still be recovered from the log by hand.
 */
function reportMirrorFailure(reason, detail, fields, submissionId) {
  console.error(`[airtable] ${MIRROR_FAILED}`, JSON.stringify({
    alert: MIRROR_FAILED,
    reason,
    submission_id: submissionId,
    ...detail,
    lost_submission: recoverableFields(fields),
  }));
}

// The subset worth keeping when a write fails: everything needed to re-enter
// the lead by hand, and nothing else. ip_hash and user_agent are deliberately
// omitted — useless for recovery, and they don't belong in an alert or in a
// table someone will read.
function recoverableFields(fields) {
  return {
    first_name: fields.first_name,
    last_name: fields.last_name,
    email: fields.email,
    trade_type: fields.trade_type,
    platforms: fields.platforms,
    volume: fields.volume,
    protection: fields.protection,
    api_interest: fields.api_interest,
    use_type: fields.use_type,
    created_at: fields.created_at,
  };
}

// Airtable error bodies are small, but a proxy or WAF in front of a failure
// can return an HTML page — cap it so one bad response can't flood the log.
async function readBodySafely(res) {
  let raw = '';
  try {
    raw = (await res.text()).slice(0, 500);
  } catch (err) {
    return { raw: `<unreadable: ${String((err && err.message) || err).slice(0, 100)}>`, parsed: null };
  }
  try {
    return { raw, parsed: JSON.parse(raw) };
  } catch (err) {
    return { raw, parsed: null };
  }
}

function isProduction() {
  // VERCEL_ENV is "production" | "preview" | "development" on Vercel, and
  // undefined off it — treat anything non-production as non-alerting.
  return process.env.VERCEL_ENV === 'production';
}

function cryptoRandomId() {
  return require('crypto').randomBytes(16).toString('hex');
}

function emailDomain(email) {
  if (typeof email !== 'string') return null;
  const at = email.indexOf('@');
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

module.exports = {
  insertRequestAccess,
  insertApiWaitlist,
  insertApiAccess,
};
