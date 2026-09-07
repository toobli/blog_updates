'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const REQUEST_ACCESS_ENUMS = {
  tradeType: ['perps-only', 'mostly-perps', 'mix', 'mostly-spot'],
  volume: ['lt-50k', '50k-250k', '250k-1m', '1m-5m', '5m-plus'],
  platforms: ['hyperliquid', 'dydx', 'gmx', 'cex', 'other-dex'],
  protection: ['multi-wallet', 'timing', 'smaller', 'private-rpc', 'nothing'],
  apiInterest: ['no', 'maybe', 'absolutely'],
};

const API_ACCESS_ENUMS = {
  useCase: ['trading-system', 'product-frontend', 'fund-desk', 'exploring'],
  venueCoverage: ['hyperliquid-only', 'hyperliquid-plus', 'multi-venue', 'not-sure'],
  otherVenues: ['lighter', 'dydx', 'gmx', 'aster', 'drift', 'other'],
  setup: ['shieldtx-wallets', 'existing-custodian', 'multisig', 'white-label', 'not-sure'],
  walkthrough: ['no-submit', 'yes-call'],
};

function clampString(input, max) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function asArray(input) {
  if (Array.isArray(input)) return input;
  if (input == null || input === '') return [];
  return [input];
}

function pickEnum(value, allowed) {
  return allowed.includes(value) ? value : null;
}

function pickEnumArray(values, allowed) {
  return asArray(values)
    .map((v) => pickEnum(v, allowed))
    .filter(Boolean);
}

/**
 * Validates the Request Access payload. Returns { ok: true, data } or
 * { ok: false, error, field }. Every field is required — names, email, and
 * all four screener answers must be present and valid.
 */
function validateRequestAccess(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid payload.', field: null };
  }

  if (body.company_url) {
    // Honeypot — pretend success, log silently in the handler.
    return { ok: false, error: 'honeypot', field: 'company_url' };
  }

  const first_name = clampString(body.first_name, 60);
  if (!first_name) {
    return { ok: false, error: 'Enter your first name.', field: 'first_name' };
  }

  const last_name = clampString(body.last_name, 60);
  if (!last_name) {
    return { ok: false, error: 'Enter your last name.', field: 'last_name' };
  }

  const email = clampString(body.email, 254);
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email.', field: 'email' };
  }

  const trade_type = pickEnum(body['trade-type'] || body.trade_type, REQUEST_ACCESS_ENUMS.tradeType);
  if (!trade_type) {
    return { ok: false, error: 'Select what you primarily trade.', field: 'trade-type' };
  }

  const platforms = pickEnumArray(body.platforms, REQUEST_ACCESS_ENUMS.platforms);
  if (platforms.length === 0) {
    return { ok: false, error: 'Select at least one platform.', field: 'platforms' };
  }

  const volume = pickEnum(body.volume, REQUEST_ACCESS_ENUMS.volume);
  if (!volume) {
    return { ok: false, error: 'Select your monthly volume.', field: 'volume' };
  }

  const protection = pickEnumArray(body.protection, REQUEST_ACCESS_ENUMS.protection);
  if (protection.length === 0) {
    return { ok: false, error: 'Select at least one option.', field: 'protection' };
  }

  const api_interest = pickEnum(body.api_interest, REQUEST_ACCESS_ENUMS.apiInterest);
  if (!api_interest) {
    return { ok: false, error: 'Select an answer.', field: 'api_interest' };
  }

  const data = {
    first_name,
    last_name,
    email: email.toLowerCase(),
    trade_type,
    platforms,
    volume,
    protection,
    // API-interest dropdown → intended usage. "no"/"maybe" = Trading App.
    use_type: api_interest === 'absolutely' ? 'API' : 'Trading App',
  };

  return { ok: true, data };
}

/**
 * Validates the API waitlist payload — email only. Returns { ok: true, data }
 * or { ok: false, error, field }.
 */
function validateApiWaitlist(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid payload.', field: null };
  }

  const email = clampString(body.email, 254);
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email.', field: 'email' };
  }

  return { ok: true, data: { email: email.toLowerCase(), source: 'api-waitlist' } };
}

/**
 * Validates the API access request payload. Returns { ok: true, data } or
 * { ok: false, error, field }. `other_venues` is required only when
 * venue_coverage indicates multi-venue interest.
 */
function validateApiAccess(body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Invalid payload.', field: null };
  }

  const email = clampString(body.email, 254);
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: 'Enter a valid email.', field: 'email' };
  }

  const use_case = pickEnum(body.use_case, API_ACCESS_ENUMS.useCase);
  if (!use_case) {
    return { ok: false, error: 'Select how you would use ShieldTX.', field: 'use_case' };
  }

  const venue_coverage = pickEnum(body.venue_coverage, API_ACCESS_ENUMS.venueCoverage);
  if (!venue_coverage) {
    return { ok: false, error: 'Select the venue coverage you need.', field: 'venue_coverage' };
  }

  let other_venues = [];
  if (venue_coverage === 'hyperliquid-plus' || venue_coverage === 'multi-venue') {
    other_venues = pickEnumArray(body.other_venues, API_ACCESS_ENUMS.otherVenues);
    if (other_venues.length === 0) {
      return { ok: false, error: 'Select at least one other venue.', field: 'other_venues' };
    }
  }

  const setup = pickEnum(body.setup, API_ACCESS_ENUMS.setup);
  if (!setup) {
    return { ok: false, error: 'Select which setup describes your needs.', field: 'setup' };
  }

  // Optional — only shown when the setup suggests a tailored integration.
  const walkthrough = body.walkthrough == null ? null : pickEnum(body.walkthrough, API_ACCESS_ENUMS.walkthrough);
  if (body.walkthrough != null && !walkthrough) {
    return { ok: false, error: 'Invalid walkthrough answer.', field: 'walkthrough' };
  }

  return {
    ok: true,
    data: {
      email: email.toLowerCase(),
      use_case,
      venue_coverage,
      other_venues,
      setup,
      walkthrough,
    },
  };
}

module.exports = {
  validateRequestAccess,
  REQUEST_ACCESS_ENUMS,
  validateApiWaitlist,
  validateApiAccess,
  API_ACCESS_ENUMS,
};
