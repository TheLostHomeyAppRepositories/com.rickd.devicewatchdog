'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const { DEFAULT_CONFIG, DEFAULT_RULES } = require('./lib/defaults');
const scanner = require('./lib/scanner');
const rulesLib = require('./lib/rules');

const SETTINGS_KEY_CONFIG = 'config';
const SETTINGS_KEY_RULES = 'rules';
const SETTINGS_KEY_FLAG_STATE = 'flagState';
const SETTINGS_KEY_LAST_SCAN = 'lastScan';
const SETTINGS_KEY_EVENT_LOG = 'eventLog';
const SETTINGS_KEY_PROBLEM_SINCE = 'problemSince';
const SETTINGS_KEY_BATTERY_DEFAULT_MIGRATED = 'includeBatteryForReportingDefaultMigrated';
const SETTINGS_KEY_UPDATE_STATS = 'updateStats';

// Rolling per-device window of recent "it reported something" timestamps, used to derive a
// suggested "not reporting" threshold (see lib/scanner.js#computeUpdateStats) instead of the
// user guessing. 20/device keeps ~305 real devices in the same order of magnitude as what's
// already persisted (lastScan + eventLog together).
const MAX_UPDATE_STATS_ENTRIES = 20;

// How long an auto-test's own re-sent capability value is excluded from counting as a
// genuine report in _recordUpdateStat (see _runAutoTests/_pendingAutoTestExclusion below).
// Long enough to cover realtime propagation delay after the test call resolves, short
// enough that a driver which never actually bumps lastUpdated for a same-value write
// doesn't end up permanently blind to real future updates on that capability.
const AUTO_TEST_EXCLUSION_TTL_MS = 5 * 60 * 1000;

// Capabilities safe to re-set with their own current value as a reachability test:
// this round-trips to the hardware (so a failure means the device is truly unreachable)
// without producing a perceptible state change, unlike toggling on/off for real. Limited
// to continuous/numeric setpoints - deliberately excludes enum-style capabilities like
// windowcoverings_state ("up"/"down"/"idle"), where re-sending the current value isn't
// guaranteed to be a no-op on every driver and could re-trigger real motion. These are
// base ids - _findTestCapability also matches multi-instance variants of them (e.g. a
// siren's "onoff.siren"), not just an exact "onoff".
const TESTABLE_CAPABILITIES = ['onoff', 'dim', 'windowcoverings_set', 'target_temperature', 'volume_set'];

// Matches the capabilities lib/scanner.js itself treats as battery-relevant (percentage
// or alarm) - used to hide battery-related settings for devices that have neither.
const BATTERY_CAPABILITIES = ['measure_battery', 'alarm_battery'];

// Rolling cap for the Verlauf/log tab - keeps homey.settings from growing unbounded.
const MAX_LOG_ENTRIES = 200;

// How often to check the HomeyAPI realtime socket and resync availability, independent
// of the scan interval (which the user can disable entirely) - see _checkRealtimeConnection.
const REALTIME_HEALTHCHECK_MS = 5 * 60 * 1000;

// Caps how many device names are spelled out in a summary trigger's "devices" token /
// timeline excerpt. There's no known hard limit on Flow token length, but an unbounded
// comma list (e.g. 80 devices going offline at once) is unreadable either way - `count`
// still reflects the true total, this is purely about keeping the text usable.
const MAX_NAMES_IN_LIST = 10;

function formatNameList(names, homey) {
  if (names.length <= MAX_NAMES_IN_LIST) return names.join(', ');
  const shown = names.slice(0, MAX_NAMES_IN_LIST);
  const more = homey.__('backend.andMore', { count: names.length - MAX_NAMES_IN_LIST });
  return `${shown.join(', ')} … ${more}`;
}

// The Settings UI's <input min="..."> is a client-side hint only - it doesn't stop a
// negative/NaN value from being typed or POSTed directly. These guard the numbers that
// feed threshold math in lib/scanner.js, where e.g. a negative "hours" would make a
// device permanently show as not-reporting regardless of when it last updated. Only used
// for the global config (defaults, not nullable) - the per-device rule equivalents
// (positiveNumberOrNull etc.) live in lib/rules.js alongside the rest of the rule
// sanitizing whitelist.
function positiveNumberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Unlike positiveNumberOrDefault above, 0 is a valid, meaningful value here ("no delay,
// confirm instantly") rather than "unset".
function nonNegativeNumberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Clamps the Recommendations tab's configurable safety-margin multiplier (see
// lib/scanner.js#computeUpdateStats). Below 1.0 would suggest a threshold shorter than a
// gap already observed - guaranteed to immediately re-flag the device, the opposite of
// what this setting is for. Capped at 5.0 as a sanity ceiling - past that the suggestion
// stops being "worst gap + headroom" and is almost certainly a typo. Rounded to 2 decimals
// to match the Settings UI's step="0.01" input and avoid float precision creep across saves.
function safetyFactorOrDefault(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(5, Math.max(1, n)) * 100) / 100;
}

// One-time migration: the per-device override used to be "days until offline"
// (notReportingDays), now it's hours (notReportingHours) to match the base threshold.
function migrateRuleToHours(rule) {
  if (rule.notReportingDays == null) return rule;
  const { notReportingDays, ...rest } = rule;
  return { ...rest, notReportingHours: notReportingDays * 24 };
}

// One-time migration: includeBatteryForReporting shipped in 1.9.35 defaulting to false,
// and the Settings UI client wrote that `false` onto every rule it saved regardless of
// whether the user ever touched that particular field. The default has since flipped to
// true, so a blanket `false` inherited from 1.9.35 needs clearing once, otherwise every
// existing rule would look like a deliberate per-device opt-out. Guarded by
// SETTINGS_KEY_BATTERY_DEFAULT_MIGRATED so a `false` a user sets afterward, for real,
// isn't wiped again on the next restart.
function migrateIncludeBatteryDefault(rule) {
  if (rule.includeBatteryForReporting !== false) return rule;
  const { includeBatteryForReporting, ...rest } = rule;
  return rest;
}

class DeviceWatchdogApp extends Homey.App {

  async onInit() {
    this.log('Device Watchdog initialized');

    this.config = { ...DEFAULT_CONFIG, ...(this.homey.settings.get(SETTINGS_KEY_CONFIG) || {}) };
    this._setRules((this.homey.settings.get(SETTINGS_KEY_RULES) || DEFAULT_RULES).map(migrateRuleToHours));
    if (!this.homey.settings.get(SETTINGS_KEY_BATTERY_DEFAULT_MIGRATED)) {
      this._setRules(this.rules.map(migrateIncludeBatteryDefault));
      this.homey.settings.set(SETTINGS_KEY_BATTERY_DEFAULT_MIGRATED, true);
    }
    this.homey.settings.set(SETTINGS_KEY_RULES, this.rules);
    this.flagState = this.homey.settings.get(SETTINGS_KEY_FLAG_STATE)
      // lowBatteryConfirmed is the delay-gated subset of lowBattery (see
      // _getLowBatteryDelaySeconds / _fireEdgeTriggers) - kept separate so a device isn't
      // re-fired every scan once confirmed, and so a settings file saved by an older
      // version (with no lowBatteryConfirmed key at all) starts everyone unconfirmed
      // rather than crashing on a missing array.
      || { notReporting: [], lowBattery: [], lowBatteryConfirmed: [] };
    // Since-when each device entered a problem category (widget detail view) - keyed by
    // device id, cleared once the device leaves that category again. Separate from
    // flagState (which only needs the current set, not when it started).
    this.problemSince = this.homey.settings.get(SETTINGS_KEY_PROBLEM_SINCE)
      || { notReporting: {}, lowBattery: {}, unavailable: {} };
    this.lastScan = this.homey.settings.get(SETTINGS_KEY_LAST_SCAN) || null;
    // Seeded from whatever was already on disk, so the first scan after a restart
    // doesn't write again if nothing actually changed while the app was down.
    this._lastPersistedScanSignature = this._scanSignature(this.lastScan);
    this.eventLog = this.homey.settings.get(SETTINGS_KEY_EVENT_LOG) || [];
    // { [deviceId]: { entries: [{ts, capId}, ...], maxGapMs, firstSeenTs } }, entries oldest
    // first and capped at MAX_UPDATE_STATS_ENTRIES - see _recordUpdateStat. maxGapMs is the
    // largest gap ever observed for this device, tracked separately from `entries` on
    // purpose: a chatty device's entries only span its last ~20 updates (minutes, for
    // something that reports every minute), so a long-but-real quiet spell (e.g. a monitored
    // PC being off overnight) would otherwise scroll back out of the window the next morning
    // and the recommendation would quietly forget it ever happened. firstSeenTs is the
    // timestamp of the very first entry ever recorded for this device - used by the
    // Recommendations tab's "minimum observation period" filter, so a device isn't trusted
    // with a recommendation just because it happened to produce 5 updates in its first ten
    // minutes. Neither maxGapMs nor firstSeenTs ever change on their own - only the manual
    // "reset stats" button clears them.
    this._updateStats = this.homey.settings.get(SETTINGS_KEY_UPDATE_STATS) || {};
    // One-off migration: pre-release entries were a bare array (or even bare numbers before
    // capId tracking) before maxGapMs/firstSeenTs tracking was added. Never shipped/
    // published, but this Homey already has some on disk from earlier this session - upgrade
    // in place, and reconstruct maxGapMs/firstSeenTs from whatever history is still in the
    // (short) entries list rather than starting back at null (firstSeenTs reconstructed this
    // way is a best-effort underestimate for a chatty device whose true first entry has
    // already scrolled out of the capped list - acceptable, it only makes the "minimum
    // observation period" filter slightly more conservative, never less).
    for (const id of Object.keys(this._updateStats)) {
      const raw = this._updateStats[id];
      let entries;
      if (Array.isArray(raw)) {
        entries = raw.map((entry) => (typeof entry === 'number' ? { ts: entry, capId: null } : entry));
      } else {
        entries = (raw && Array.isArray(raw.entries)) ? raw.entries : [];
      }
      let maxGapMs = (raw && typeof raw.maxGapMs === 'number') ? raw.maxGapMs : null;
      for (let i = 1; i < entries.length; i += 1) {
        const gap = entries[i].ts - entries[i - 1].ts;
        if (maxGapMs === null || gap > maxGapMs) maxGapMs = gap;
      }
      const firstSeenTs = (raw && typeof raw.firstSeenTs === 'number')
        ? raw.firstSeenTs
        : (entries.length ? entries[0].ts : null);
      this._updateStats[id] = {
        entries, maxGapMs, firstSeenTs,
      };
    }
    this._updateStatsDirty = false;

    this._zoneMap = {};
    this._availabilityMap = new Map();
    this._intervalTimer = null;
    this._startupGraceTimer = null;
    this._scanPromise = null;
    this._unavailableBatch = new Set();
    this._unavailableBatchTimer = null;
    this._availableAgainBatch = new Set();
    this._availableAgainBatchTimer = null;
    this._pendingUnavailableTimers = new Map();
    this._confirmedUnavailable = new Set();
    // deviceId -> { capId, setAt } - armed by _runAutoTests right after a successful
    // auto-heal test, consumed/expired in _recordUpdateStat. See AUTO_TEST_EXCLUSION_TTL_MS.
    this._pendingAutoTestExclusion = new Map();

    this._registerFlowCards();

    try {
      this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
      await this._primeAvailabilityMap();
      await this._connectRealtime();
    } catch (err) {
      this._apiInitError = err;
      this.error('Konnte HomeyAPI nicht initialisieren:', err);
    }

    this._scheduleInterval({ runImmediately: true });

    // Independent safety net for the realtime socket: runs regardless of whether the
    // interval scan is enabled, so "unavailable" tracking stays correct even with
    // automatic scanning turned off. See _checkRealtimeConnection for what it catches.
    this.homey.setInterval(() => {
      this._checkRealtimeConnection().catch((err) => this.error('Realtime-Healthcheck fehlgeschlagen:', err));
    }, REALTIME_HEALTHCHECK_MS);
  }

  // The virtual Watchdog device itself is just another device as far as HomeyAPI is
  // concerned - excluded everywhere devices are gathered so it never monitors itself
  // (its own capabilities are driven purely by _updateWatchdogDevice, not real sensor
  // data, so "not reporting"/battery checks on it would be meaningless noise).
  _isOwnDevice(device) {
    return !!device && device.ownerUri === `homey:app:${this.homey.manifest.id}`;
  }

  // The homey-api socket does auto-reconnect at the transport level, but that's opaque
  // to us and never replays events missed while disconnected. This periodically (a)
  // makes sure we're actually connected, reconnecting explicitly if not, and (b) always
  // re-syncs availability afterwards so a silently-missed transition still gets caught -
  // both cheaper and more reliable than trying to hook into internal socket events.
  async _checkRealtimeConnection() {
    if (!this.api) return;

    if (!this.api.devices.isConnected()) {
      this.log('Realtime-Verbindung getrennt, verbinde neu...');
      await this.api.devices.connect();
    }

    await this._reconcileAvailability();
  }

  // Re-checks every device's availability against our cached map and fires the same
  // edge-trigger logic as a live realtime event for anything that changed while we
  // weren't watching (missed socket event, or the socket having been down).
  async _reconcileAvailability() {
    const devices = await this.api.devices.getDevices();
    for (const device of Object.values(devices)) {
      if (this._isOwnDevice(device)) continue;
      this._handleDeviceUpdate(device);
    }
  }

  // ---------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------

  _registerFlowCards() {
    this.homey.flow.getActionCard('run_scan').registerRunListener(async () => {
      await this.runScan('flow');
      return true;
    });

    this._triggerNotReporting = this.homey.flow.getTriggerCard('device_not_reporting')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));
    this._triggerBatteryLow = this.homey.flow.getTriggerCard('device_battery_low')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));
    this._triggerUnavailable = this.homey.flow.getTriggerCard('device_unavailable')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));
    this._triggerTestSucceeded = this.homey.flow.getTriggerCard('device_test_succeeded')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));
    this._triggerTestFailed = this.homey.flow.getTriggerCard('device_test_failed')
      .registerRunListener(this._deviceArgMatches)
      .registerArgumentAutocompleteListener('target_device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getActionCard('test_device')
      .registerRunListener(async (args) => {
        await this.testDevice(args.device.id);
        return true;
      })
      .registerArgumentAutocompleteListener('device', this._testableDeviceAutocomplete.bind(this));

    this.homey.flow.getActionCard('pause_device')
      .registerRunListener(async (args) => {
        await this.pauseDevice(args.device.id, args.date, { rescanNow: !!args.rescanNow });
        return true;
      })
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    // Same backend action as pause_device, but the date arg is plain text (not the
    // native date-picker type) - Homey's flow tokens are only ever typed as
    // string/number/boolean/image, so a "date"-typed argument can't accept a dropped-in
    // token/variable the way a text argument reliably can. This card trades the native
    // picker for that flexibility.
    this.homey.flow.getActionCard('pause_device_variable')
      .registerRunListener(async (args) => {
        await this.pauseDevice(args.device.id, args.date, { rescanNow: !!args.rescanNow });
        return true;
      })
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getActionCard('resume_device')
      .registerRunListener(async (args) => {
        await this.pauseDevice(args.device.id, null);
        return true;
      })
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    // Summary triggers: fire once per batch (scan, or realtime debounce window) with
    // every newly-affected device bundled into count/devices tokens, so a Flow doesn't
    // fire N times in a row when N devices break at once.
    this._triggerNotReportingSummary = this.homey.flow.getTriggerCard('devices_not_reporting_summary');
    this._triggerBatteryLowSummary = this.homey.flow.getTriggerCard('devices_low_battery_summary');
    this._triggerUnavailableSummary = this.homey.flow.getTriggerCard('devices_unavailable_summary');

    // Recovery counterparts - same batching idea, opposite direction (see forum request:
    // dashboard users want to reset a "problem" indicator once a device heals, not just set it).
    this._triggerAvailableAgainSummary = this.homey.flow.getTriggerCard('devices_available_again_summary');
    this._triggerReportingAgainSummary = this.homey.flow.getTriggerCard('devices_reporting_again_summary');
    this._triggerBatteryOkAgainSummary = this.homey.flow.getTriggerCard('devices_battery_ok_again_summary');

    this.homey.flow.getConditionCard('device_is_unavailable')
      .registerRunListener(async (args) => this._confirmedUnavailable.has(args.device.id)
        && this._isMonitored(args.device.id))
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getConditionCard('device_is_not_reporting')
      .registerRunListener(async (args) => (this.lastScan?.notReporting || []).includes(args.device.id))
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getConditionCard('device_has_low_battery')
      .registerRunListener(async (args) => (this.lastScan?.lowBattery || []).includes(args.device.id))
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    this.homey.flow.getConditionCard('device_is_paused')
      .registerRunListener(async (args) => {
        const { rule } = scanner.findRuleIndexed({ id: args.device.id }, this._ruleIndex);
        return scanner.isRulePaused(rule);
      })
      .registerArgumentAutocompleteListener('device', this._deviceAutocomplete.bind(this));

    // "Any device" variants: no device picker, for flows hung off the summary triggers
    // where the specific device isn't known up front. Same filtering/source as the
    // per-category counts already shown on the virtual device and widget.
    this.homey.flow.getConditionCard('any_device_is_unavailable')
      .registerRunListener(async () => this._countUnavailable() > 0);

    this.homey.flow.getConditionCard('any_device_is_not_reporting')
      .registerRunListener(async () => (this.lastScan?.notReporting || []).length > 0);

    this.homey.flow.getConditionCard('any_device_has_low_battery')
      .registerRunListener(async () => (this.lastScan?.lowBattery || []).length > 0);
  }

  // Required device-picker arg shared by the per-device triggers: fires only for the
  // selected device. Broadcasting to any device is handled by the separate summary
  // triggers (devices_*_summary) instead, so there's no ambiguous "leave it empty" mode.
  async _deviceArgMatches(args, state) {
    return args.target_device.id === state.deviceId;
  }

  async _deviceAutocomplete(query) {
    await this._ensureApi();
    const devices = await this.api.devices.getDevices();
    const q = (query || '').toLowerCase();

    return Object.values(devices)
      .filter((d) => !this._isOwnDevice(d) && (!q || d.name.toLowerCase().includes(q)))
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Same as _deviceAutocomplete, but only offers devices testDevice() could actually
  // succeed on - picking anything else from "Test device reachability" would just
  // always fail with "no testable capability available".
  async _testableDeviceAutocomplete(query) {
    await this._ensureApi();
    const devices = await this.api.devices.getDevices();
    const q = (query || '').toLowerCase();

    return Object.values(devices)
      .filter((d) => !this._isOwnDevice(d)
        && TESTABLE_CAPABILITIES.some((id) => (d.capabilities || []).includes(id))
        && (!q || d.name.toLowerCase().includes(q)))
      .map((d) => ({ id: d.id, name: d.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _notifyTimeline(excerpt) {
    if (!this.config.timelineNotifications) return;
    this.homey.notifications.createNotification({ excerpt })
      .catch((err) => this.error('Timeline-Meldung fehlgeschlagen:', err));
  }

  // Verlauf-Tab: records the same edge-triggered events that already fire the Flow
  // triggers / timeline notice, so problems can be traced back after the fact.
  _recordEvent(type, { device, zone, detail } = {}) {
    this.eventLog.unshift({
      ts: Date.now(), type, device: device || '', zone: zone || '', detail: detail || null,
    });
    if (this.eventLog.length > MAX_LOG_ENTRIES) this.eventLog.length = MAX_LOG_ENTRIES;
    this.homey.settings.set(SETTINGS_KEY_EVENT_LOG, this.eventLog);
  }

  getLog() {
    return this.eventLog;
  }

  clearLog() {
    this.eventLog = [];
    this.homey.settings.set(SETTINGS_KEY_EVENT_LOG, this.eventLog);
    return this.eventLog;
  }

  // Manual escape hatch for the reporting-frequency history (see _recordUpdateStat) -
  // everything rebuilds itself from the next real update per device, so this is safe/cheap,
  // just a way to force a clean slate (e.g. after a device's actual reporting behaviour
  // changed for good, so old samples would only skew the recommendation).
  resetUpdateStats() {
    this._updateStats = {};
    this._updateStatsDirty = false;
    this.homey.settings.set(SETTINGS_KEY_UPDATE_STATS, this._updateStats);
    return this._updateStats;
  }

  // ---------------------------------------------------------------------
  // Realtime availability ("device_unavailable" trigger, delayed by the
  // configurable grace period - see _getUnavailableDelaySeconds)
  // ---------------------------------------------------------------------

  async _primeAvailabilityMap() {
    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    this._zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));

    this._availabilityMap.clear();
    this._confirmedUnavailable.clear();
    for (const device of Object.values(devices)) {
      if (this._isOwnDevice(device)) continue;
      const isAvailable = device.available !== false;
      this._availabilityMap.set(device.id, isAvailable);
      if (!isAvailable) {
        // Already down at startup - route through the same grace period a live
        // transition would get, so a Homey/app restart doesn't instantly count devices
        // that are simply still reconnecting. Confirmation is silent either way (no
        // trigger/log/timeline) since this isn't a transition we actually witnessed.
        const delaySeconds = this._getUnavailableDelaySeconds(device.id);
        if (delaySeconds > 0) {
          this._scheduleUnavailableConfirmation(device, delaySeconds, true);
        } else {
          this._confirmUnavailable(device, true);
        }
      }
    }

    // Prune "since" bookkeeping for anything that recovered while we weren't watching
    // (API was down, so _handleDeviceUpdate's own recovery cleanup never ran for it) -
    // otherwise the stale timestamp from that old outage would resurface the next time
    // this same device goes unavailable again (see _confirmUnavailable's "already
    // tracked, don't overwrite" guard).
    for (const id of Object.keys(this.problemSince.unavailable)) {
      if (!this._confirmedUnavailable.has(id) && !this._pendingUnavailableTimers.has(id)) {
        delete this.problemSince.unavailable[id];
      }
    }
    this._persistProblemSince();
  }

  async _connectRealtime() {
    await this.api.devices.connect();
    this.api.devices.on('device.update', (device) => this._handleDeviceUpdate(device));
  }

  _handleDeviceUpdate(device) {
    if (!device || !device.id || this._isOwnDevice(device)) return;

    const wasAvailable = this._availabilityMap.get(device.id);
    const isAvailable = device.available !== false;
    this._availabilityMap.set(device.id, isAvailable);

    if (wasAvailable === true && isAvailable === false) {
      const delaySeconds = this._getUnavailableDelaySeconds(device.id);
      if (delaySeconds > 0) {
        this._scheduleUnavailableConfirmation(device, delaySeconds);
      } else {
        this._confirmUnavailable(device);
      }
    }

    if (isAvailable === true) {
      // Recovery is never delayed - if it came back before the grace period elapsed,
      // this cancels the pending confirmation and nothing ever fired for it. If it was
      // already confirmed, clear that immediately (good news shouldn't wait either).
      this._cancelPendingUnavailableConfirmation(device.id);
      if (this._confirmedUnavailable.delete(device.id)) {
        delete this.problemSince.unavailable[device.id];
        this._persistProblemSince();
        this._updateWatchdogDevice({ unavailableCount: this._countUnavailable() })
          .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
        // Positive counterpart to the 'unavailable' entry recorded in _confirmUnavailable -
        // requested on the forum, so the log shows recoveries, not just problems. Mirrors
        // the same exclusion check _confirmUnavailable uses for the 'unavailable' entry
        // (see forum report: excluded devices were getting recovery log lines too).
        if (!this._isExcludedFromUnavailable(device.id)) {
          const zoneName = device.zone ? (this._zoneMap[device.zone] || '') : '';
          this._recordEvent('available', { device: device.name, zone: zoneName });
          this._queueAvailableAgainSummary(device.name || '');
        }
      }
    }

    this._recordUpdateStat(device);
  }

  // Appends this device's freshest capability timestamp to its rolling update-stats window,
  // if it's actually newer than the last one recorded - this fires on every scan pass too
  // (see _runScanInternal), not just genuine realtime changes, so the dedupe check matters.
  // Records which capability was freshest too (not just when), so the Settings UI can show
  // what actually reported, not just a bare timestamp.
  _recordUpdateStat(device) {
    if (!scanner.canCheckStaleness(device)) return;

    // Mirrors the same includeBatteryForReporting exclusion computeDeviceStatus applies
    // (lib/scanner.js:233-240) - without this, a device the user explicitly opted out of
    // counting battery updates toward "not reporting" would still have its stats/
    // recommendation skewed by a battery that reports independently of the actual (frozen)
    // sensor value, exactly the scenario that toggle exists to guard against.
    const { rule } = scanner.findRuleIndexed({ id: device.id }, this._ruleIndex);
    const includeBattery = rule ? rule.includeBatteryForReporting !== false : true;

    // An auto-heal test (_runAutoTests) re-sends a capability's own current value, which
    // typically bumps its lastUpdated the same as a real report would. Left uncorrected,
    // that would mask the true reporting gap on exactly the devices whose threshold most
    // needs raising - see AUTO_TEST_EXCLUSION_TTL_MS. Excluded here, not just deduped, so a
    // device with only that capability correctly records "nothing this pass" when it's
    // truly quiet, rather than falling back to the auto-test's own timestamp.
    let excludedCapId = null;
    const pendingExclusion = this._pendingAutoTestExclusion.get(device.id);
    if (pendingExclusion) {
      if (Date.now() - pendingExclusion.setAt > AUTO_TEST_EXCLUSION_TTL_MS) {
        this._pendingAutoTestExclusion.delete(device.id);
      } else {
        excludedCapId = pendingExclusion.capId;
      }
    }

    let freshest = null;
    let freshestCapId = null;
    for (const [capId, cap] of Object.entries(device.capabilitiesObj || {})) {
      if (!cap || !cap.lastUpdated) continue;
      if (!includeBattery && BATTERY_CAPABILITIES.includes(String(capId).split('.')[0])) continue;
      if (capId === excludedCapId) continue;
      const time = new Date(cap.lastUpdated).getTime();
      if (Number.isFinite(time) && (freshest === null || time > freshest)) {
        freshest = time;
        freshestCapId = capId;
      }
    }

    // The excluded capability's own timestamp catching up to/past setAt means the auto-test's
    // write has landed - consume the exclusion so future organic updates to it count again.
    if (pendingExclusion && excludedCapId) {
      const excludedCap = device.capabilitiesObj?.[excludedCapId];
      const excludedTime = excludedCap?.lastUpdated ? new Date(excludedCap.lastUpdated).getTime() : NaN;
      if (Number.isFinite(excludedTime) && excludedTime >= pendingExclusion.setAt) {
        this._pendingAutoTestExclusion.delete(device.id);
      }
    }

    if (freshest === null) return;

    const bucket = this._updateStats[device.id] || { entries: [], maxGapMs: null, firstSeenTs: null };
    const { entries } = bucket;
    const last = entries.length ? entries[entries.length - 1] : null;
    if (last && freshest <= last.ts) return;

    // Track the all-time max gap here, not just derived from `entries` at read time - see
    // the field comment on this._updateStats above for why that distinction matters.
    if (last) {
      const gap = freshest - last.ts;
      if (bucket.maxGapMs === null || gap > bucket.maxGapMs) bucket.maxGapMs = gap;
    }
    if (bucket.firstSeenTs === null) bucket.firstSeenTs = freshest;

    entries.push({ ts: freshest, capId: freshestCapId });
    if (entries.length > MAX_UPDATE_STATS_ENTRIES) entries.shift();
    this._updateStats[device.id] = bucket;
    this._updateStatsDirty = true;
  }

  _getUnavailableDelaySeconds(deviceId) {
    const { rule } = scanner.findRuleIndexed({ id: deviceId }, this._ruleIndex);
    const override = rule?.unavailableDelaySeconds;
    return (override != null ? override : this.config.unavailableDelaySeconds) || 0;
  }

  // Same idea as _getUnavailableDelaySeconds above, for the low-battery grace period -
  // see lowBatteryDelaySeconds in lib/defaults.js.
  _getLowBatteryDelaySeconds(deviceId) {
    const { rule } = scanner.findRuleIndexed({ id: deviceId }, this._ruleIndex);
    const override = rule?.lowBatteryDelaySeconds;
    return (override != null ? override : this.config.lowBatteryDelaySeconds) || 0;
  }

  _scheduleUnavailableConfirmation(device, delaySeconds, silent) {
    this._cancelPendingUnavailableConfirmation(device.id);
    const timer = this.homey.setTimeout(() => {
      this._pendingUnavailableTimers.delete(device.id);
      // Re-check current state - only proceed if it's still down after the grace period.
      if (this._availabilityMap.get(device.id) === false) this._confirmUnavailable(device, silent);
    }, delaySeconds * 1000);
    this._pendingUnavailableTimers.set(device.id, timer);
  }

  _cancelPendingUnavailableConfirmation(deviceId) {
    const timer = this._pendingUnavailableTimers.get(deviceId);
    if (timer) {
      this.homey.clearTimeout(timer);
      this._pendingUnavailableTimers.delete(deviceId);
    }
  }

  // Everything a confirmed (grace period elapsed, or delay=0) "unavailable" produces:
  // excludeAll ("monitored" off) means silent everywhere, full stop. Short of that, the
  // per-device trigger still always fires (opt-in - only noisy if the user builds a Flow
  // around this specific device); the summary/Timeline/log/count are the automatic,
  // passive outputs a chronically flaky device would otherwise spam repeatedly, so those
  // additionally respect the narrower "Ignore unavailable" per-device toggle too.
  // `silent` skips the trigger/log/timeline/summary entirely - used when priming at
  // startup confirms a device that was already down before the grace period even
  // started, so app restarts don't re-notify for an already-known, ongoing problem.
  _confirmUnavailable(device, silent) {
    this._confirmedUnavailable.add(device.id);

    if (!(device.id in this.problemSince.unavailable)) {
      // Priming an already-down device at startup: lastSeenAt is the last time it was
      // known good, a better "since" than the moment we merely noticed it on restart.
      this.problemSince.unavailable[device.id] = (silent && device.lastSeenAt)
        ? new Date(device.lastSeenAt).getTime()
        : Date.now();
      this._persistProblemSince();
    }

    if (!silent) {
      const zoneName = device.zone ? (this._zoneMap[device.zone] || '') : '';

      if (this._isMonitored(device.id)) {
        this._triggerUnavailable
          ?.trigger({ device: device.name || '', zone: zoneName || '' }, { deviceId: device.id })
          .catch((err) => this.error('Trigger device_unavailable fehlgeschlagen:', err));
      }

      if (!this._isExcludedFromUnavailable(device.id)) {
        this._recordEvent('unavailable', { device: device.name, zone: zoneName, detail: device.lastSeenAt || null });
        this._queueUnavailableSummary(device.name || '');
      }
    }

    this._updateWatchdogDevice({ unavailableCount: this._countUnavailable() })
      .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
  }

  _countUnavailable() {
    let count = 0;
    for (const deviceId of this._confirmedUnavailable) {
      if (!this._isExcludedFromUnavailable(deviceId)) count += 1;
    }
    return count;
  }

  // Settings UI's own "unavailable" stat/badge (used by getWidgetSummary too, indirectly,
  // via the same _confirmedUnavailable/_isExcludedFromUnavailable) - grace-period-confirmed
  // and exclusion-filtered, same as the count on the virtual Watchdog device, so the
  // Settings page can show an accurate "unavailable" count independent of the notReporting
  // scan threshold instead of only surfacing it when a device happens to be both.
  getUnavailableStatus() {
    const ids = Array.from(this._confirmedUnavailable).filter((id) => !this._isExcludedFromUnavailable(id));
    return { count: ids.length, ids };
  }

  _persistProblemSince() {
    this.homey.settings.set(SETTINGS_KEY_PROBLEM_SINCE, this.problemSince);
  }

  // excludeAll ("monitored" off) or an active seasonal pause - the conditions that
  // should silence a device absolutely everywhere, including its own opt-in per-device
  // trigger/condition. Used on its own (not via _isExcludedFromUnavailable) wherever
  // explicit per-device Flow usage should still work under the narrower "Ignore
  // unavailable" toggle.
  _isMonitored(deviceId) {
    const { rule } = scanner.findRuleIndexed({ id: deviceId }, this._ruleIndex);
    return !rule?.excludeAll && !scanner.isRulePaused(rule);
  }

  // A device with monitoring off entirely (excludeAll) or currently paused should stay
  // silent everywhere, not just for battery/reporting - not supposed to trip the
  // watchdog's "unavailable" count either. excludeFromUnavailable is the narrower opt-in
  // for "keep monitoring battery/reporting, just not unavailable" - used for the
  // passive/aggregate outputs (count, log, summary, widget), not for explicit per-device
  // Flow usage (see _isMonitored).
  _isExcludedFromUnavailable(deviceId) {
    const { rule } = scanner.findRuleIndexed({ id: deviceId }, this._ruleIndex);
    return !!rule?.excludeAll || !!rule?.excludeFromUnavailable || scanner.isRulePaused(rule);
  }

  // Pushes counts to the virtual "Watchdog status" device (drivers/watchdog), if the
  // user has paired one - so they show up in Homey Insights/dashboards and are usable
  // in Flows without our own cards. A no-op (not an error) if none has been added yet.
  async _updateWatchdogDevice(counts) {
    let devices;
    try {
      devices = this.homey.drivers.getDriver('watchdog').getDevices();
    } catch (err) {
      return; // driver not ready yet (e.g. called during very early onInit)
    }

    await Promise.all(devices.map((device) => device.updateCounts(counts)))
      .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
  }

  // Bundles devices that go unavailable within a few seconds of each other (e.g. a
  // mesh network hiccup) into a single summary trigger + timeline entry, instead of
  // firing/notifying once per device.
  _queueUnavailableSummary(name) {
    this._unavailableBatch.add(name);
    if (this._unavailableBatchTimer) return;

    this._unavailableBatchTimer = this.homey.setTimeout(() => {
      const names = Array.from(this._unavailableBatch);
      this._unavailableBatch.clear();
      this._unavailableBatchTimer = null;

      const devicesList = formatNameList(names, this.homey);

      this._triggerUnavailableSummary
        ?.trigger({ count: names.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_unavailable_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineUnavailable', { count: names.length, devices: devicesList }));
    }, 3000);
  }

  // Recovery counterpart to _queueUnavailableSummary above - same 3s bundling window, so
  // devices that come back within a few seconds of each other (e.g. a mesh network
  // reconnecting all at once) fire one summary trigger instead of one per device.
  _queueAvailableAgainSummary(name) {
    this._availableAgainBatch.add(name);
    if (this._availableAgainBatchTimer) return;

    this._availableAgainBatchTimer = this.homey.setTimeout(() => {
      const names = Array.from(this._availableAgainBatch);
      this._availableAgainBatch.clear();
      this._availableAgainBatchTimer = null;

      const devicesList = formatNameList(names, this.homey);

      this._triggerAvailableAgainSummary
        ?.trigger({ count: names.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_available_again_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineAvailableAgain', { count: names.length, devices: devicesList }));
    }, 3000);
  }

  // ---------------------------------------------------------------------
  // Interval scheduling
  // ---------------------------------------------------------------------

  _scheduleInterval({ runImmediately = false } = {}) {
    if (this._intervalTimer) {
      this.homey.clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
    if (this._startupGraceTimer) {
      this.homey.clearTimeout(this._startupGraceTimer);
      this._startupGraceTimer = null;
    }

    if (this.config.scanIntervalEnabled && this.config.scanIntervalMinutes > 0) {
      const ms = this.config.scanIntervalMinutes * 60 * 1000;
      this._intervalTimer = this.homey.setInterval(() => {
        this.runScan('interval').catch((err) => this.error('Intervall-Scan fehlgeschlagen:', err));
      }, ms);

      if (runImmediately) {
        // Startup transient guard: right after the app itself starts (Homey boot/restart,
        // app update), HomeyAPI's device cache may not be fully settled yet - scanning
        // immediately can produce a burst of spurious "not reporting" flags that clear up
        // a few minutes later on their own (see forum report). Only delays this very first
        // scan - manual scans and every later interval tick are unaffected.
        const graceMs = this.config.startupGraceMinutes * 60 * 1000;
        if (graceMs > 0) {
          this._startupGraceTimer = this.homey.setTimeout(() => {
            this._startupGraceTimer = null;
            this.runScan('interval').catch((err) => this.error('Initial-Scan fehlgeschlagen:', err));
          }, graceMs);
        } else {
          this.runScan('interval').catch((err) => this.error('Initial-Scan fehlgeschlagen:', err));
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // Config / rules (used by api.js)
  // ---------------------------------------------------------------------

  getConfig() {
    return { config: this.config, rules: this.rules };
  }

  // Comparable "did anything actually change" key for a persisted scan snapshot -
  // deliberately excludes generatedAt/source, which differ on every single scan
  // regardless of whether the actual results did.
  _scanSignature(scan) {
    if (!scan) return null;
    return JSON.stringify({
      all: scan.all, notReporting: scan.notReporting, lowBattery: scan.lowBattery,
    });
  }

  // Resets global config and all per-device rules back to defaults - e.g. to get back
  // to a clean slate while testing. Deliberately leaves the log/last-scan history alone,
  // those have their own dedicated "clear" controls with different semantics.
  async resetSettings() {
    return this.saveConfig({ config: { ...DEFAULT_CONFIG }, rules: [] });
  }

  // Per-device rules (matchType 'id') never get removed on their own when the device
  // itself is deleted from Homey - cleanupDeviceRule only fires on an active edit in the
  // Settings UI, never on removal. Over years of device churn that silently accumulates
  // dead entries (pointing at a device id that no longer exists) that just sit there
  // forever taking up space. 'name'/'pattern' rules aren't tied to a specific device id,
  // so they're never considered stale by this. Shared by getStaleRules (read-only preview)
  // and pruneStaleRules (actually removes them), so the two can never disagree about what
  // counts as stale.
  async _findStaleRules() {
    await this._ensureApi();
    const devices = await this.api.devices.getDevices({ $cache: false });
    const liveIds = new Set(Object.keys(devices));
    return this.rules.filter((rule) => rule.matchType === 'id' && !liveIds.has(rule.matchValue));
  }

  // Read-only preview for the Settings UI - lets "Clean up stale rules" show exactly which
  // devices it would affect before the user actually clicks it, instead of it being a
  // surprise. label falls back to the raw device id when empty (older rules, or ones
  // created without a device name at hand, don't always have one set).
  async getStaleRules() {
    const stale = await this._findStaleRules();
    return stale.map((rule) => ({ id: rule.id, label: rule.label || rule.matchValue }));
  }

  async pruneStaleRules() {
    const stale = await this._findStaleRules();

    if (stale.length > 0) {
      const staleIds = new Set(stale.map((rule) => rule.id));
      this._setRules(this.rules.filter((rule) => !staleIds.has(rule.id)));
      this.homey.settings.set(SETTINGS_KEY_RULES, this.rules);
    }

    return { removedCount: stale.length };
  }

  // Keeps this.rules and its lookup index (see lib/scanner.js buildRuleIndex) in lockstep -
  // the index is only ever valid for the exact array it was built from, so every write to
  // this.rules must go through here rather than assigning the field directly.
  _setRules(rules) {
    this.rules = rules;
    this._ruleIndex = scanner.buildRuleIndex(rules);
  }

  async saveConfig({ config, rules } = {}) {
    if (config && typeof config === 'object') {
      this.config = {
        ...DEFAULT_CONFIG,
        ...config,
        notReportingThresholdHours: positiveNumberOrDefault(
          config.notReportingThresholdHours, DEFAULT_CONFIG.notReportingThresholdHours,
        ),
        batteryThresholdPercent: rulesLib.percentOrNull(config.batteryThresholdPercent) ?? DEFAULT_CONFIG.batteryThresholdPercent,
        scanIntervalMinutes: positiveNumberOrDefault(config.scanIntervalMinutes, DEFAULT_CONFIG.scanIntervalMinutes),
        unavailableDelaySeconds: nonNegativeNumberOrDefault(
          config.unavailableDelaySeconds, DEFAULT_CONFIG.unavailableDelaySeconds,
        ),
        lowBatteryDelaySeconds: nonNegativeNumberOrDefault(
          config.lowBatteryDelaySeconds, DEFAULT_CONFIG.lowBatteryDelaySeconds,
        ),
        startupGraceMinutes: nonNegativeNumberOrDefault(
          config.startupGraceMinutes, DEFAULT_CONFIG.startupGraceMinutes,
        ),
        recommendationSafetyFactor: safetyFactorOrDefault(
          config.recommendationSafetyFactor, DEFAULT_CONFIG.recommendationSafetyFactor,
        ),
      };
      this.homey.settings.set(SETTINGS_KEY_CONFIG, this.config);
    }

    if (Array.isArray(rules)) {
      this._setRules(rules.map(rulesLib.sanitizeRule));
      this.homey.settings.set(SETTINGS_KEY_RULES, this.rules);

      // A rule change can flip a device's exclusion status (pause, "Ignore unavailable",
      // monitoring toggle) without its actual availability changing at all - e.g. pausing
      // a device that's genuinely, still offline. _confirmedUnavailable itself is only
      // ever added to/removed from on a real availability edge (_handleDeviceUpdate), so
      // without this, the virtual device's pushed counter/alarm can stay stuck showing a
      // now-excluded device as unavailable indefinitely - not even a full rescan corrects
      // it, since a scan's own _handleDeviceUpdate pass has the same edge-only condition
      // (confirmed live: forum + live report, Aug 2026). getUnavailableStatus() itself was
      // never affected by this - it always filters _isExcludedFromUnavailable fresh - only
      // this pushed capability value on the virtual device could go stale.
      await this._updateWatchdogDevice({ unavailableCount: this._countUnavailable() });
    }

    this._scheduleInterval({ runImmediately: false });

    return this.getConfig();
  }

  // Backs the "Pause device until date" Flow action - same effect as setting "Paused
  // until" under a device's Details, just reachable from a Flow. Routes through
  // saveConfig so it gets the exact same whitelist/validation/persistence as a Settings
  // UI save, instead of mutating this.rules directly.
  //
  // rescanNow (opt-in, only meaningful when pausing, not clearing a pause - see the
  // pause_device*/resume_device run listeners): saveConfig alone never re-evaluates
  // anything, so a device that's currently flagged stays reflected in the counts/virtual
  // device alarm/widget until the next scheduled or manual scan - forum feedback wanted a
  // way to force that catch-up immediately instead of waiting. Reuses the exact same
  // runScan() the "Run device scan now" action/button already use, rather than
  // hand-rolling a narrower per-device reconcile - simpler and already battle-tested for
  // this multi-device install.
  async pauseDevice(deviceId, pausedUntil, { rescanNow = false } = {}) {
    await this._ensureApi();
    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) throw new Error(this.homey.__('backend.deviceNotFound'));

    const { rule } = scanner.findRuleIndexed({ id: deviceId }, this._ruleIndex);
    // Clearing a pause (pausedUntil falsy) on a device with no existing rule at all has
    // nothing to do - skip creating a rule that would only ever hold a null pause.
    if (!rule && !pausedUntil) return;

    const rules = rule
      ? this.rules.map((r) => (r === rule ? { ...r, pausedUntil } : r))
      : [...this.rules, {
        matchType: 'id', matchValue: deviceId, label: device.name, pausedUntil,
      }];

    await this.saveConfig({ rules });

    if (rescanNow) await this.runScan('flow');
  }

  // ---------------------------------------------------------------------
  // Devices / status (used by api.js)
  // ---------------------------------------------------------------------

  async _ensureApi() {
    if (this.api) return this.api;

    try {
      this.api = await HomeyAPI.createAppAPI({ homey: this.homey });
      this._apiInitError = null;
      await this._primeAvailabilityMap();
      await this._connectRealtime();
    } catch (err) {
      this._apiInitError = err;
      this.error('HomeyAPI-Initialisierung erneut fehlgeschlagen:', err);
      throw new Error(`HomeyAPI nicht verfügbar: ${err.message}`);
    }

    return this.api;
  }

  async getRawDevices() {
    await this._ensureApi();

    const devices = await this.api.devices.getDevices();
    const zones = await this.api.zones.getZones();
    const zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));
    // Mirrors Homey's own zone-tree order (see lib/scanner.js), so the Settings UI
    // can group devices by zone in the same order they appear in the Homey app.
    const zoneOrderMap = scanner.buildZoneOrderMap(zones);
    // Resolve real app display names (e.g. "Z-Wave") for the "Verwaltet von" info line,
    // instead of showing the raw app id. Best-effort: if this fails (e.g. missing scope),
    // devices simply fall back to their raw ownerUri app id further down the chain.
    const appNameMap = await this._getAppNameMap();

    // Current problem state, for the per-device "what to do" recommendation
    // (scanner.deviceRecommendation). Category priority matches the Settings badge:
    // unavailable > not reporting > low battery.
    const notReportingSet = new Set(this.lastScan ? this.lastScan.notReporting : []);
    const lowBatterySet = new Set(this.lastScan ? this.lastScan.lowBattery : []);
    const unavailableSet = new Set(
      Array.from(this._confirmedUnavailable).filter((id) => !this._isExcludedFromUnavailable(id)),
    );
    // Keyed by ownerUri + driverId, not just ownerUri: an app can expose multiple
    // drivers with unrelated failure domains (e.g. Shelly's LAN vs. BLE devices),
    // so lumping them together would overcount how many peers are actually down.
    const unavailableByOwner = {};
    for (const id of unavailableSet) {
      const device = devices[id];
      const owner = device && device.ownerUri;
      if (!owner) continue;
      const key = `${owner}::${device.driverId || ''}`;
      unavailableByOwner[key] = (unavailableByOwner[key] || 0) + 1;
    }

    return Object.values(devices)
      .filter((device) => !this._isOwnDevice(device))
      .map((device) => {
        const ownerAppId = device.ownerUri ? device.ownerUri.replace(/^homey:app:/, '') : null;
        const { rule } = scanner.findRuleIndexed({ id: device.id }, this._ruleIndex);
        const testCapability = this._findTestCapability(device);

        let category = null;
        if (unavailableSet.has(device.id)) category = 'unavailable';
        else if (notReportingSet.has(device.id)) category = 'notReporting';
        else if (lowBatterySet.has(device.id)) category = 'lowBattery';

        let recommendation = null;
        if (category) {
          const ownerUnavail = device.ownerUri
            ? (unavailableByOwner[`${device.ownerUri}::${device.driverId || ''}`] || 0)
            : 0;
          recommendation = scanner.deviceRecommendation(device, {
            category,
            thresholdHrs: (rule && rule.notReportingHours) || this.config.notReportingThresholdHours,
            testCapability,
            unavailablePeersSameApp: category === 'unavailable' ? Math.max(0, ownerUnavail - 1) : ownerUnavail,
          });
        }

        return {
          id: device.id,
          name: device.name,
          zone: device.zone ? (zoneMap[device.zone] || null) : null,
          zoneOrder: device.zone && zoneOrderMap[device.zone] !== undefined ? zoneOrderMap[device.zone] : Number.MAX_SAFE_INTEGER,
          class: device.class || null,
          available: device.available !== false,
          testCapability,
          hasBattery: BATTERY_CAPABILITIES.some((id) => (device.capabilities || []).includes(id)),
          // Raw battery capability timestamp, shown in the Settings UI's battery details
          // next to the "count battery toward reporting" toggle - independent of whether
          // that toggle is on, so the user can see it before deciding.
          batteryLastUpdated: (device.capabilitiesObj?.measure_battery?.lastUpdated
            || device.capabilitiesObj?.alarm_battery?.lastUpdated) || null,
          // Driver-declared, not computed by Homey - many apps never set this, so it's
          // frequently null even for a device that clearly has a battery. Raw array (one
          // entry per physical cell, e.g. ["AA","AA"]) - left unformatted for callers to
          // group/translate as needed. energyObj is the one that's actually reliably
          // populated (confirmed against real devices: every device with energy.batteries
          // set also has the identical value in energyObj.batteries, but not vice versa -
          // 41 of 66 battery devices on one real Homey had it ONLY in energyObj) - energy
          // is kept as a fallback in case some driver/API version reverses that.
          batteryTypes: (device.energyObj && device.energyObj.batteries) || (device.energy && device.energy.batteries) || null,
          // Free-text per-device override (see saveConfig) for devices where Homey has
          // nothing at all - takes precedence over batteryTypes on the frontend.
          batteryTypeOverride: rule && rule.batteryTypeOverride ? rule.batteryTypeOverride : null,
          ownerUri: device.ownerUri || null,
          ownerAppName: ownerAppId ? (appNameMap[ownerAppId] || null) : null,
          driverId: device.driverId || null,
          lastSeenAt: device.lastSeenAt || null,
          // False for devices that can never carry a capability timestamp (only a
          // momentary `button` capability, e.g. virtual scene-trigger devices) - the
          // Settings UI shows a "no staleness check possible" note for these instead of
          // ever flagging them "not reporting". Same helper the scan itself uses.
          stalenessCheckable: scanner.canCheckStaleness(device),
          // { key, params } short "what to do" hint, only for a currently-flagged device;
          // null otherwise. The Settings UI turns the key into localized copy.
          recommendation,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async _getAppNameMap() {
    try {
      const apps = await this.api.apps.getApps();
      const map = {};
      for (const [key, app] of Object.entries(apps || {})) {
        const name = typeof app.name === 'string' ? app.name : (app.name && (app.name.en || Object.values(app.name)[0]));
        if (name) {
          map[key] = name;
          if (app.id) map[app.id] = name;
        }
      }
      return map;
    } catch (err) {
      this.error('Konnte App-Namen nicht laden:', err);
      return {};
    }
  }

  // Which (if any) TESTABLE_CAPABILITIES entry a device has - shared by the manual "Test"
  // button (getRawDevices/testDevice) and the scan-time auto-test pass (_runAutoTests).
  // Matches multi-instance capabilities too (e.g. a siren's "onoff.siren", not just a bare
  // "onoff") - the base id is what TESTABLE_CAPABILITIES lists, but the *full* id
  // (including the ".instance" suffix) is what actually has to be passed to
  // setCapabilityValue/capabilitiesObj, so that's what gets returned here.
  _findTestCapability(device) {
    const capabilities = device.capabilities || [];
    for (const base of TESTABLE_CAPABILITIES) {
      const match = capabilities.find((id) => id === base || id.startsWith(`${base}.`));
      if (match) return match;
    }
    return null;
  }

  // The actual reachability round-trip: re-sends a testable capability's own current value.
  // Throws (same errors testDevice already surfaced) if the device has nothing testable or
  // no current value to resend; otherwise awaits the round-trip and returns what was tested.
  async _performCapabilityTest(device) {
    const capabilityId = this._findTestCapability(device);
    if (!capabilityId) throw new Error(this.homey.__('backend.noTestableCapability'));

    const currentValue = device.capabilitiesObj?.[capabilityId]?.value;
    if (currentValue === undefined || currentValue === null) throw new Error(this.homey.__('backend.noCurrentValue'));

    await device.setCapabilityValue({ capabilityId, value: currentValue });
    return { capabilityId, value: currentValue };
  }

  async testDevice(deviceId) {
    await this._ensureApi();

    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) throw new Error(this.homey.__('backend.deviceNotFound'));

    const zoneName = device.zone ? (this._zoneMap[device.zone] || '') : '';

    try {
      const { capabilityId, value } = await this._performCapabilityTest(device);

      this._recordEvent('testSuccess', { device: device.name, zone: zoneName });
      this._triggerTestSucceeded
        ?.trigger({ device: device.name || '', zone: zoneName || '' }, { deviceId: device.id })
        .catch((triggerErr) => this.error('Trigger device_test_succeeded fehlgeschlagen:', triggerErr));
      return { ok: true, capabilityId, value };
    } catch (err) {
      this._recordEvent('testFailure', { device: device.name, zone: zoneName, detail: err.message });
      this._triggerTestFailed
        ?.trigger({ device: device.name || '', zone: zoneName || '', error: err.message || '' }, { deviceId: device.id })
        .catch((triggerErr) => this.error('Trigger device_test_failed fehlgeschlagen:', triggerErr));
      throw err;
    }
  }

  // Raw per-capability snapshot for a single device (id/title/type/value/units/lastUpdated),
  // the same data Homey's own Developer Tools shows. Fetched on demand (not part of
  // getRawDevices, which is already sent for every device on every load) since this is
  // only ever needed for the one device whose "Capabilities" panel is actually expanded.
  async getDeviceCapabilities(deviceId) {
    await this._ensureApi();

    const device = await this.api.devices.getDevice({ id: deviceId });
    if (!device) throw new Error(this.homey.__('backend.deviceNotFound'));

    const capsObj = device.capabilitiesObj || {};
    return Object.keys(capsObj).sort().map((capId) => {
      const cap = capsObj[capId] || {};
      return {
        id: capId,
        title: cap.title || capId,
        type: cap.type || null,
        value: cap.value === undefined ? null : cap.value,
        units: cap.units || null,
        lastUpdated: cap.lastUpdated || null,
        // Lets the Settings UI mirror the same "does this capability even count toward
        // staleness" rule the scan itself uses (lib/scanner.js#canCheckStaleness) when
        // colouring each row - a write-only capability never carries a meaningful
        // lastUpdated, so it shouldn't be judged fresh/stale either.
        getable: cap.getable !== false,
      };
    });
  }

  // Reporting-frequency summary for a single device, derived from its rolling update-stats
  // window (see _recordUpdateStat) - purely computed from already-in-memory data, no
  // HomeyAPI round trip needed. Fetched on demand, same reasoning as getDeviceCapabilities
  // above: only ever needed for the one Details panel actually open.
  async getDeviceUpdateStats(deviceId) {
    const bucket = this._updateStats[deviceId] || { entries: [], maxGapMs: null, firstSeenTs: null };
    return {
      ...scanner.computeUpdateStats(bucket.entries, bucket.maxGapMs, this.config.recommendationSafetyFactor),
      firstSeenTs: bucket.firstSeenTs,
    };
  }

  // Same computation as getDeviceUpdateStats, for every device at once - used by the
  // Settings UI's "Empfehlungen" tab, which needs every device's recommendation to build
  // its list. Skips `entries` (only useful for the one-device Details view, would just be
  // dead weight repeated across ~300 devices in one response) and any device with nothing
  // recorded yet at all. firstSeenTs lets that tab filter out a device that's only been
  // observed for a few minutes, even if it already has 5+ samples - a user-configurable
  // "minimum observation period" there.
  async getAllUpdateStats() {
    const result = {};
    for (const [deviceId, bucket] of Object.entries(this._updateStats)) {
      const {
        avgIntervalMs, maxIntervalMs, recommendedHours,
      } = scanner.computeUpdateStats(bucket.entries, bucket.maxGapMs, this.config.recommendationSafetyFactor);
      if (recommendedHours == null) continue;
      result[deviceId] = {
        avgIntervalMs, maxIntervalMs, recommendedHours, firstSeenTs: bucket.firstSeenTs,
      };
    }
    return result;
  }

  getStatus() {
    return {
      config: this.config,
      lastScan: this.lastScan,
    };
  }

  // Widget-facing summary: same counts/alarm as the Watchdog status device tile, plus
  // (unlike that capability-only tile) which devices are actually affected, since when,
  // and a category-specific detail.
  async getWidgetSummary() {
    const rawDevices = await this.getRawDevices();
    const rawById = Object.fromEntries(rawDevices.map((d) => [d.id, d]));
    const scanById = Object.fromEntries((this.lastScan?.all || []).map((d) => [d.id, d]));

    // Always one entry per flagged id, even if the device vanished from the live list
    // between the scan/confirmation and now (renamed/removed edge case) - silently
    // dropping it here would leave the detail list short of what the count promises.
    const buildEntries = (ids, category, extra) => ids
      .map((id) => {
        const raw = rawById[id] || null;
        return {
          id,
          name: raw ? raw.name : id,
          zone: raw ? raw.zone : null,
          since: this.problemSince[category][id] || null,
          ...extra(raw, id),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const notReportingIds = this.lastScan?.notReporting || [];
    const lowBatteryIds = this.lastScan?.lowBattery || [];
    const unavailableIds = Array.from(this._confirmedUnavailable)
      .filter((id) => !this._isExcludedFromUnavailable(id));

    // scanById is keyed from the same scan notReportingIds/lowBatteryIds came from, so
    // it's looked up by the entry's own id - independent of whether the raw live device
    // lookup above succeeded.
    const notReporting = buildEntries(notReportingIds, 'notReporting', (raw, id) => ({
      lastUpdated: scanById[id]?.lastUpdated || null,
    }));
    const lowBattery = buildEntries(lowBatteryIds, 'lowBattery', (raw, id) => ({
      battery: scanById[id]?.battery || null,
      batteryValue: scanById[id]?.batteryValue ?? null,
      batteryTypes: raw ? raw.batteryTypes : null,
      batteryTypeOverride: raw ? raw.batteryTypeOverride : null,
    }));
    const unavailable = buildEntries(unavailableIds, 'unavailable', (raw) => ({
      lastSeenAt: raw ? raw.lastSeenAt || null : null,
    }));

    const counts = {
      notReporting: notReportingIds.length,
      lowBattery: lowBatteryIds.length,
      unavailable: unavailableIds.length,
    };

    // Same formula as WatchdogDevice.updateCounts (drivers/watchdog/device.js), so the
    // widget's alarm state always matches the paired device tile's.
    const alarm = (this.config.alarmIncludesNotReporting !== false && counts.notReporting > 0)
      || (this.config.alarmIncludesUnavailable !== false && counts.unavailable > 0)
      || (this.config.alarmIncludesLowBattery !== false && counts.lowBattery > 0);

    return {
      lastScanAt: this.lastScan?.generatedAt || null,
      counts,
      alarm,
      notReporting,
      lowBattery,
      unavailable,
    };
  }

  // ---------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------

  async runScan(source = 'manual') {
    // De-dupe concurrent scan requests (interval + flow + settings button firing close together).
    if (this._scanPromise) return this._scanPromise;

    this._scanPromise = this._runScanInternal(source).finally(() => {
      this._scanPromise = null;
    });

    return this._scanPromise;
  }

  async _runScanInternal(source) {
    await this._ensureApi();

    this.log(`Starte Scan (Quelle: ${source})`);

    // $cache: false - once realtime-connected, getDevices() normally just returns the
    // in-memory cache and relies entirely on realtime events to keep it fresh. A missed
    // event (seen with a Bluetooth-relayed device) then leaves it stale forever, and a
    // "scan" would silently re-check the same stale snapshot. A scan should always see
    // the real current state, so this bypasses that cache explicitly.
    const rawDevices = await this.api.devices.getDevices({ $cache: false });
    const zones = await this.api.zones.getZones();
    this._zoneMap = Object.fromEntries(Object.values(zones).map((z) => [z.id, z.name]));

    // Extra safety net on top of _checkRealtimeConnection: catches a missed transition
    // immediately on every scan instead of waiting for the next healthcheck tick.
    const devices = {};
    for (const [id, device] of Object.entries(rawDevices)) {
      if (this._isOwnDevice(device)) continue;
      devices[id] = device;
      this._handleDeviceUpdate(device);
    }

    // A device deleted from Homey while it was confirmed-unavailable (or still mid-grace-
    // period) is never revisited by _handleDeviceUpdate above - that loop only runs for
    // devices that still exist. Left alone, its id sits in _confirmedUnavailable forever
    // (only a full app restart re-primes the whole map from scratch, via
    // _primeAvailabilityMap), inflating getUnavailableStatus()'s count/list - and the
    // widget/virtual device counters, which read the same set - past what's actually still
    // on Homey (confirmed live: 3 of 4 "unavailable" ids pointing at long-deleted devices).
    // Reconcile against the very device set this scan just fetched.
    let unavailablePruned = false;
    for (const id of Array.from(this._confirmedUnavailable)) {
      if (id in devices) continue;
      this._confirmedUnavailable.delete(id);
      this._availabilityMap.delete(id);
      delete this.problemSince.unavailable[id];
      unavailablePruned = true;
    }
    for (const id of Array.from(this._pendingUnavailableTimers.keys())) {
      if (!(id in devices)) this._cancelPendingUnavailableConfirmation(id);
    }
    if (unavailablePruned) {
      this._persistProblemSince();
      this._updateWatchdogDevice({ unavailableCount: this._countUnavailable() })
        .catch((err) => this.error('Watchdog-Gerät-Update fehlgeschlagen:', err));
    }

    // Same reconciliation as _confirmedUnavailable above, for the update-stats history -
    // a deleted device's entry would otherwise sit in settings forever.
    for (const id of Object.keys(this._updateStats)) {
      if (!(id in devices)) {
        delete this._updateStats[id];
        this._updateStatsDirty = true;
      }
    }

    const result = scanner.runScan({
      devices, zones, rules: this.rules, config: this.config,
    });

    // Opt-in "test before you alarm": for devices that would otherwise be newly/still
    // flagged this cycle, give them one live reachability nudge first - see _runAutoTests.
    await this._runAutoTests(result, devices);

    // Persisted/exposed scan snapshot is intentionally much leaner than `result`:
    // the Settings UI and condition cards only ever read id/status/battery/lastUpdated
    // per device and device ids for the not-reporting/low-battery lists - name, zone,
    // class, availability, and the (fully derivable, unused) `excluded` list would just
    // be duplicated write volume on every scan for no benefit. `result` itself stays
    // full for _fireEdgeTriggers below, which does need those fields.
    this.lastScan = {
      generatedAt: result.generatedAt,
      source,
      all: result.all.map((d) => ({
        id: d.id, status: d.status, battery: d.battery, lastUpdated: d.lastUpdated,
      })),
      notReporting: result.notReporting.map((d) => d.id),
      lowBattery: result.lowBattery.map((d) => d.id),
    };
    // Only actually write to settings storage when the substantive result changed -
    // the in-memory copy above is always fresh regardless (live consumers, e.g. the
    // Settings UI's "last scan" timestamp, are unaffected), this only skips redundant
    // disk writes when a scan finds exactly the same thing as the previous one.
    const scanSignature = this._scanSignature(this.lastScan);
    if (scanSignature !== this._lastPersistedScanSignature) {
      this._lastPersistedScanSignature = scanSignature;
      this.homey.settings.set(SETTINGS_KEY_LAST_SCAN, this.lastScan);
    }

    // Batched like lastScan above, not written on every realtime event - see
    // _recordUpdateStat/_updateStatsDirty.
    if (this._updateStatsDirty) {
      this.homey.settings.set(SETTINGS_KEY_UPDATE_STATS, this._updateStats);
      this._updateStatsDirty = false;
    }

    // lowBatteryCount is deliberately NOT set here - _fireEdgeTriggers below applies the
    // confirmation delay first (see _getLowBatteryDelaySeconds) and updates it itself,
    // same as unavailableCount is only ever updated via _confirmUnavailable /
    // _handleDeviceUpdate rather than from the raw per-scan count.
    await this._updateWatchdogDevice({
      notReportingCount: result.notReporting.length,
    });

    await this._fireEdgeTriggers(result);

    // Names, not just counts - a submitted diagnostic report only shows this log buffer,
    // and "9 offline" alone gives zero clue which devices unless the user separately
    // describes them. Capped so a large flagged set doesn't blow up the log line.
    const nameList = (entries) => {
      const names = entries.map((d) => d.name);
      const extra = names.length - 10;
      return names.length ? ` (${names.slice(0, 10).join(', ')}${extra > 0 ? ` +${extra} weitere` : ''})` : '';
    };
    this.log(`Scan abgeschlossen: ${result.all.length} Geräte, ${result.notReporting.length} offline${nameList(result.notReporting)}, ${result.lowBattery.length} Batteriewarnungen${nameList(result.lowBattery)}`);

    return this.lastScan;
  }

  // Opt-in per-device feature (rule.autoTestOnStale): a device that would otherwise be
  // counted as "not reporting" this cycle instead gets one live capability round-trip
  // first (same mechanism as the manual "Test" button/action card). A successful test is
  // treated as a genuine sign of life - the entry is pulled back out of result.notReporting
  // (and result.all, same object references) before any of the counting/alarming below
  // ever sees it, so a device that only ever "speaks" when nudged (e.g. some sirens) never
  // has to be kept alive by an external script or a manually-built Flow. A failed test
  // (or a device with no testable capability at all) is left untouched - it falls straight
  // through to the normal not-reporting handling in _fireEdgeTriggers, exactly as before
  // this feature existed.
  //
  // Always logged either way (heal or not), so a device that needs this every single scan
  // - which is expected and fine for a "silent by design" device - stays discoverable
  // rather than just silently never alarming again. The per-device Flow trigger only fires
  // on heal if the user opted into that too (rule.autoTestTriggerOnHeal) - off by default,
  // since the whole point for most users is exactly to NOT be notified for these.
  async _runAutoTests(result, devices) {
    // Look the rule up once per entry here (not again inside the map below) - findRule is
    // O(1) now (see buildRuleIndex), but there's no reason to pay it twice regardless.
    const candidates = result.notReporting
      .map((entry) => ({ entry, rule: scanner.findRuleIndexed(entry, this._ruleIndex).rule }))
      .filter(({ rule }) => !!(rule && rule.autoTestOnStale));
    if (!candidates.length) return;

    await Promise.all(candidates.map(async ({ entry, rule }) => {
      const device = devices[entry.id];
      if (!device) return;

      const zoneName = entry.zone || '';
      const staleSince = entry.lastUpdated;

      try {
        const { capabilityId } = await this._performCapabilityTest(device);
        this._pendingAutoTestExclusion.set(device.id, { capId: capabilityId, setAt: Date.now() });

        entry.status = 'OK';
        entry.lastUpdated = scanner.formatDate(new Date());
        const idx = result.notReporting.indexOf(entry);
        if (idx !== -1) result.notReporting.splice(idx, 1);

        this._recordEvent('autoTestHeal', { device: entry.name, zone: zoneName });

        if (rule.autoTestTriggerOnHeal) {
          await this._triggerNotReporting
            ?.trigger({ device: entry.name || '', zone: zoneName, last_updated: staleSince || '' }, { deviceId: entry.id })
            .catch((err) => this.error('Trigger device_not_reporting (Auto-Test-Heal) fehlgeschlagen:', err));
        }
      } catch (err) {
        // Test itself failed - device really is unresponsive, not just quiet. Nothing to
        // do here: leave the entry in result.notReporting exactly as-is, so the normal
        // path below alarms it like any other not-reporting device.
        this.log(`Auto-Test für ${entry.name} fehlgeschlagen: ${err.message}`);
      }
    }));
  }

  async _fireEdgeTriggers(result) {
    const prevNotReporting = new Set(this.flagState.notReporting || []);
    const prevLowBattery = new Set(this.flagState.lowBattery || []);
    // Delay-confirmed subset of prevLowBattery (see _getLowBatteryDelaySeconds) - kept
    // separate from the raw set above so a device isn't re-fired every scan once
    // confirmed, and so the recovery logging below only fires for devices that were
    // actually confirmed/alerted, not every transient blip that recovered on its own
    // before its grace period even elapsed.
    const prevLowBatteryConfirmed = new Set(this.flagState.lowBatteryConfirmed || []);
    const nowNotReporting = new Set(result.notReporting.map((d) => d.id));
    const nowLowBattery = new Set(result.lowBattery.map((d) => d.id));

    const newlyNotReporting = result.notReporting.filter((d) => !prevNotReporting.has(d.id));
    // Raw newly-low-battery this scan, before any grace period - only used below to stamp
    // problemSince.lowBattery, the "since" anchor the confirmation check (below) measures
    // from. Everything user-facing (trigger/log/timeline/summary/virtual device counter)
    // waits for newlyLowBatteryConfirmed instead.
    const newlyLowBattery = result.lowBattery.filter((d) => !prevLowBattery.has(d.id));

    // A previously-flagged device only counts as genuinely resolved (recovered, "since"
    // cleared) if THIS scan actually re-evaluated it - i.e. it's present in `all`. One
    // that's simply missing from this round's results (a transient HomeyAPI hiccup, say)
    // is left exactly as it was instead of being silently dropped, so a later scan that
    // does see it again can still catch the real recovery - otherwise that device's
    // problem history is just lost, no log entry ever written.
    const scannedIds = new Set(result.all.map((d) => d.id));
    // Wider set for the flagState carry-forward below: also counts devices excluded by a
    // rule this round (present, just intentionally skipped) as "accounted for" - those
    // should still cleanly drop out (no forced-forever carry just because a device got
    // excluded), unlike a device missing from both because it's genuinely gone/hiccuped.
    const knownIds = new Set([...result.all, ...result.excluded].map((d) => d.id));

    // Positive counterpart to newlyNotReporting/newlyLowBattery, for the log only (no Flow
    // triggers/Timeline for these, wasn't asked for) - requested on the forum, so users see
    // recoveries, not just problems.
    const allById = new Map(result.all.map((d) => [d.id, d]));
    const recoveredNotReporting = [...prevNotReporting]
      .filter((id) => scannedIds.has(id) && !nowNotReporting.has(id))
      .map((id) => allById.get(id)).filter(Boolean);
    // Sourced from prevLowBatteryConfirmed (not the raw prevLowBattery) - a device that
    // was only ever a candidate, never actually confirmed/alerted, has nothing to
    // "recover" from as far as the log is concerned (see forum report re: transient
    // battery blips).
    const recoveredLowBattery = [...prevLowBatteryConfirmed]
      .filter((id) => scannedIds.has(id) && !nowLowBattery.has(id))
      .map((id) => allById.get(id)).filter(Boolean);
    for (const device of recoveredNotReporting) {
      this._recordEvent('notReportingRecovered', { device: device.name, zone: device.zone });
    }
    for (const device of recoveredLowBattery) {
      this._recordEvent('lowBatteryRecovered', { device: device.name, zone: device.zone });
    }

    if (recoveredNotReporting.length) {
      const devicesList = formatNameList(recoveredNotReporting.map((d) => d.name), this.homey);

      await this._triggerReportingAgainSummary
        ?.trigger({ count: recoveredNotReporting.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_reporting_again_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineReportingAgain', { count: recoveredNotReporting.length, devices: devicesList }));
    }

    if (recoveredLowBattery.length) {
      const devicesList = formatNameList(recoveredLowBattery.map((d) => d.name), this.homey);

      await this._triggerBatteryOkAgainSummary
        ?.trigger({ count: recoveredLowBattery.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_battery_ok_again_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineBatteryOkAgain', { count: recoveredLowBattery.length, devices: devicesList }));
    }

    // "Since" bookkeeping for the widget detail view - set when a device newly enters a
    // category, cleared when it leaves again (independent of the trigger/log logic below).
    // Deliberately stays instantaneous/raw (not delay-gated) - same as the widget itself,
    // and it's the anchor the low-battery confirmation check right below measures from.
    for (const id of prevNotReporting) {
      if (scannedIds.has(id) && !nowNotReporting.has(id)) delete this.problemSince.notReporting[id];
    }
    for (const id of prevLowBattery) {
      if (scannedIds.has(id) && !nowLowBattery.has(id)) delete this.problemSince.lowBattery[id];
    }
    for (const device of newlyNotReporting) this.problemSince.notReporting[device.id] = Date.now();
    for (const device of newlyLowBattery) this.problemSince.lowBattery[device.id] = Date.now();

    // Low-battery confirmation (mirrors the unavailable grace period - see
    // _getLowBatteryDelaySeconds): a device already confirmed on a previous scan stays
    // confirmed for as long as it's still in this scan's raw low-battery set; a device
    // seen low for the first time (or still pending) only confirms once problemSince has
    // aged past its configured delay. A device that recovers before ever reaching this
    // never fires anything below - exactly the transient-blip case this exists to filter.
    const nowLowBatteryConfirmed = new Set();
    for (const device of result.lowBattery) {
      if (prevLowBatteryConfirmed.has(device.id)) {
        nowLowBatteryConfirmed.add(device.id);
        continue;
      }
      const since = this.problemSince.lowBattery[device.id];
      const delayMs = this._getLowBatteryDelaySeconds(device.id) * 1000;
      if (since != null && Date.now() - since >= delayMs) nowLowBatteryConfirmed.add(device.id);
    }
    const newlyLowBatteryConfirmed = result.lowBattery
      .filter((d) => nowLowBatteryConfirmed.has(d.id) && !prevLowBatteryConfirmed.has(d.id));

    for (const device of newlyNotReporting) {
      await this._triggerNotReporting
        ?.trigger({
          device: device.name || '',
          zone: device.zone || '',
          last_updated: device.lastUpdated || '',
        }, { deviceId: device.id })
        .catch((err) => this.error('Trigger device_not_reporting fehlgeschlagen:', err));

      this._recordEvent('notReporting', { device: device.name, zone: device.zone, detail: device.lastUpdated });
    }

    for (const device of newlyLowBatteryConfirmed) {
      await this._triggerBatteryLow
        ?.trigger({
          device: device.name || '',
          zone: device.zone || '',
          battery: device.battery || '',
        }, { deviceId: device.id })
        .catch((err) => this.error('Trigger device_battery_low fehlgeschlagen:', err));

      this._recordEvent('lowBattery', { device: device.name, zone: device.zone, detail: device.battery });
    }

    if (newlyNotReporting.length) {
      const devicesList = formatNameList(newlyNotReporting.map((d) => d.name), this.homey);

      await this._triggerNotReportingSummary
        ?.trigger({ count: newlyNotReporting.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_not_reporting_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineNotReporting', { count: newlyNotReporting.length, devices: devicesList }));
    }

    if (newlyLowBatteryConfirmed.length) {
      const devicesList = formatNameList(newlyLowBatteryConfirmed.map((d) => d.name), this.homey);

      await this._triggerBatteryLowSummary
        ?.trigger({ count: newlyLowBatteryConfirmed.length, devices: devicesList })
        .catch((err) => this.error('Trigger devices_low_battery_summary fehlgeschlagen:', err));

      this._notifyTimeline(this.homey.__('backend.timelineLowBattery', { count: newlyLowBatteryConfirmed.length, devices: devicesList }));
    }

    // Carry forward anything genuinely missing from this round entirely (see knownIds
    // above) - a device excluded by rule this round still cleanly drops out below, same
    // as before this fix; only a device Homey didn't account for at all keeps its old
    // flagged state until a future scan can actually re-confirm it one way or the other.
    const carriedNotReporting = [...prevNotReporting].filter((id) => !knownIds.has(id));
    const carriedLowBattery = [...prevLowBattery].filter((id) => !knownIds.has(id));
    const carriedLowBatteryConfirmed = [...prevLowBatteryConfirmed].filter((id) => !knownIds.has(id));

    this.flagState = {
      notReporting: [...result.notReporting.map((d) => d.id), ...carriedNotReporting],
      lowBattery: [...result.lowBattery.map((d) => d.id), ...carriedLowBattery],
      lowBatteryConfirmed: [...nowLowBatteryConfirmed, ...carriedLowBatteryConfirmed],
    };
    this.homey.settings.set(SETTINGS_KEY_FLAG_STATE, this.flagState);

    // Keep problemSince.notReporting / .lowBattery from silently accumulating orphans.
    // The recovery loops above only prune an entry when the device is still in flagState
    // AND was re-scanned this round (scannedIds = result.all only). A device that instead
    // gets excluded or paused while flagged leaves flagState cleanly (it's in knownIds,
    // so not carried) but its problemSince entry is skipped (it's in result.excluded, not
    // scannedIds) - so it would sit there forever. Enforce the invariant directly: these
    // maps only ever hold ids that are currently flagged. (problemSince.unavailable is
    // managed separately and already self-heals in _primeAvailabilityMap.)
    const pruneSince = (map, keepIds) => {
      const keep = new Set(keepIds);
      for (const key of Object.keys(map)) {
        if (!keep.has(key)) delete map[key];
      }
    };
    pruneSince(this.problemSince.notReporting, this.flagState.notReporting);
    pruneSince(this.problemSince.lowBattery, this.flagState.lowBattery);

    this._persistProblemSince();

    // Virtual device counter/alarm - gated by confirmation same as the trigger/log/
    // timeline above (see _getLowBatteryDelaySeconds), deliberately NOT the raw
    // result.lowBattery.length the Settings UI/widget/condition cards use.
    await this._updateWatchdogDevice({ lowBatteryCount: this.flagState.lowBatteryConfirmed.length });
  }

}

module.exports = DeviceWatchdogApp;
