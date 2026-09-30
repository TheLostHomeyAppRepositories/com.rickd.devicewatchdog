'use strict';

/**
 * Core scanning logic, ported from the original Homey Script
 * "Device Monitor & Battery Checker v2.4".
 *
 * Kept free of any Homey.* / HomeyAPI calls on purpose so it can be
 * unit tested with plain objects and reused from app.js.
 */

function safeRegExp(pattern, flags = 'i') {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    return null;
  }
}

function formatDate(date) {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Builds a map of zoneId -> sortIndex that mirrors the order zones are shown
 * in Homey's own device list (a pre-order walk of the zone tree, siblings
 * sorted by their `order` field like Homey does, falling back to name).
 * Devices in the same zone all get the same index, which is exactly what's
 * needed to sort zone groups in the Settings UI the way Homey itself does.
 * @param {object} zones - raw zones map/array as returned by the Homey API (each with id, name, parent, order)
 * @returns {Object<string, number>}
 */
function buildZoneOrderMap(zones) {
  const zoneList = Object.values(zones || {});
  const byParent = {};

  for (const zone of zoneList) {
    const parentKey = zone.parent || '__root__';
    if (!byParent[parentKey]) byParent[parentKey] = [];
    byParent[parentKey].push(zone);
  }

  for (const siblings of Object.values(byParent)) {
    siblings.sort((a, b) => {
      const orderA = typeof a.order === 'number' ? a.order : 0;
      const orderB = typeof b.order === 'number' ? b.order : 0;
      if (orderA !== orderB) return orderA - orderB;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  const orderMap = {};
  let counter = 0;

  function visit(parentKey) {
    const siblings = byParent[parentKey] || [];
    for (const zone of siblings) {
      orderMap[zone.id] = counter;
      counter += 1;
      visit(zone.id);
    }
  }

  visit('__root__');

  return orderMap;
}

/**
 * Finds the first matching rule for a device, using the same precedence
 * as the original script: exact ID > exact name > first matching pattern.
 * @returns {{ rule: object|null, ruleApplied: 'ID'|'NM'|'PT'|'--' }}
 */
function findRule(device, rules) {
  const byId = rules.find((r) => r.matchType === 'id' && r.matchValue === device.id);
  if (byId) return { rule: byId, ruleApplied: 'ID' };

  const byName = rules.find((r) => r.matchType === 'name' && r.matchValue === device.name);
  if (byName) return { rule: byName, ruleApplied: 'NM' };

  const patternRules = rules.filter((r) => r.matchType === 'pattern');
  for (const rule of patternRules) {
    const re = safeRegExp(rule.matchValue);
    if (re && re.test(device.name || '')) {
      return { rule, ruleApplied: 'PT' };
    }
  }

  return { rule: null, ruleApplied: '--' };
}

/**
 * Precomputes id/name -> rule maps once, so a caller doing this per-device (once per
 * device on every scan, or once per realtime device-update event) doesn't re-scan the
 * whole rules array from scratch every single time - on an installation with hundreds
 * of devices and rules, findRule's linear .find()/.filter() adds up fast when called
 * that often. Pattern rules can't be indexed by exact value (they match via regex), so
 * they stay a plain list, checked in the same order as before. "First rule of a type
 * wins" (matching Array#find's behavior) is preserved by only ever setting a key once.
 * @returns {{ byId: Map, byName: Map, patterns: object[] }}
 */
function buildRuleIndex(rules) {
  const byId = new Map();
  const byName = new Map();
  const patterns = [];

  for (const rule of rules) {
    if (rule.matchType === 'id') {
      if (!byId.has(rule.matchValue)) byId.set(rule.matchValue, rule);
    } else if (rule.matchType === 'name') {
      if (!byName.has(rule.matchValue)) byName.set(rule.matchValue, rule);
    } else if (rule.matchType === 'pattern') {
      patterns.push(rule);
    }
  }

  return { byId, byName, patterns };
}

/**
 * Same precedence/result shape as findRule, but against a prebuilt buildRuleIndex()
 * instead of a raw rules array - O(1) for the common ID/name cases instead of O(rules).
 */
function findRuleIndexed(device, index) {
  const byId = index.byId.get(device.id);
  if (byId) return { rule: byId, ruleApplied: 'ID' };

  const byName = index.byName.get(device.name);
  if (byName) return { rule: byName, ruleApplied: 'NM' };

  for (const rule of index.patterns) {
    const re = safeRegExp(rule.matchValue);
    if (re && re.test(device.name || '')) {
      return { rule, ruleApplied: 'PT' };
    }
  }

  return { rule: null, ruleApplied: '--' };
}

/**
 * Whether a rule's seasonal pause is currently active. Paused through the end of
 * the selected calendar day (not the exact instant midnight starts) - picking
 * "today" should keep a device paused for the rest of today, not expire it the
 * instant it's set. Self-resolving: this is re-evaluated fresh on every call,
 * no separate scheduler needed to "wake" a device back up once the date passes.
 */
function isRulePaused(rule) {
  if (!rule || !rule.pausedUntil) return false;
  const end = new Date(rule.pausedUntil);
  if (Number.isNaN(end.getTime())) return false;
  end.setHours(23, 59, 59, 999);
  return Date.now() <= end.getTime();
}

/**
 * Capability bases that never tell us anything useful about "is this device still reporting":
 * - `button` is momentary/stateless and never carries a `lastUpdated` (Homey only fires a Flow
 *   trigger for it, confirmed on the community thread for virtual "button" devices from
 *   com.arjankranenburg.virtual).
 * - `measure_battery` / `alarm_battery` only update when the device happens to wake up and
 *   report - on button-driven devices (remotes, Hue Tap Dial, ...) that's exactly the same rare
 *   "only on press" cadence as the button itself, so a device untouched for months looks
 *   "not reporting" even though it's perfectly reachable (reported on the community thread for
 *   a Hue Tap Dial: `lastUpdated` from February, `lastSeenAt` from today). Battery level itself
 *   is still monitored separately via the low-battery check below - this only controls the
 *   staleness/"not reporting" check.
 */
const NON_INFORMATIVE_STALENESS_CAP_BASES = new Set(['button', 'measure_battery', 'alarm_battery']);

/**
 * Battery capability bases whose own `lastUpdated` counts toward the "not reporting"
 * staleness check, unless a device's rule explicitly opts out (includeBatteryForReporting
 * === false) - see computeDeviceStatus. On by default: a still-updating battery is normally
 * real evidence the device's radio/mesh link is alive. The opt-out exists for the rarer
 * device where battery updates on its own cadence, independent of whether the device's
 * actual measured value changed, and would otherwise mask a frozen primary sensor value
 * (e.g. measure_temperature stuck for weeks) behind a battery capability that's still
 * ticking. Kept as its own set (not reused from NON_INFORMATIVE_STALENESS_CAP_BASES above)
 * since the two lists serve different purposes: that one gates whether staleness is checked
 * AT ALL, this one only filters which capability's timestamp counts once it is.
 */
const BATTERY_STALENESS_CAP_BASES = new Set(['measure_battery', 'alarm_battery']);

/**
 * Whether a device can meaningfully be checked for staleness at all. A device whose only
 * capabilities are momentary/stateless or battery-only never carries a meaningful `lastUpdated`
 * on its own - see NON_INFORMATIVE_STALENESS_CAP_BASES above. Running the "not reporting" check
 * on such a device would flag it forever with nothing the user could do about it.
 *
 * Beyond that fixed name list, any capability the Homey API itself marks `getable: false` gets
 * the same treatment, whatever it's called - it's write-only/action-only by definition (Homey's
 * own `button` is exactly that shape, which is why it's also caught here even without the name
 * check) and can never carry a real "last changed" for us to read back. Reported on the
 * community thread for a WhatsApp-app device whose only capability is a custom `send_data`
 * boolean (setable, no getable, "Last Changed" permanently blank in Homey's own device
 * inspector) - flagged "not reporting" forever with nothing the user could do about it, same
 * failure shape as the button-only case above but for a capability name that can't be
 * hardcoded up front since any app can introduce one.
 *
 * A device that DOES have a real, readable capability (measure_*, onoff, a sensor, ...) but has
 * simply never sent data is still checkable here - it stays flagged exactly as before. The
 * discriminator is the capability shape, not whether a timestamp happens to be present.
 * Falls back to the keys of capabilitiesObj when `capabilities` isn't populated (defensive -
 * the real HomeyAPI always sets it, plain-object test fixtures often don't).
 */
function canCheckStaleness(device) {
  const capsObj = device.capabilitiesObj || {};
  const caps = Array.isArray(device.capabilities) && device.capabilities.length
    ? device.capabilities
    : Object.keys(capsObj);
  return caps.some((cap) => {
    if (capsObj[cap] && capsObj[cap].getable === false) return false;
    return !NON_INFORMATIVE_STALENESS_CAP_BASES.has(String(cap).split('.')[0]);
  });
}

/**
 * Computes reporting + battery status for a single device given its matched rule.
 */
function computeDeviceStatus(device, rule, config) {
  const custom = rule || {};

  let maxLastUpdatedTime = null;
  let isReporting = true;

  // Surfaced independently of includeBatteryForReporting below, purely for display (e.g.
  // the Settings UI's battery details) - this is the raw timestamp, not a staleness signal.
  const batteryCap = device.capabilitiesObj?.measure_battery || device.capabilitiesObj?.alarm_battery;
  const batteryLastUpdated = (batteryCap && batteryCap.lastUpdated) ? batteryCap.lastUpdated : null;

  if (!custom.onlyCheckBattery && canCheckStaleness(device)) {
    const includeBattery = custom.includeBatteryForReporting !== false;
    for (const [capId, cap] of Object.entries(device.capabilitiesObj || {})) {
      if (!cap || !cap.lastUpdated) continue;
      if (!includeBattery && BATTERY_STALENESS_CAP_BASES.has(String(capId).split('.')[0])) continue;
      const time = new Date(cap.lastUpdated).getTime();
      if (Number.isFinite(time) && time > (maxLastUpdatedTime || 0)) maxLastUpdatedTime = time;
    }

    const includeLastSeen = custom.includeLastSeenForReporting !== null && custom.includeLastSeenForReporting !== undefined
      ? custom.includeLastSeenForReporting
      : config.includeLastSeenForReporting;
    if (includeLastSeen && device.lastSeenAt) {
      const seenTime = new Date(device.lastSeenAt).getTime();
      if (Number.isFinite(seenTime) && seenTime > (maxLastUpdatedTime || 0)) maxLastUpdatedTime = seenTime;
    }

    const thresholdHrs = custom.notReportingHours
      ? custom.notReportingHours
      : config.notReportingThresholdHours;

    isReporting = (Date.now() - (maxLastUpdatedTime || 0)) < (thresholdHrs * 3600000);
  }

  let batteryStatus = 'N/A';
  let batteryValue = null;
  let isLowBattery = false;

  if (custom.excludeBattery) {
    batteryStatus = 'EXCL';
  } else {
    const measuredPct = device.capabilitiesObj?.measure_battery?.value;
    const alarmBattery = device.capabilitiesObj?.alarm_battery?.value;
    const threshold = custom.batteryThreshold !== undefined && custom.batteryThreshold !== null
      ? custom.batteryThreshold
      : config.batteryThresholdPercent;

    if (typeof measuredPct === 'number' && !Number.isNaN(measuredPct)) {
      batteryValue = Math.round(measuredPct);
      batteryStatus = `${batteryValue}%`;
      if (measuredPct <= threshold) isLowBattery = true;
    } else if (alarmBattery) {
      batteryStatus = 'ALARM';
      isLowBattery = true;
    } else if (Array.isArray(device.capabilities) && device.capabilities.includes('measure_battery')) {
      batteryStatus = 'OK';
    }
  }

  return {
    maxLastUpdatedTime,
    isReporting,
    batteryStatus,
    batteryValue,
    batteryLastUpdated,
    isLowBattery,
  };
}

// Minimum recent-update samples before a threshold recommendation is trustworthy enough to
// show at all - below this, computeUpdateStats reports the count but leaves the rest null.
const MIN_UPDATE_STATS_SAMPLES = 5;
// Safety margin applied over the worst observed gap (not just the average) when deriving a
// recommended "not reporting" threshold - a plain average would still false-positive on the
// device's own occasional slower spells (e.g. a sensor that mostly reports every 10 min but
// occasionally goes 90 min quiet); 1.5x the max observed gap gives headroom without being as
// loose as a one-size-fits-all default.
const RECOMMEND_THRESHOLD_SAFETY_FACTOR = 1.5;
const RECOMMEND_THRESHOLD_MIN_HOURS = 1;

/**
 * Turns a device's rolling window of recent "it reported something" entries into a summary
 * (average/max interval) and a suggested "not reporting" threshold. Pure - the caller
 * (app.js) owns collecting/persisting the entries; this only does the math, so it can be
 * unit tested without any HomeyAPI/settings involved.
 * @param {{ts:number, capId:?string}[]} entries - recent updates, ascending (oldest first)
 * @param {?number} [persistedMaxGapMs] - the largest gap ever observed for this device, kept
 *   by the caller across the entries window scrolling (see app.js's _updateStats field
 *   comment) - a chatty device's `entries` only spans its last ~20 updates, so without this
 *   a real but rare long gap (e.g. a monitored PC being off overnight) would quietly stop
 *   being reflected in the recommendation as soon as normal-cadence entries push it out.
 * @param {?number} [safetyFactor] - multiplier applied over the worst observed gap (see
 *   RECOMMEND_THRESHOLD_SAFETY_FACTOR above) - user-configurable via
 *   config.recommendationSafetyFactor (app.js#saveConfig clamps it to [1.0, 5.0]). Falls
 *   back to RECOMMEND_THRESHOLD_SAFETY_FACTOR when missing/non-finite/<=0.
 * @param {?string} [basis] - which observed value recommendedHours is derived from -
 *   'avg' uses avgIntervalMs, anything else (missing, 'max', garbage) uses maxIntervalMs
 *   (the existing default behavior). User-configurable via config.recommendationBasis
 *   (app.js#saveConfig whitelists it to 'max'/'avg'). Only affects recommendedHours - the
 *   returned avgIntervalMs/maxIntervalMs are always the true observed values either way.
 * @returns {{count:number, entries:object[], avgIntervalMs:?number, maxIntervalMs:?number, recommendedHours:?number}}
 */
function computeUpdateStats(entries, persistedMaxGapMs, safetyFactor, basis) {
  const list = Array.isArray(entries) ? entries : [];
  const count = list.length;
  if (count < MIN_UPDATE_STATS_SAMPLES) {
    return {
      count, entries: list, avgIntervalMs: null, maxIntervalMs: null, recommendedHours: null,
    };
  }

  const factor = (Number.isFinite(safetyFactor) && safetyFactor > 0)
    ? safetyFactor
    : RECOMMEND_THRESHOLD_SAFETY_FACTOR;

  const intervals = [];
  for (let i = 1; i < list.length; i += 1) intervals.push(list[i].ts - list[i - 1].ts);

  const avgIntervalMs = intervals.reduce((sum, ms) => sum + ms, 0) / intervals.length;
  const windowMaxIntervalMs = Math.max(...intervals);
  const maxIntervalMs = (Number.isFinite(persistedMaxGapMs) && persistedMaxGapMs > windowMaxIntervalMs)
    ? persistedMaxGapMs
    : windowMaxIntervalMs;
  const baseIntervalMs = basis === 'avg' ? avgIntervalMs : maxIntervalMs;
  const recommendedHours = Math.max(
    RECOMMEND_THRESHOLD_MIN_HOURS,
    Math.ceil((baseIntervalMs * factor) / 3600000),
  );

  return {
    count, entries: list, avgIntervalMs, maxIntervalMs, recommendedHours,
  };
}

// A battery reading older than this is treated as "the device probably went quiet" rather
// than "the battery is genuinely at that level" - see the 'staleBattery' branch below.
const RECOMMEND_BATTERY_STALE_DAYS = 30;

/**
 * Picks a short "what to do" hint for a device that's currently flagged in one of the three
 * categories. Heuristic and deliberately conservative: every branch maps to copy phrased as
 * a suggestion, and an unrecognised device shape falls through to a safe generic hint rather
 * than guessing. Returns a { key, params } the Settings UI turns into localized text, or
 * null when `ctx.category` is falsy (device isn't flagged).
 *
 * @param {object} device - raw HomeyAPI device (capabilities, capabilitiesObj, class, available, lastSeenAt)
 * @param {object} ctx
 * @param {'unavailable'|'notReporting'|'lowBattery'} ctx.category - which category flagged it
 * @param {number} [ctx.thresholdHrs=24] - the not-reporting threshold that applies to this device
 * @param {?string} [ctx.testCapability] - a testable capability id, or null
 * @param {number} [ctx.unavailablePeersSameApp=0] - how many OTHER devices from the same owning app are also unavailable
 */
function deviceRecommendation(device, ctx) {
  const {
    category, thresholdHrs = 24, testCapability = null, unavailablePeersSameApp = 0,
  } = ctx || {};
  if (!category) return null;

  const caps = Array.isArray(device.capabilities) && device.capabilities.length
    ? device.capabilities
    : Object.keys(device.capabilitiesObj || {});
  const capObj = device.capabilitiesObj || {};
  const now = Date.now();
  const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : null;
  const seenAgeMs = (lastSeen !== null && Number.isFinite(lastSeen)) ? now - lastSeen : null;
  const thresholdMs = thresholdHrs * 3600000;
  const hasBatteryCap = caps.includes('measure_battery') || caps.includes('alarm_battery');

  if (category === 'unavailable') {
    if (unavailablePeersSameApp >= 2) return { key: 'unavailableAppRestart', params: {} };
    if (hasBatteryCap) return { key: 'unavailableBattery', params: {} };
    return { key: 'unavailableCheck', params: {} };
  }

  if (category === 'lowBattery') {
    const bt = (capObj.measure_battery && capObj.measure_battery.lastUpdated)
      ? new Date(capObj.measure_battery.lastUpdated).getTime() : null;
    if (bt !== null && Number.isFinite(bt) && (now - bt) > RECOMMEND_BATTERY_STALE_DAYS * 86400000) {
      return { key: 'staleBattery', params: {} };
    }
    if (capObj.alarm_battery && capObj.alarm_battery.value) return { key: 'batteryAlarm', params: {} };
    return { key: 'batteryReplace', params: {} };
  }

  // category === 'notReporting'
  if (!canCheckStaleness(device)) return { key: 'notMonitorable', params: {} };

  const capValues = Object.values(capObj);
  const anyTimestamp = capValues.some((c) => c && c.lastUpdated);
  const anyValue = capValues.some((c) => c && c.value !== null && c.value !== undefined);
  if (!anyTimestamp && !anyValue) return { key: 'neverReported', params: {} };

  // Directly testable + Homey still sees it: the fastest check is to nudge it. Comes before
  // the event-sensor hint on purpose - for the rare device that's both (e.g. a light that
  // also exposes an alarm capability), "press Test" beats "raise the threshold".
  if (testCapability && device.available !== false) return { key: 'tryTest', params: {} };

  // An `alarm_*` capability means the device is event-driven - it only sends when its state
  // actually changes, so long quiet stretches are expected. Excludes alarm_battery (a battery
  // signal) and alarm_connectivity (a health signal - if THAT device goes quiet it's a real
  // problem, not "normal"). Deliberately NOT keyed on class === 'sensor': that also covers
  // power/air-quality/etc. meters, which DO report continuously and where a long gap is a real
  // concern (those fall through to silentlyGone / notReportingGeneric instead).
  const hasEventCap = caps.some((c) => {
    const base = String(c).split('.')[0];
    return base.startsWith('alarm_') && base !== 'alarm_battery' && base !== 'alarm_connectivity';
  });
  if (hasEventCap && seenAgeMs !== null && seenAgeMs < thresholdMs) {
    return { key: 'eventSensor', params: {} };
  }

  if (seenAgeMs !== null && seenAgeMs >= thresholdMs && device.available !== false) {
    return { key: 'silentlyGone', params: {} };
  }

  return { key: 'notReportingGeneric', params: {} };
}

/**
 * Runs a full scan over the given devices/zones using the given rules/config.
 * @returns {{ all: object[], notReporting: object[], lowBattery: object[], excluded: object[], generatedAt: string }}
 */
function runScan({
  devices, zones, rules, config,
}) {
  const zoneMap = Object.fromEntries(Object.values(zones).map((zone) => [zone.id, zone.name]));
  // Built once per scan instead of letting findRule re-scan the whole rules array for
  // every single device - see buildRuleIndex.
  const ruleIndex = buildRuleIndex(rules);

  const all = [];
  const notReporting = [];
  const lowBattery = [];
  const excluded = [];

  for (const device of Object.values(devices)) {
    const { rule, ruleApplied } = findRuleIndexed(device, ruleIndex);

    if (rule && (rule.excludeAll || isRulePaused(rule))) {
      excluded.push({ id: device.id, name: device.name, reason: rule.excludeAll ? 'excludeAll' : 'paused' });
      continue;
    }

    const status = computeDeviceStatus(device, rule, config);
    const zoneName = device.zone ? (zoneMap[device.zone] || null) : null;

    const entry = {
      id: device.id,
      name: device.name,
      zone: zoneName,
      class: device.class || null,
      available: device.available !== false,
      lastUpdated: formatDate(status.maxLastUpdatedTime ? new Date(status.maxLastUpdatedTime) : null),
      battery: status.batteryStatus,
      batteryValue: status.batteryValue,
      status: status.isReporting ? 'OK' : 'NOK',
      ruleApplied,
    };

    all.push(entry);

    if (!status.isReporting) notReporting.push(entry);
    if (status.isLowBattery) lowBattery.push(entry);
  }

  return {
    all,
    notReporting,
    lowBattery,
    excluded,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  formatDate,
  findRule,
  buildRuleIndex,
  findRuleIndexed,
  isRulePaused,
  canCheckStaleness,
  deviceRecommendation,
  computeDeviceStatus,
  computeUpdateStats,
  runScan,
  safeRegExp,
  buildZoneOrderMap,
};
