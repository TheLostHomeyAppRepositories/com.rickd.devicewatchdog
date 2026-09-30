'use strict';

/**
 * Default global configuration.
 * All values can be overridden by the user on the "Allgemein" settings tab.
 */
const DEFAULT_CONFIG = {
  // Base threshold: how many hours a device may stay silent before it's flagged.
  notReportingThresholdHours: 24,
  // Base threshold: battery percentage at/below which a device is flagged.
  batteryThresholdPercent: 30,
  // Automatic scan interval in minutes. Only used when scanIntervalEnabled === true.
  scanIntervalMinutes: 60,
  // If false, no automatic interval scan runs - only manual (Flow action / settings button).
  scanIntervalEnabled: true,
  // No global exclusion filters (zone/owner-app/class) by design - every device is
  // scanned by default. Excluding individual devices or whole zones happens explicitly
  // via the per-device toggle / "Zone ignorieren" bulk action in the Settings UI.
  // If true, writes a Homey Timeline entry the moment a device newly becomes a problem
  // (same edge-triggered semantics as the Flow triggers) - never repeats for the same
  // ongoing problem, to avoid spamming the timeline.
  timelineNotifications: false,
  // Which categories feed into the virtual Watchdog device's alarm_generic capability.
  // The three count capabilities themselves always show the real numbers regardless -
  // this only filters what flips the aggregate alarm, e.g. to ignore battery warnings
  // there but still see them in the counts / other Flow cards.
  alarmIncludesUnavailable: true,
  alarmIncludesNotReporting: true,
  alarmIncludesLowBattery: true,
  // Grace period before a device that just went unavailable counts as confirmed
  // (Flow trigger, log, summary, Timeline, and the virtual device's count/alarm all
  // wait for this). 0 = instant, same as before this existed. Meant for cases like an
  // app update briefly disconnecting all its devices - not a real problem worth a Flow
  // firing or an alert, if it recovers within the grace period.
  unavailableDelaySeconds: 0,
  // Grace period before a device newly seen at/below the battery threshold counts as
  // confirmed (Flow trigger, log, summary, Timeline, and the virtual device's
  // counter/alarm all wait for this) - same idea as unavailableDelaySeconds above, but
  // for measure_battery, which is only sampled once per scan and has no realtime push of
  // its own. Meant for devices that report a transient 1% (or similar) blip for a few
  // seconds before recovering to a normal reading - a real problem worth alerting on
  // should still look low several scans in a row, not just once. 0 = instant, same as
  // before this existed. Does NOT delay the raw battery %/status shown in this Settings
  // UI, the widget, or the condition cards - those stay live, same as
  // unavailableDelaySeconds does for reachability.
  lowBatteryDelaySeconds: 0,
  // Settings UI only: lightens secondary/muted text further in dark mode, for users
  // who find the default dark-mode gray too low-contrast in bright light.
  highContrastText: false,
  // Settings UI only: 'auto' follows the OS/browser color-scheme preference (default,
  // same behavior as before this existed), 'light'/'dark' force that scheme regardless
  // of the system setting.
  colorTheme: 'auto',
  // If true, "not reporting" also treats Homey's own lastSeenAt as a sign of life,
  // not just capability value changes - whichever is newer counts. CAVEAT (confirmed
  // against real devices, see community thread): for most devices lastSeenAt only
  // moves in lockstep with the last real capability update anyway, so this ends up a
  // no-op more often than not - it only actually helps the minority of devices whose
  // lastSeenAt is genuinely updated independently of their reported capability data.
  // Off by default: capability-only detection also catches a device that's connected
  // but whose data itself is stuck, which this would miss.
  includeLastSeenForReporting: false,
  // Minutes to wait after the app itself starts (Homey boot/restart, app update/restart)
  // before running the very first automatic scan. Purely a startup transient guard: right
  // after a restart, HomeyAPI's device cache/mesh may not be fully settled yet, which can
  // otherwise cause a burst of spurious "not reporting" flags that clear up a few minutes
  // later on their own. 0 = scan immediately, same as before this existed. Does not affect
  // manual scans (button / Flow action) or any scan after the first one.
  startupGraceMinutes: 2,
  // Safety margin applied over a device's worst observed reporting gap when computing a
  // suggested "not reporting" threshold (see lib/scanner.js#computeUpdateStats) - 1.5x by
  // default. Lower it for tighter suggestions if 1.5x feels too conservative; clamped to
  // [1.0, 5.0] in saveConfig - below 1.0 would suggest a threshold shorter than a gap
  // already observed (guaranteed immediate false flag), above 5.0 is almost certainly a typo.
  recommendationSafetyFactor: 1.5,
  // Which observed value the Recommendations threshold suggestion is computed from (see
  // lib/scanner.js#computeUpdateStats) - 'max' (default) uses the longest observed gap, the
  // existing behavior; 'avg' uses the average interval instead, for devices where a single
  // occasional quiet stretch (e.g. an event-only alarm_contact/alarm_motion sensor) shouldn't
  // dominate the suggestion. Switching to 'avg' will likely need a notably higher
  // recommendationSafetyFactor to avoid frequent over-eager suggestions, since roughly half
  // of any device's real intervals are already above its own average by definition.
  recommendationBasis: 'max',
};

/**
 * Rules array is empty by default - the user builds it up via the settings page.
 * Shape of a single rule:
 * {
 *   id: 'uuid',
 *   matchType: 'id' | 'name' | 'pattern',
 *   matchValue: string,
 *   label: string,               // free-text note, e.g. device name for readability
 *   notReportingHours: number|null,
 *   batteryThreshold: number|null,
 *   excludeBattery: boolean,
 *   onlyCheckBattery: boolean,
 *   excludeAll: boolean,
 *   excludeFromUnavailable: boolean,
 *   unavailableDelaySeconds: number|null,
 *   lowBatteryDelaySeconds: number|null,  // per-device override of the global grace
 *                                           // period above, same null="inherit" semantics
 *                                           // as unavailableDelaySeconds
 *   includeLastSeenForReporting: boolean|null,  // null = inherit the global setting
 *   includeBatteryForReporting: boolean,  // On by default (see BATTERY_STALENESS_CAP_BASES
 *                                           // in lib/scanner.js): a still-updating battery
 *                                           // capability counts as a sign of life for the
 *                                           // "not reporting" check, like any other
 *                                           // capability. Turn off for a device whose
 *                                           // battery updates on its own cadence and
 *                                           // shouldn't count.
 *   pausedUntil: string|null,    // ISO date "YYYY-MM-DD"; paused through end of that day
 *   batteryTypeOverride: string|null,  // free text, e.g. "4x AA" - shown instead of the
 *                                       // driver-declared battery type when Homey has none
 *   autoTestOnStale: boolean,    // Only offered in the UI for devices with a testCapability
 *                                 // (see app.js). When true, a device about to be flagged
 *                                 // "not reporting" gets one live capability test first; a
 *                                 // successful test counts as OK instead (see _runAutoTests).
 *   autoTestTriggerOnHeal: boolean,  // Only relevant when autoTestOnStale is true. Off by
 *                                     // default (successful auto-test stays silent besides
 *                                     // the log entry) - true also fires the normal
 *                                     // device_not_reporting Flow trigger despite the heal.
 *   dismissedRecommendedHours: number|null,  // Set from the "Empfehlungen" tab's Dismiss
 *                                              // button - the specific recommendedHours
 *                                              // value (see lib/scanner.js#computeUpdateStats)
 *                                              // the user rejected. Only suppresses that exact
 *                                              // value; a different future recommendation for
 *                                              // this device shows up again on its own.
 * }
 */
const DEFAULT_RULES = [];

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_RULES,
};
