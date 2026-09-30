'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../lib/scanner');

const HOUR = 3600 * 1000;

function device(overrides) {
  return {
    id: 'dev-1',
    name: 'Device 1',
    zone: null,
    class: 'sensor',
    available: true,
    capabilities: [],
    capabilitiesObj: {},
    ...overrides,
  };
}

describe('safeRegExp', () => {
  test('returns a working RegExp for a valid pattern', () => {
    const re = scanner.safeRegExp('^foo');
    assert.ok(re instanceof RegExp);
    assert.equal(re.test('foobar'), true);
  });

  test('returns null instead of throwing for an invalid pattern', () => {
    assert.equal(scanner.safeRegExp('('), null);
  });

  test('returns null for an empty/falsy pattern', () => {
    assert.equal(scanner.safeRegExp(''), null);
    assert.equal(scanner.safeRegExp(null), null);
  });
});

describe('formatDate', () => {
  test('returns null for null input', () => {
    assert.equal(scanner.formatDate(null), null);
  });

  test('returns null for an invalid Date', () => {
    assert.equal(scanner.formatDate(new Date('not a date')), null);
  });

  test('returns an ISO string for a valid Date', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    assert.equal(scanner.formatDate(d), '2026-01-01T00:00:00.000Z');
  });
});

describe('buildZoneOrderMap', () => {
  test('walks the zone tree in pre-order, siblings sorted by order then name', () => {
    const zones = {
      basement: {
        id: 'basement', name: 'Basement', parent: null, order: 1,
      },
      attic: {
        id: 'attic', name: 'Attic', parent: null, order: 0,
      },
      'attic-left': {
        id: 'attic-left', name: 'Left', parent: 'attic', order: 0,
      },
      'attic-right': {
        id: 'attic-right', name: 'Right', parent: 'attic', order: 1,
      },
    };

    const map = scanner.buildZoneOrderMap(zones);

    // Attic (order 0) before Basement (order 1), children visited before the next root sibling.
    assert.equal(map.attic, 0);
    assert.equal(map['attic-left'], 1);
    assert.equal(map['attic-right'], 2);
    assert.equal(map.basement, 3);
  });

  test('falls back to name when order is missing/equal', () => {
    const zones = {
      b: { id: 'b', name: 'Bravo', parent: null },
      a: { id: 'a', name: 'Alpha', parent: null },
    };
    const map = scanner.buildZoneOrderMap(zones);
    assert.ok(map.a < map.b);
  });

  test('handles an empty zone map', () => {
    assert.deepEqual(scanner.buildZoneOrderMap({}), {});
    assert.deepEqual(scanner.buildZoneOrderMap(undefined), {});
  });
});

describe('findRule', () => {
  const rules = [
    { id: 'r-id', matchType: 'id', matchValue: 'dev-1' },
    { id: 'r-name', matchType: 'name', matchValue: 'Garage sensor' },
    { id: 'r-pattern', matchType: 'pattern', matchValue: '^Garage' },
  ];

  test('exact ID match wins over name and pattern', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-1', name: 'Garage sensor' }), rules);
    assert.equal(rule.id, 'r-id');
    assert.equal(ruleApplied, 'ID');
  });

  test('exact name match wins over pattern when ID does not match', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-2', name: 'Garage sensor' }), rules);
    assert.equal(rule.id, 'r-name');
    assert.equal(ruleApplied, 'NM');
  });

  test('falls back to a matching pattern', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-3', name: 'Garage door' }), rules);
    assert.equal(rule.id, 'r-pattern');
    assert.equal(ruleApplied, 'PT');
  });

  test('returns no rule when nothing matches', () => {
    const { rule, ruleApplied } = scanner.findRule(device({ id: 'dev-9', name: 'Kitchen light' }), rules);
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });

  test('an invalid regex pattern rule is skipped, not thrown', () => {
    const badRules = [{ id: 'r-bad', matchType: 'pattern', matchValue: '(' }];
    const { rule, ruleApplied } = scanner.findRule(device({ name: 'Anything' }), badRules);
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });
});

describe('buildRuleIndex + findRuleIndexed', () => {
  // Same rules/fixtures as the findRule suite above, on purpose - findRuleIndexed is a
  // drop-in, faster replacement and must agree with findRule on every case, not just its
  // own cases.
  const rules = [
    { id: 'r-id', matchType: 'id', matchValue: 'dev-1' },
    { id: 'r-name', matchType: 'name', matchValue: 'Garage sensor' },
    { id: 'r-pattern', matchType: 'pattern', matchValue: '^Garage' },
  ];

  test('exact ID match wins over name and pattern', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-1', name: 'Garage sensor' }), scanner.buildRuleIndex(rules));
    assert.equal(rule.id, 'r-id');
    assert.equal(ruleApplied, 'ID');
  });

  test('exact name match wins over pattern when ID does not match', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-2', name: 'Garage sensor' }), scanner.buildRuleIndex(rules));
    assert.equal(rule.id, 'r-name');
    assert.equal(ruleApplied, 'NM');
  });

  test('falls back to a matching pattern', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-3', name: 'Garage door' }), scanner.buildRuleIndex(rules));
    assert.equal(rule.id, 'r-pattern');
    assert.equal(ruleApplied, 'PT');
  });

  test('returns no rule when nothing matches', () => {
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ id: 'dev-9', name: 'Kitchen light' }), scanner.buildRuleIndex(rules));
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });

  test('an invalid regex pattern rule is skipped, not thrown', () => {
    const badIndex = scanner.buildRuleIndex([{ id: 'r-bad', matchType: 'pattern', matchValue: '(' }]);
    const { rule, ruleApplied } = scanner.findRuleIndexed(device({ name: 'Anything' }), badIndex);
    assert.equal(rule, null);
    assert.equal(ruleApplied, '--');
  });

  test('first rule of a type wins, same as Array#find on the raw array', () => {
    const dupeRules = [
      { id: 'r-first', matchType: 'id', matchValue: 'dev-1' },
      { id: 'r-second', matchType: 'id', matchValue: 'dev-1' },
    ];
    const dupeIndex = scanner.buildRuleIndex(dupeRules);
    const viaIndex = scanner.findRuleIndexed(device({ id: 'dev-1' }), dupeIndex);
    const viaArray = scanner.findRule(device({ id: 'dev-1' }), dupeRules);
    assert.equal(viaIndex.rule.id, 'r-first');
    assert.equal(viaIndex.rule.id, viaArray.rule.id);
  });
});

describe('canCheckStaleness', () => {
  test('true for a device with any non-button, non-battery capability', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['onoff'] })), true);
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button', 'onoff'] })), true);
  });

  test('false for a button-only device (incl. multi-instance button.x)', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button'] })), false);
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button', 'button.2'] })), false);
  });

  test('false for a button+battery device (e.g. a Hue Tap Dial or other remote)', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button', 'measure_battery'] })), false);
    assert.equal(scanner.canCheckStaleness(device({ capabilities: ['button', 'alarm_battery'] })), false);
  });

  test('false for a device with no capabilities at all', () => {
    assert.equal(scanner.canCheckStaleness(device({ capabilities: [], capabilitiesObj: {} })), false);
  });

  test('falls back to capabilitiesObj keys when capabilities is not populated', () => {
    assert.equal(scanner.canCheckStaleness({ capabilitiesObj: { onoff: { value: true } } }), true);
    assert.equal(scanner.canCheckStaleness({ capabilitiesObj: { button: { value: null } } }), false);
  });

  test('false for a device whose only capability is a custom write-only (getable: false) one', () => {
    // e.g. the WhatsApp app's `send_data` capability: setable-only, never carries a value or
    // lastUpdated, so it can't be hardcoded into NON_INFORMATIVE_STALENESS_CAP_BASES by name -
    // the getable flag itself is the generic signal.
    const d = device({
      capabilities: ['send_data'],
      capabilitiesObj: { send_data: { value: null, getable: false, setable: true } },
    });
    assert.equal(scanner.canCheckStaleness(d), false);
  });

  test('true for a device with a getable capability even if some other capability is write-only', () => {
    const d = device({
      capabilities: ['send_data', 'onoff'],
      capabilitiesObj: {
        send_data: { value: null, getable: false, setable: true },
        onoff: { value: true, getable: true },
      },
    });
    assert.equal(scanner.canCheckStaleness(d), true);
  });
});

describe('deviceRecommendation', () => {
  const DAY = 24 * HOUR;

  test('returns null when the device is not flagged', () => {
    assert.equal(scanner.deviceRecommendation(device({}), { category: null }), null);
    assert.equal(scanner.deviceRecommendation(device({}), {}), null);
  });

  test('unavailable: several peers from the same app -> app-restart hint', () => {
    const r = scanner.deviceRecommendation(device({ capabilities: ['onoff'] }), {
      category: 'unavailable', unavailablePeersSameApp: 3,
    });
    assert.equal(r.key, 'unavailableAppRestart');
  });

  test('unavailable: battery device -> battery hint', () => {
    const r = scanner.deviceRecommendation(device({ capabilities: ['onoff', 'measure_battery'] }), {
      category: 'unavailable', unavailablePeersSameApp: 0,
    });
    assert.equal(r.key, 'unavailableBattery');
  });

  test('unavailable: otherwise -> generic check hint', () => {
    const r = scanner.deviceRecommendation(device({ capabilities: ['onoff'] }), { category: 'unavailable' });
    assert.equal(r.key, 'unavailableCheck');
  });

  test('lowBattery: a battery reading older than 30 days -> staleBattery', () => {
    const d = device({
      capabilities: ['measure_battery'],
      capabilitiesObj: { measure_battery: { value: 5, lastUpdated: new Date(Date.now() - 40 * DAY).toISOString() } },
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'lowBattery' }).key, 'staleBattery');
  });

  test('lowBattery: a fresh reading -> batteryReplace', () => {
    const d = device({
      capabilities: ['measure_battery'],
      capabilitiesObj: { measure_battery: { value: 5, lastUpdated: new Date().toISOString() } },
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'lowBattery' }).key, 'batteryReplace');
  });

  test('lowBattery: an active alarm_battery -> batteryAlarm', () => {
    const d = device({ capabilities: ['alarm_battery'], capabilitiesObj: { alarm_battery: { value: true } } });
    assert.equal(scanner.deviceRecommendation(d, { category: 'lowBattery' }).key, 'batteryAlarm');
  });

  test('notReporting: a device that has never reported any value -> neverReported', () => {
    const d = device({
      capabilities: ['alarm_contact'],
      capabilitiesObj: { alarm_contact: { value: null } },
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting' }).key, 'neverReported');
  });

  test('notReporting: an event sensor still being seen -> eventSensor', () => {
    const d = device({
      class: 'sensor',
      capabilities: ['alarm_motion'],
      capabilitiesObj: { alarm_motion: { value: false, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - HOUR).toISOString(),
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting', thresholdHrs: 24 }).key, 'eventSensor');
  });

  test('notReporting: a class:sensor meter WITHOUT an alarm cap is not treated as an event sensor', () => {
    // A power/air-quality meter reports continuously - a long gap is a real concern, so it
    // must NOT get the "quiet is normal, raise the threshold" hint.
    const d = device({
      class: 'sensor',
      capabilities: ['measure_power'],
      capabilitiesObj: { measure_power: { value: 12, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - HOUR).toISOString(),
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting', thresholdHrs: 24 }).key, 'notReportingGeneric');
  });

  test('notReporting: a testable device Homey still sees -> tryTest', () => {
    const d = device({
      class: 'light',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 40 * HOUR).toISOString(),
      available: true,
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting', thresholdHrs: 24, testCapability: 'onoff' }).key, 'tryTest');
  });

  test('notReporting: a device that is both testable and event-driven -> tryTest wins', () => {
    const d = device({
      class: 'light',
      capabilities: ['onoff', 'alarm_generic'],
      capabilitiesObj: {
        onoff: { value: true, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() },
        alarm_generic: { value: false, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() },
      },
      lastSeenAt: new Date(Date.now() - HOUR).toISOString(),
      available: true,
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting', thresholdHrs: 24, testCapability: 'onoff' }).key, 'tryTest');
  });

  test('notReporting: not testable, last seen also stale -> silentlyGone', () => {
    const d = device({
      class: 'light',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 40 * HOUR).toISOString(),
      available: true,
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting', thresholdHrs: 24 }).key, 'silentlyGone');
  });

  test('notReporting: nothing specific matches -> notReportingGeneric', () => {
    const d = device({
      class: 'light',
      capabilities: ['onoff'],
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 40 * HOUR).toISOString() } },
    });
    assert.equal(scanner.deviceRecommendation(d, { category: 'notReporting', thresholdHrs: 24 }).key, 'notReportingGeneric');
  });
});

describe('computeDeviceStatus', () => {
  const config = { notReportingThresholdHours: 24, batteryThresholdPercent: 30 };

  test('reporting is true when the device updated recently', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('reporting is false once the device is older than the threshold', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('a per-device notReportingHours override replaces the global threshold', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 2 * HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, { notReportingHours: 1 }, config);
    assert.equal(status.isReporting, false);
  });

  test('onlyCheckBattery skips the reporting check entirely', () => {
    const d = device({ capabilitiesObj: {} }); // no lastUpdated at all
    const status = scanner.computeDeviceStatus(d, { onlyCheckBattery: true }, config);
    assert.equal(status.isReporting, true);
  });

  test('a device with a real capability but no data yet is treated as not reporting', () => {
    // Genuine "dead sensor" case: it has a capability that would carry a timestamp, it
    // just never has - still flagged, exactly as before.
    const d = device({ capabilities: ['measure_temperature'], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('a device whose only capability is button is never flagged not reporting', () => {
    // Virtual "button" / scene-trigger device (e.g. com.arjankranenburg.virtual): the
    // button capability never carries a lastUpdated, so the staleness check is skipped
    // entirely rather than flagging it forever.
    const d = device({ class: 'button', capabilities: ['button'], capabilitiesObj: { button: { value: null } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('a button+battery remote is never flagged not reporting, even with a stale battery reading', () => {
    // A physical remote/button (Hue Tap Dial, Aqara, IKEA, ...) only wakes up to report on a
    // button press, and measure_battery/alarm_battery piggyback on that same rare cadence - a
    // months-old battery reading doesn't mean the device went silent, just that it wasn't
    // pressed (confirmed on the community thread for a Hue Tap Dial: lastUpdated from months
    // ago, lastSeenAt from today). The battery level itself is still checked separately below.
    const d = device({
      class: 'button',
      capabilities: ['button', 'measure_battery'],
      capabilitiesObj: { measure_battery: { value: 80, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('a fresh battery reading counts as a sign of life by default', () => {
    // Battery updates on its own cadence, independent of the primary sensor - by default
    // that still counts as evidence the device's radio/mesh link is alive.
    const d = device({
      capabilities: ['measure_temperature', 'measure_battery'],
      capabilitiesObj: {
        measure_temperature: { value: 21, lastUpdated: new Date(Date.now() - 21 * 24 * HOUR).toISOString() },
        measure_battery: { value: 80, lastUpdated: new Date(Date.now() - 2 * HOUR).toISOString() },
      },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('includeBatteryForReporting: false opts a device out, surfacing a frozen primary sensor value', () => {
    // The exact case a competing app's pitch calls out: temperature frozen for weeks,
    // battery still reporting every couple of hours because it's on its own cadence - a
    // device whose battery genuinely isn't reliable evidence of life can opt out.
    const d = device({
      capabilities: ['measure_temperature', 'measure_battery'],
      capabilitiesObj: {
        measure_temperature: { value: 21, lastUpdated: new Date(Date.now() - 21 * 24 * HOUR).toISOString() },
        measure_battery: { value: 80, lastUpdated: new Date(Date.now() - 2 * HOUR).toISOString() },
      },
    });
    const status = scanner.computeDeviceStatus(d, { includeBatteryForReporting: false }, config);
    assert.equal(status.isReporting, false);
  });

  test('batteryLastUpdated is exposed regardless of includeBatteryForReporting', () => {
    const ts = new Date(Date.now() - 2 * HOUR).toISOString();
    const d = device({
      capabilities: ['measure_temperature', 'measure_battery'],
      capabilitiesObj: {
        measure_temperature: { value: 21, lastUpdated: new Date().toISOString() },
        measure_battery: { value: 80, lastUpdated: ts },
      },
    });
    assert.equal(scanner.computeDeviceStatus(d, null, config).batteryLastUpdated, ts);
    assert.equal(scanner.computeDeviceStatus(d, { includeBatteryForReporting: false }, config).batteryLastUpdated, ts);
  });

  test('a device with no capabilities at all is not flagged not reporting', () => {
    const d = device({ capabilities: [], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('a device whose only capability is a custom write-only one is never flagged not reporting', () => {
    // Community-reported: a WhatsApp-app device whose only capability is a custom `send_data`
    // boolean (setable, not getable) was permanently flagged "not reporting" since it never
    // carries a lastUpdated - same failure shape as the button-only case, for a capability name
    // that can't be hardcoded up front.
    const d = device({
      class: 'other',
      capabilities: ['send_data'],
      capabilitiesObj: { send_data: { value: null, getable: false, setable: true } },
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, true);
  });

  test('a stale capability with a fresh lastSeenAt is still not reporting by default', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isReporting, false);
  });

  test('includeLastSeenForReporting treats a fresh lastSeenAt as a sign of life', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, null, { ...config, includeLastSeenForReporting: true });
    assert.equal(status.isReporting, true);
  });

  test('includeLastSeenForReporting does not help if lastSeenAt is also stale', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 26 * HOUR).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, null, { ...config, includeLastSeenForReporting: true });
    assert.equal(status.isReporting, false);
  });

  test('a per-device includeLastSeenForReporting override of true wins over a global false', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(d, { includeLastSeenForReporting: true }, config);
    assert.equal(status.isReporting, true);
  });

  test('a per-device includeLastSeenForReporting override of false wins over a global true', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(
      d, { includeLastSeenForReporting: false }, { ...config, includeLastSeenForReporting: true },
    );
    assert.equal(status.isReporting, false);
  });

  test('a per-device includeLastSeenForReporting of null inherits the global setting', () => {
    const d = device({
      capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 25 * HOUR).toISOString() } },
      lastSeenAt: new Date(Date.now() - 60000).toISOString(),
    });
    const status = scanner.computeDeviceStatus(
      d, { includeLastSeenForReporting: null }, { ...config, includeLastSeenForReporting: true },
    );
    assert.equal(status.isReporting, true);
  });

  test('battery percentage at/below the threshold is flagged low', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 30 } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isLowBattery, true);
    assert.equal(status.batteryStatus, '30%');
  });

  test('battery percentage above the threshold is not flagged', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 31 } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isLowBattery, false);
  });

  test('a per-device batteryThreshold of 0 is honoured, not treated as "unset"', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 5 } } });
    const status = scanner.computeDeviceStatus(d, { batteryThreshold: 0 }, config);
    assert.equal(status.isLowBattery, false);
  });

  test('a battery alarm is always flagged low, regardless of percentage', () => {
    const d = device({ capabilitiesObj: { alarm_battery: { value: true } } });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.isLowBattery, true);
    assert.equal(status.batteryStatus, 'ALARM');
  });

  test('excludeBattery reports EXCL and never flags low battery', () => {
    const d = device({ capabilitiesObj: { measure_battery: { value: 1 } } });
    const status = scanner.computeDeviceStatus(d, { excludeBattery: true }, config);
    assert.equal(status.batteryStatus, 'EXCL');
    assert.equal(status.isLowBattery, false);
  });

  test('a device without a battery capability at all reports N/A', () => {
    const d = device({ capabilities: [], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.batteryStatus, 'N/A');
  });

  test('a device with the capability but no value yet reports OK', () => {
    const d = device({ capabilities: ['measure_battery'], capabilitiesObj: {} });
    const status = scanner.computeDeviceStatus(d, null, config);
    assert.equal(status.batteryStatus, 'OK');
  });
});

describe('computeUpdateStats', () => {
  function entry(ts, capId) {
    return { ts, capId: capId || 'measure_power' };
  }

  test('fewer than 5 samples: reports the count and raw entries, no averages/recommendation', () => {
    const entries = [entry(1000), entry(2000), entry(3000)];
    const result = scanner.computeUpdateStats(entries);
    assert.equal(result.count, 3);
    assert.deepEqual(result.entries, entries);
    assert.equal(result.avgIntervalMs, null);
    assert.equal(result.maxIntervalMs, null);
    assert.equal(result.recommendedHours, null);
  });

  test('no entries at all behaves the same as too few', () => {
    const result = scanner.computeUpdateStats([]);
    assert.equal(result.count, 0);
    assert.equal(result.recommendedHours, null);
  });

  test('a non-array input is treated as empty, not thrown', () => {
    const result = scanner.computeUpdateStats(undefined);
    assert.equal(result.count, 0);
  });

  test('5+ evenly-spaced samples: avg/max interval match the spacing exactly', () => {
    const start = 1_700_000_000_000;
    const entries = [0, 1, 2, 3, 4, 5].map((i) => entry(start + i * HOUR));
    const result = scanner.computeUpdateStats(entries);
    assert.equal(result.count, 6);
    assert.deepEqual(result.entries, entries);
    assert.equal(result.avgIntervalMs, HOUR);
    assert.equal(result.maxIntervalMs, HOUR);
  });

  test('recommendedHours is 1.5x the WORST gap, not the average - an occasional slow spell should not be masked', () => {
    // Mostly reports every 10 min, one 3h gap in the middle.
    const start = 1_700_000_000_000;
    const entries = [
      entry(start),
      entry(start + 10 * 60 * 1000),
      entry(start + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 30 * 60 * 1000),
    ];
    const result = scanner.computeUpdateStats(entries);
    assert.equal(result.maxIntervalMs, 3 * HOUR);
    // ceil(3h * 1.5) = 5h.
    assert.equal(result.recommendedHours, 5);
  });

  test('a custom safetyFactor overrides the 1.5x default', () => {
    const start = 1_700_000_000_000;
    const entries = [
      entry(start),
      entry(start + 10 * 60 * 1000),
      entry(start + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 30 * 60 * 1000),
    ];
    // ceil(3h * 1.2) = 4h, not the default 5h.
    assert.equal(scanner.computeUpdateStats(entries, null, 1.2).recommendedHours, 4);
    // ceil(3h * 2) = 6h.
    assert.equal(scanner.computeUpdateStats(entries, null, 2).recommendedHours, 6);
  });

  test('an invalid/missing safetyFactor falls back to the 1.5x default, not a thrown error', () => {
    const start = 1_700_000_000_000;
    const entries = [
      entry(start),
      entry(start + 10 * 60 * 1000),
      entry(start + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 30 * 60 * 1000),
    ];
    assert.equal(scanner.computeUpdateStats(entries, null, undefined).recommendedHours, 5);
    assert.equal(scanner.computeUpdateStats(entries, null, 0).recommendedHours, 5);
    assert.equal(scanner.computeUpdateStats(entries, null, -1).recommendedHours, 5);
    assert.equal(scanner.computeUpdateStats(entries, null, NaN).recommendedHours, 5);
  });

  test("basis 'avg' derives recommendedHours from avgIntervalMs instead of maxIntervalMs", () => {
    const start = 1_700_000_000_000;
    // Same mostly-10min/one-3h-gap entries as above: avgIntervalMs = 52.5min = 0.875h.
    const entries = [
      entry(start),
      entry(start + 10 * 60 * 1000),
      entry(start + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 30 * 60 * 1000),
    ];
    const result = scanner.computeUpdateStats(entries, null, 1.5, 'avg');
    // ceil(0.875h * 1.5) = ceil(1.3125) = 2h - very different from the 'max' basis's 5h.
    assert.equal(result.recommendedHours, 2);
    // avgIntervalMs/maxIntervalMs themselves are always the true observed values,
    // regardless of which one drives recommendedHours.
    assert.equal(result.maxIntervalMs, 3 * HOUR);
  });

  test("an unrecognized/missing basis falls back to the existing 'max' behavior", () => {
    const start = 1_700_000_000_000;
    const entries = [
      entry(start),
      entry(start + 10 * 60 * 1000),
      entry(start + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 30 * 60 * 1000),
    ];
    assert.equal(scanner.computeUpdateStats(entries, null, 1.5, undefined).recommendedHours, 5);
    assert.equal(scanner.computeUpdateStats(entries, null, 1.5, 'max').recommendedHours, 5);
    assert.equal(scanner.computeUpdateStats(entries, null, 1.5, 'bogus').recommendedHours, 5);
  });

  test('recommendedHours is never below the 1h floor for a very chatty device', () => {
    const start = 1_700_000_000_000;
    const entries = [0, 1, 2, 3, 4, 5].map((i) => entry(start + i * 60 * 1000)); // every minute
    const result = scanner.computeUpdateStats(entries);
    assert.equal(result.recommendedHours, 1);
  });

  test('each entry keeps its own capId, so the caller can show which capability reported', () => {
    const start = 1_700_000_000_000;
    const entries = [
      entry(start, 'measure_power'),
      entry(start + HOUR, 'measure_voltage'),
    ];
    const result = scanner.computeUpdateStats(entries);
    assert.equal(result.entries[0].capId, 'measure_power');
    assert.equal(result.entries[1].capId, 'measure_voltage');
  });

  test('persistedMaxGapMs wins over the window when larger - the "PC monitored by a plug" case', () => {
    // A power plug reporting every ~1 min while the monitored PC is on - the visible window
    // is 5 entries spanning only ~4 minutes, nowhere near long enough to contain last
    // night's several-hour "PC was off" gap. Without persistedMaxGapMs this would recommend
    // a 1h threshold and falsely flag "not reporting" the next time the PC is switched off.
    const start = 1_700_000_000_000;
    const entries = [0, 1, 2, 3, 4].map((i) => entry(start + i * 60 * 1000));
    const eightHours = 8 * 60 * 60 * 1000;
    const result = scanner.computeUpdateStats(entries, eightHours);
    assert.equal(result.maxIntervalMs, eightHours);
    // ceil(8h * 1.5) = 12h.
    assert.equal(result.recommendedHours, 12);
  });

  test('persistedMaxGapMs is ignored when the current window already has a larger gap', () => {
    const start = 1_700_000_000_000;
    const entries = [
      entry(start),
      entry(start + 10 * 60 * 1000),
      entry(start + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 20 * 60 * 1000),
      entry(start + 3 * HOUR + 30 * 60 * 1000),
    ];
    const result = scanner.computeUpdateStats(entries, 30 * 60 * 1000); // a stale, smaller persisted gap
    assert.equal(result.maxIntervalMs, 3 * HOUR);
  });

  test('a null/undefined persistedMaxGapMs is ignored, not treated as 0', () => {
    const start = 1_700_000_000_000;
    const entries = [0, 1, 2, 3, 4, 5].map((i) => entry(start + i * HOUR));
    const withNull = scanner.computeUpdateStats(entries, null);
    const withUndefined = scanner.computeUpdateStats(entries);
    assert.equal(withNull.maxIntervalMs, HOUR);
    assert.equal(withUndefined.maxIntervalMs, HOUR);
  });
});

describe('isRulePaused', () => {
  test('a future pausedUntil date is paused', () => {
    const future = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
    assert.equal(scanner.isRulePaused({ pausedUntil: future }), true);
  });

  test('a past pausedUntil date is not paused', () => {
    const past = new Date(Date.now() - 48 * HOUR).toISOString().slice(0, 10);
    assert.equal(scanner.isRulePaused({ pausedUntil: past }), false);
  });

  test('pausedUntil of today (the boundary day) is still paused until end of day', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(scanner.isRulePaused({ pausedUntil: today }), true);
  });

  test('null/missing pausedUntil is not paused', () => {
    assert.equal(scanner.isRulePaused({}), false);
    assert.equal(scanner.isRulePaused(null), false);
  });

  test('an unparsable pausedUntil is treated as not paused, not thrown', () => {
    assert.equal(scanner.isRulePaused({ pausedUntil: 'not-a-date' }), false);
  });
});

describe('runScan', () => {
  const config = { notReportingThresholdHours: 24, batteryThresholdPercent: 30 };
  const zones = { zoneA: { id: 'zoneA', name: 'Living room' } };

  test('sorts devices into all/notReporting/lowBattery and resolves zone names', () => {
    const devices = {
      good: device({
        id: 'good',
        name: 'Good device',
        zone: 'zoneA',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date().toISOString() }, measure_battery: { value: 80 } },
      }),
      stale: device({
        id: 'stale',
        name: 'Stale device',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date(Date.now() - 48 * HOUR).toISOString() } },
      }),
      lowBatt: device({
        id: 'lowBatt',
        name: 'Low battery device',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date().toISOString() }, measure_battery: { value: 10 } },
      }),
    };

    const result = scanner.runScan({
      devices, zones, rules: [], config,
    });

    assert.equal(result.all.length, 3);
    assert.deepEqual(result.notReporting.map((d) => d.id), ['stale']);
    assert.deepEqual(result.lowBattery.map((d) => d.id), ['lowBatt']);
    assert.equal(result.excluded.length, 0);

    const good = result.all.find((d) => d.id === 'good');
    assert.equal(good.zone, 'Living room');
    assert.equal(good.status, 'OK');
  });

  test('a button-only virtual device never lands in notReporting', () => {
    const devices = {
      btn: device({
        id: 'btn',
        name: 'Scene button',
        class: 'button',
        capabilities: ['button'],
        capabilitiesObj: { button: { value: null } },
      }),
    };

    const result = scanner.runScan({
      devices, zones, rules: [], config,
    });

    assert.equal(result.notReporting.length, 0);
    assert.equal(result.all.find((d) => d.id === 'btn').status, 'OK');
  });

  test('a rule with excludeAll removes the device from every list', () => {
    const devices = {
      excludedDev: device({
        id: 'excludedDev',
        name: 'Excluded device',
        capabilitiesObj: {},
      }),
    };
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'excludedDev', excludeAll: true,
    }];

    const result = scanner.runScan({
      devices, zones, rules, config,
    });

    assert.equal(result.all.length, 0);
    assert.equal(result.notReporting.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].id, 'excludedDev');
  });

  test('a rule with a future pausedUntil removes the device from every list, like excludeAll', () => {
    const devices = {
      pausedDev: device({ id: 'pausedDev', name: 'Paused device' }),
    };
    const future = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'pausedDev', pausedUntil: future,
    }];

    const result = scanner.runScan({
      devices, zones, rules, config,
    });

    assert.equal(result.all.length, 0);
    assert.equal(result.excluded.length, 1);
    assert.equal(result.excluded[0].reason, 'paused');
  });

  test('a rule with a past pausedUntil no longer excludes the device (self-resolving)', () => {
    const devices = {
      dev: device({
        id: 'dev',
        capabilitiesObj: { onoff: { value: true, lastUpdated: new Date().toISOString() } },
      }),
    };
    const past = new Date(Date.now() - 48 * HOUR).toISOString().slice(0, 10);
    const rules = [{
      id: 'r1', matchType: 'id', matchValue: 'dev', pausedUntil: past,
    }];

    const result = scanner.runScan({
      devices, zones, rules, config,
    });

    assert.equal(result.all.length, 1);
    assert.equal(result.excluded.length, 0);
  });
});
