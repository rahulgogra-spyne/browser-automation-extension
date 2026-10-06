// Using the CRM structure config (built by the backend's mapping agent) in
// the extension: which CRM and page type a URL belongs to, and whether a
// config-driven extraction worked or the rules need re-mapping.

import { isEmailKey, isPhoneKey } from './columns.js';

// What page-type patterns are matched against.
export const urlKey = (url) => {
  const u = new URL(url);
  return u.pathname + u.search + u.hash;
};

const hostMatches = (pattern, host) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(host);

export function findCrm(config, url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  for (const [id, crm] of Object.entries(config?.crms ?? {})) {
    if (crm.match?.hosts?.some((pattern) => hostMatches(pattern, host))) return { id, crm };
  }
  return null;
}

export function findPageType(crm, url) {
  const key = urlKey(url);
  for (const pageType of crm.pageTypes ?? []) {
    let match = null;
    try {
      match = new RegExp(pageType.urlRegex).exec(key);
    } catch {
      continue;
    }
    if (match) return { pageType, recordId: match[1] ?? '' };
  }
  return null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

// A config extraction is trusted when every tab was found, the page type's
// required fields came back, at least one expected contact field did, and
// emails/phones look like emails/phones. Anything else means the CRM's
// layout moved and the page should be re-mapped.
export function assessExtraction(pageType, result) {
  if (!result) return { ok: false, missing: [], invalid: [], errors: [{ view: 'page', error: 'record_frame_not_found' }] };
  const missing = (pageType.required ?? []).filter((key) => !result.fields[key]);
  const oneOf = pageType.expectOneOf ?? [];
  if (oneOf.length && !oneOf.some((key) => result.fields[key])) missing.push(oneOf.join(' or '));
  const invalid = Object.entries(result.fields)
    .filter(([key, value]) => (isEmailKey(key) && !EMAIL.test(value)) || (isPhoneKey(key) && value.replace(/\D/g, '').length < 7))
    .map(([key]) => key);
  const errors = result.errors ?? [];
  return { ok: !missing.length && !invalid.length && !errors.length, missing, invalid, errors };
}

export function describeProblems({ missing, invalid, errors }) {
  return [
    ...missing.map((key) => `no ${key}`),
    ...invalid.map((key) => `odd ${key}`),
    ...errors.map((e) => `${e.view}: ${e.error.replace(/_/g, ' ')}`),
  ].join(', ');
}
