'use strict';

/**
 * Per-device rule shape + persistence sanitizing, split out of app.js (and kept free of
 * any Homey / HomeyAPI calls, same rationale as lib/scanner.js) so it can be unit tested
 * without the Homey runtime.
 *
 * sanitizeRule() is the exact whitelist app.js's saveConfig applies to every rule before
 * persisting it. This used to live inline in app.js as an object literal - the one spot
 * that silently dropped a brand new field (autoTestOnStale/autoTestTriggerOnHeal) when it
 * was added elsewhere (UI, defaults) without also being added here. A round-trip test
 * against DEFAULT_RULES's documented shape (see test/rules.test.js) now catches that
 * class of bug the moment a new field is introduced, instead of only once someone notices
 * the setting silently "doing nothing" in the running app.
 */

function generateId() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function positiveNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Unlike positiveNumberOrNull above, 0 is a valid, meaningful value here ("no delay,
// confirm instantly") rather than "unset".
function nonNegativeNumberOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Tri-state per-device override for a setting that also has a global default: null means
// "inherit the global config value", true/false explicitly overrides it.
function boolOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return !!value;
}

function percentOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(100, Math.max(0, n));
}

// Mirrors app.js's safetyFactorOrDefault clamp range [1.0, 5.0] - null means "inherit the
// global recommendationSafetyFactor"; an explicit override still can't go below 1.0 (would
// suggest a threshold shorter than an already-observed gap) or above 5.0 (typo territory).
function safetyFactorOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(5, Math.max(1, n)) * 100) / 100;
}

// null = inherit the global recommendationBasis; 'max'/'avg' explicitly overrides it.
function basisOrNull(value) {
  return (value === 'max' || value === 'avg') ? value : null;
}

// Settings UI's <input type="date"> always sends "YYYY-MM-DD" (HTML spec). Homey's own
// native Flow date-picker argument, however, presents/passes "dd-mm-yyyy" - accept both
// here (shared by saveConfig and the Flow actions), normalizing to YYYY-MM-DD so
// isRulePaused only ever has one format to parse. Anything else (including garbage from a
// direct API call, or an unresolved/malformed token on the text-based Flow variant) is
// treated as "no pause" rather than corrupting the scan loop with an unparsable date.
function isoDateOrNull(value) {
  if (value === '' || value === undefined || value === null) return null;
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const euMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  let iso = null;
  if (isoMatch) iso = value;
  else if (euMatch) iso = `${euMatch[3]}-${euMatch[2]}-${euMatch[1]}`;
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : iso;
}

// Free text, trimmed; empty/whitespace-only collapses to null (same "unset" semantics as
// every other nullable per-device field) rather than storing a blank string forever.
function trimmedOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

// The full whitelist of persistable per-device rule fields. Every field a rule can carry
// MUST be listed here - anything not listed is silently dropped on save. Keep this in
// sync with the shape documented in lib/defaults.js.
function sanitizeRule(rule) {
  return {
    id: rule.id || generateId(),
    matchType: rule.matchType,
    matchValue: rule.matchValue,
    label: rule.label || '',
    notReportingHours: positiveNumberOrNull(rule.notReportingHours),
    batteryThreshold: percentOrNull(rule.batteryThreshold),
    excludeBattery: !!rule.excludeBattery,
    onlyCheckBattery: !!rule.onlyCheckBattery,
    excludeAll: !!rule.excludeAll,
    excludeFromUnavailable: !!rule.excludeFromUnavailable,
    unavailableDelaySeconds: nonNegativeNumberOrNull(rule.unavailableDelaySeconds),
    lowBatteryDelaySeconds: nonNegativeNumberOrNull(rule.lowBatteryDelaySeconds),
    includeLastSeenForReporting: boolOrNull(rule.includeLastSeenForReporting),
    includeBatteryForReporting: rule.includeBatteryForReporting !== false,
    pausedUntil: isoDateOrNull(rule.pausedUntil),
    batteryTypeOverride: trimmedOrNull(rule.batteryTypeOverride),
    autoTestOnStale: !!rule.autoTestOnStale,
    autoTestTriggerOnHeal: !!rule.autoTestTriggerOnHeal,
    dismissedRecommendedHours: positiveNumberOrNull(rule.dismissedRecommendedHours),
    recommendationSafetyFactor: safetyFactorOrNull(rule.recommendationSafetyFactor),
    recommendationBasis: basisOrNull(rule.recommendationBasis),
  };
}

module.exports = {
  generateId,
  positiveNumberOrNull,
  nonNegativeNumberOrNull,
  boolOrNull,
  percentOrNull,
  isoDateOrNull,
  trimmedOrNull,
  safetyFactorOrNull,
  basisOrNull,
  sanitizeRule,
};
