'use strict';

const db = require('../lib/db');
const { validateApiAccess } = require('../lib/validate');
const rateLimit = require('../lib/rate-limit');
const { hashIp } = require('../lib/crypto');
const { readJsonBody, sendJson, methodNotAllowed } = require('./_shared');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const limit = rateLimit.check(req, 'api-access', { max: 5, windowMs: 10 * 60 * 1000 });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    return sendJson(res, 429, { ok: false, error: 'Too many requests. Try again in a few minutes.' });
  }

  const body = readJsonBody(req);
  const result = validateApiAccess(body);

  if (!result.ok) {
    return sendJson(res, 400, { ok: false, error: result.error, field: result.field });
  }

  try {
    const ip = rateLimit.getClientIp(req);
    await db.insertApiAccess({
      ...result.data,
      user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
      ip_hash: hashIp(ip),
    });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[api-access] db error', err);
    return sendJson(res, 500, { ok: false, error: 'Something went wrong. Please try again.' });
  }
};