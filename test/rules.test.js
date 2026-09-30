'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const rulesLib = require('../lib/rules');

describe('sanitizeRule', () => {
  // One rule with every known field set to a non-default value - the round-trip below
  // is the regression test for the exact bug this module exists to prevent: a new field
  // added to the UI/defaults but forgotten in the whitelist gets silently dropped on
  // save, and the setting quietly does nothing in the running app. Whenever a new
  // per-device field is added, add it here too (and it'll immediately fail loudly if the
  // whitelist in sanitizeRule wasn't updated to match).
  const fullRule = {
    id: 'r-existing',
    matchType: 'id',
    matchValue: 'dev-1',
    label: 'My Device',
    notReportingHours: 12,
    batteryThreshold: 20,
    excludeBattery: true,
    onlyCheckBattery: true,
    excludeAll: true,
    excludeFromUnavailable: true,
    unavailableDelaySeconds: 30,
    lowBatteryDelaySeconds: 45,
    includeLastSeenForReporting: true,
    pausedUntil: '2026-01-01',
    batteryTypeOverride: '4x AA',
    autoTestOnStale: true,
    autoTestTriggerOnHeal: true,
    includeBatteryForReporting: true,
    dismissedRecommendedHours: 6,
    recommendationSafetyFactor: 2.5,
    recommendationBasis: 'avg',
  };

  test('every known field survives the round-trip unchanged', () => {
    const sanitized = rulesLib.sanitizeRule(fullRule);
    for (const [key, value] of Object.entries(fullRule)) {
      assert.equal(sanitized[key], value, `field "${key}" did not survive sanitizeRule`);
    }
  });

  test('the output has no fields beyond the known whitelist', () => {
    const sanitized = rulesLib.sanitizeRule(fullRule);
    assert.deepEqual(Object.keys(sanitized).sort(), Object.keys(fullRule).sort());
  });

  test('a stray/legacy field not in the whitelist is dropped, not carried through', () => {
    const sanitized = rulesLib.sanitizeRule({ ...fullRule, notReportingDays: 5, someOldField: 'x' });
    assert.equal('notReportingDays' in sanitized, false);
    assert.equal('someOldField' in sanitized, false);
  });

  test('a rule with no id gets one generated', () => {
    const sanitized = rulesLib.sanitizeRule({ matchType: 'id', matchValue: 'dev-2' });
    assert.ok(sanitized.id);
  });

  test('an existing id is preserved, not regenerated', () => {
    const sanitized = rulesLib.sanitizeRule({ id: 'keep-me', matchType: 'id', matchValue: 'dev-2' });
    assert.equal(sanitized.id, 'keep-me');
  });

  test('boolean fields default to false, not null/undefined, when absent', () => {
    const sanitized = rulesLib.sanitizeRule({ matchType: 'id', matchValue: 'dev-2' });
    assert.equal(sanitized.excludeBattery, false);
    assert.equal(sanitized.onlyCheckBattery, false);
    assert.equal(sanitized.excludeAll, false);
    assert.equal(sanitized.excludeFromUnavailable, false);
    assert.equal(sanitized.autoTestOnStale, false);
    assert.equal(sanitized.autoTestTriggerOnHeal, false);
  });

  test('includeBatteryForReporting defaults to true, only false when explicitly opted out', () => {
    assert.equal(rulesLib.sanitizeRule({ matchType: 'id', matchValue: 'dev-2' }).includeBatteryForReporting, true);
    assert.equal(rulesLib.sanitizeRule({ matchType: 'id', matchValue: 'dev-2', includeBatteryForReporting: false }).includeBatteryForReporting, false);
    assert.equal(rulesLib.sanitizeRule({ matchType: 'id', matchValue: 'dev-2', includeBatteryForReporting: true }).includeBatteryForReporting, true);
  });

  test('nullable fields default to null, not undefined, when absent', () => {
    const sanitized = rulesLib.sanitizeRule({ matchType: 'id', matchValue: 'dev-2' });
    assert.equal(sanitized.notReportingHours, null);
    assert.equal(sanitized.batteryThreshold, null);
    assert.equal(sanitized.unavailableDelaySeconds, null);
    assert.equal(sanitized.lowBatteryDelaySeconds, null);
    assert.equal(sanitized.includeLastSeenForReporting, null);
    assert.equal(sanitized.pausedUntil, null);
    assert.equal(sanitized.batteryTypeOverride, null);
    assert.equal(sanitized.dismissedRecommendedHours, null);
    assert.equal(sanitized.recommendationSafetyFactor, null);
    assert.equal(sanitized.recommendationBasis, null);
  });
});

describe('safetyFactorOrNull', () => {
  test('null/undefined/empty string all mean "inherit the global default"', () => {
    assert.equal(rulesLib.safetyFactorOrNull(null), null);
    assert.equal(rulesLib.safetyFactorOrNull(undefined), null);
    assert.equal(rulesLib.safetyFactorOrNull(''), null);
  });

  test('clamps to [1.0, 5.0] and rounds to 2 decimals, same as the global setting', () => {
    assert.equal(rulesLib.safetyFactorOrNull(0.5), 1);
    assert.equal(rulesLib.safetyFactorOrNull(10), 5);
    assert.equal(rulesLib.safetyFactorOrNull(1.234), 1.23);
  });

  test('non-numeric garbage is treated as unset, not a thrown error', () => {
    assert.equal(rulesLib.safetyFactorOrNull('not a number'), null);
  });
});

describe('basisOrNull', () => {
  test("accepts exactly 'max'/'avg', anything else means inherit", () => {
    assert.equal(rulesLib.basisOrNull('max'), 'max');
    assert.equal(rulesLib.basisOrNull('avg'), 'avg');
    assert.equal(rulesLib.basisOrNull(null), null);
    assert.equal(rulesLib.basisOrNull(undefined), null);
    assert.equal(rulesLib.basisOrNull('bogus'), null);
  });
});

describe('generateId', () => {
  test('generates a non-empty, unique-looking id each time', () => {
    const a = rulesLib.generateId();
    const b = rulesLib.generateId();
    assert.ok(a.length > 0);
    assert.notEqual(a, b);
  });
});

describe('positiveNumberOrNull', () => {
  test('accepts a positive number', () => {
    assert.equal(rulesLib.positiveNumberOrNull(5), 5);
  });

  test('rejects zero, negative, NaN, and empty/missing values', () => {
    assert.equal(rulesLib.positiveNumberOrNull(0), null);
    assert.equal(rulesLib.positiveNumberOrNull(-1), null);
    assert.equal(rulesLib.positiveNumberOrNull('not a number'), null);
    assert.equal(rulesLib.positiveNumberOrNull(''), null);
    assert.equal(rulesLib.positiveNumberOrNull(undefined), null);
    assert.equal(rulesLib.positiveNumberOrNull(null), null);
  });
});

describe('nonNegativeNumberOrNull', () => {
  test('accepts zero, unlike positiveNumberOrNull', () => {
    assert.equal(rulesLib.nonNegativeNumberOrNull(0), 0);
  });

  test('rejects negative numbers', () => {
    assert.equal(rulesLib.nonNegativeNumberOrNull(-1), null);
  });
});

describe('boolOrNull', () => {
  test('preserves true/false as-is', () => {
    assert.equal(rulesLib.boolOrNull(true), true);
    assert.equal(rulesLib.boolOrNull(false), false);
  });

  test('null/undefined/empty string all mean "inherit the global default"', () => {
    assert.equal(rulesLib.boolOrNull(null), null);
    assert.equal(rulesLib.boolOrNull(undefined), null);
    assert.equal(rulesLib.boolOrNull(''), null);
  });
});

describe('percentOrNull', () => {
  test('clamps to the 0-100 range', () => {
    assert.equal(rulesLib.percentOrNull(150), 100);
    assert.equal(rulesLib.percentOrNull(-5), 0);
  });

  test('passes through an in-range value unchanged', () => {
    assert.equal(rulesLib.percentOrNull(42), 42);
  });
});

describe('isoDateOrNull', () => {
  test('accepts an ISO YYYY-MM-DD date as-is', () => {
    assert.equal(rulesLib.isoDateOrNull('2026-03-15'), '2026-03-15');
  });

  test('normalizes a dd-mm-yyyy date (Homey Flow date-picker format) to ISO', () => {
    assert.equal(rulesLib.isoDateOrNull('15-03-2026'), '2026-03-15');
  });

  test('rejects unparsable garbage instead of corrupting the pause logic', () => {
    assert.equal(rulesLib.isoDateOrNull('not a date'), null);
    assert.equal(rulesLib.isoDateOrNull(''), null);
  });
});

describe('trimmedOrNull', () => {
  test('trims surrounding whitespace', () => {
    assert.equal(rulesLib.trimmedOrNull('  4x AA  '), '4x AA');
  });

  test('collapses empty/whitespace-only to null', () => {
    assert.equal(rulesLib.trimmedOrNull(''), null);
    assert.equal(rulesLib.trimmedOrNull('   '), null);
    assert.equal(rulesLib.trimmedOrNull(null), null);
  });
});
