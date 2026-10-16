import { execFile } from 'node:child_process';
import { mergeConfigValue, type ConfigLayer, type SystemEntry } from './destinations.js';

/** Fields that decide where adt+ connects and with which credentials: a change here can send a password elsewhere. */
const CONNECTION_FIELDS = ['kind', 'auth', 'client', 'systemUrl', 'adtlsDestinationId', 'ssoUrl', 'user', 'keychainService', 'extraCaCerts'];
/**
 * Fields that open or close write gates (ADR-003, ADR-005); `mirror` holds the git helper's (ADR-011),
 * `format` the abap-cleaner binary and profile adt+ runs (ADR-017).
 */
const GATE_FIELDS = ['writeAllowlist', 'allowRun', 'allowDataPreview', 'allowRuntimeLogs', 'allowTranslations', 'allowPublishService', 'rateLimit', 'restTimeout', 'mirror', 'format'];

/**
 * An object field as it becomes after the merge (ADR-006), the keys this file sets first: the
 * shown text is cut at 120 characters, and the inherited keys go first to go.
 */
function merged(before: unknown, own: unknown): unknown {
  const value = mergeConfigValue(before, own);
  if (typeof own !== 'object' || own === null || Array.isArray(own) || typeof value !== 'object' || value === null) return value;
  const all = value as Record<string, unknown>;
  return Object.fromEntries([...Object.keys(own), ...Object.keys(all).filter((k) => !(k in own))].map((k) => [k, all[k]]));
}

/** Whether a merged `mirror` turns the git helper on (ADR-011). */
const gitEnabled = (mirror: unknown) => (mirror as { git?: { enabled?: unknown } } | undefined)?.git?.enabled === true;

/** The abap-cleaner binary and profile a merged `format` names (ADR-017). */
const cleanerFiles = (format: unknown) => {
  const cleaner = (format as { abapCleaner?: { path?: unknown; profile?: unknown } } | undefined)?.abapCleaner;
  return JSON.stringify([cleaner?.path, cleaner?.profile]);
};

function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export interface FieldChange {
  field: string;
  value: string;
  /** The inherited value this replaces, if any. */
  was?: string;
  warn: boolean;
}

export interface SystemChange {
  id: string;
  action: 'adds' | 'overrides';
  fields: FieldChange[];
  /** Findings across fields, such as a borrowed Keychain password. */
  warnings: string[];
  /** Fields set that neither connect nor gate. */
  also: string[];
}

export interface LayerSummary {
  path: string;
  systems: SystemChange[];
}

/**
 * What approving this project config would change, for the approval dialog.
 * `inherited` is what the files before it define. Connection and gate fields
 * come first, marked `warn` where they redirect a credential or open a gate.
 */
export function describeLayer(layer: ConfigLayer, inherited: Record<string, SystemEntry>, label = layer.path): LayerSummary {
  const keychainUsers = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(inherited)) {
    if (entry.keychainService) keychainUsers.set(entry.keychainService, [...(keychainUsers.get(entry.keychainService) ?? []), id]);
  }

  const systems: SystemChange[] = [];
  for (const [id, entry] of Object.entries(layer.systems)) {
    const before = inherited[id] as Record<string, unknown> | undefined;
    const fields = entry as Record<string, unknown>;
    const ordered = [...CONNECTION_FIELDS.filter((f) => f in fields), ...GATE_FIELDS.filter((f) => f in fields)];
    const changes: FieldChange[] = ordered.map((field) => {
      // An object field merges onto the inherited one (ADR-006): show what it becomes.
      const after = before && field in before ? merged(before[field], fields[field]) : fields[field];
      const value = show(after);
      const was = before && field in before ? show(before[field]) : undefined;
      let warn = false;
      if (CONNECTION_FIELDS.includes(field)) warn = was !== undefined && was !== value;
      if (GATE_FIELDS.includes(field)) {
        warn =
          field === 'mirror'
            ? gitEnabled(after) && !gitEnabled(before?.mirror)
            : field === 'format'
              ? cleanerFiles(after) !== cleanerFiles(before?.format)
              : field !== 'rateLimit' && field !== 'restTimeout' && !(field === 'allowPublishService' && fields[field] === false);
      }
      return was === undefined ? { field, value, warn } : { field, value, was, warn };
    });
    const warnings: string[] = [];
    const shared = entry.keychainService ? (keychainUsers.get(entry.keychainService) ?? []).filter((other) => other !== id) : [];
    if (shared.length > 0) {
      warnings.push(
        `uses the Keychain password of ${shared.map((s) => `"${s}"`).join(', ')}, sent to ${show(fields.systemUrl ?? before?.systemUrl ?? '(URL from ~/.adtls)')}`,
      );
    }
    systems.push({
      id,
      action: before ? 'overrides' : 'adds',
      fields: changes,
      warnings,
      also: Object.keys(fields).filter((f) => !ordered.includes(f)),
    });
  }
  return { path: label, systems };
}

/** The summaries as plain text, for the terminal fallback. */
export function formatSummaries(summaries: LayerSummary[]): string {
  const blocks = summaries.map((summary) => {
    const lines = [summary.path];
    for (const system of summary.systems) {
      lines.push(`${system.action} system "${system.id}":`);
      for (const c of system.fields) lines.push(`  ${c.warn ? '⚠ ' : ''}${c.field}: ${c.value}${c.was !== undefined ? ` (was ${c.was})` : ''}`);
      for (const w of system.warnings) lines.push(`  ⚠ ${w}`);
      if (system.also.length > 0) lines.push(`  also sets: ${system.also.join(', ')}`);
    }
    return lines.join('\n');
  });
  return blocks.join('\n\n');
}

export type DialogAnswer = 'allow' | 'deny' | 'unavailable';

/**
 * An NSAlert through JXA, so no dependency: a title, a short explanation, and a
 * scrollable monospace panel with one row per field. The data arrives as a JSON
 * argument and is only ever drawn as text, so nothing in a config file can
 * change the script. Deny is the first button, so Return denies; Allow has no
 * key equivalent and never takes keyboard focus, so only a click allows.
 */
const DIALOG_SCRIPT = String.raw`
ObjC.import('Cocoa');
function run(argv) {
  const data = JSON.parse(argv[0]);
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: no Dock icon, but may take focus
  app.activateIgnoringOtherApps(true);

  const size = 12;
  const mono = $.NSFont.monospacedSystemFontOfSizeWeight(size, 0);
  const monoBold = $.NSFont.monospacedSystemFontOfSizeWeight(size, 0.4);
  const bold = $.NSFont.boldSystemFontOfSize(size + 1);
  const text = $.NSMutableAttributedString.alloc.init;
  let lines = 0;
  function add(str, font, color) {
    const range = $.NSMakeRange(text.length, str.length);
    text.mutableString.appendString(str);
    text.addAttributeValueRange($.NSFontAttributeName, font, range);
    text.addAttributeValueRange($.NSForegroundColorAttributeName, color, range);
    lines += (str.match(/\n/g) || []).length;
  }
  const label = $.NSColor.labelColor, grey = $.NSColor.secondaryLabelColor, warn = $.NSColor.systemOrangeColor;

  const width = Math.max(...data.summaries.flatMap((s) => s.systems.flatMap((y) => y.fields.map((f) => f.field.length))), 8) + 2;
  data.summaries.forEach((summary, i) => {
    if (i > 0) add('\n', mono, label);
    add(summary.path + '\n', bold, label);
    for (const system of summary.systems) {
      add('\n' + (system.action === 'adds' ? 'Adds system ' : 'Overrides system ') , mono, grey);
      add(system.id + '\n', monoBold, label);
      for (const f of system.fields) {
        add((f.warn ? '⚠ ' : '  ') + f.field.padEnd(width), mono, f.warn ? warn : grey);
        add(f.value, mono, f.warn ? warn : label);
        add(f.was !== undefined ? '   was ' + f.was + '\n' : '\n', mono, grey);
      }
      for (const w of system.warnings) add('⚠ ' + w + '\n', monoBold, warn);
      if (system.also.length) add('  also sets ' + system.also.join(', ') + '\n', mono, grey);
    }
  });

  const w = 620, h = Math.min(Math.max(lines * (size + 3) + 24, 100), 420);
  const scroll = $.NSScrollView.alloc.initWithFrame($.NSMakeRect(0, 0, w, h));
  scroll.hasVerticalScroller = true;
  scroll.borderType = 2; // bezel
  const view = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, w, h));
  view.editable = false;
  view.selectable = true;
  view.textContainerInset = $.NSMakeSize(10, 10);
  view.textStorage.setAttributedString(text);
  scroll.documentView = view;

  const alert = $.NSAlert.alloc.init;
  alert.alertStyle = 0; // warning; critical would badge the caution sign with osascript's own icon
  alert.icon = $.NSImage.imageNamed('NSCaution');
  alert.messageText = data.title;
  alert.informativeText = data.info;
  alert.accessoryView = scroll;
  const deny = alert.addButtonWithTitle('Deny');
  const allow = alert.addButtonWithTitle('Allow');
  deny.keyEquivalent = '\r';
  allow.keyEquivalent = '';
  allow.refusesFirstResponder = true; // no focus ring, so Space can't press it either
  alert.window.level = 3; // floating: above the terminal and editor
  // JXA returns the NSModalResponse as a string ("1001"), so compare as a number.
  return Number(alert.runModal) === 1001 ? 'allow' : 'deny';
}
`;

/** How long the dialog waits for an answer before it counts as Deny. */
const DIALOG_TIMEOUT_MS = 300_000;

/**
 * Ask in a native macOS dialog, which an agent driving a terminal can't answer.
 * Deny is the default; the dialog is closed and counts as Deny after five
 * minutes. `unavailable` when no dialog could be shown (not macOS, no GUI
 * session).
 */
export function askTrustDialog(summaries: LayerSummary[]): Promise<DialogAnswer> {
  if (process.platform !== 'darwin') return Promise.resolve('unavailable');
  const several = summaries.length > 1;
  const data = {
    title: several ? 'Approve these adt+ project configs?' : 'Approve this adt+ project config?',
    info:
      'adt+ will use these settings to connect to SAP and to decide what it may change. ' +
      'Approve only if you wrote them or checked them. Any later edit revokes the approval.',
    summaries,
  };
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', DIALOG_SCRIPT, JSON.stringify(data)],
      { timeout: DIALOG_TIMEOUT_MS },
      (err, stdout) => {
        if (!err) resolve(stdout.trim() === 'allow' ? 'allow' : 'deny');
        else if ((err as { killed?: boolean }).killed) resolve('deny');
        else resolve('unavailable');
      },
    );
  });
}
