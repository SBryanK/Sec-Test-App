import * as Clipboard from 'expo-clipboard';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { api } from '../api/client';

export type ExportKind = 'json' | 'csv' | 'html';

const MIME: Record<ExportKind, string> = {
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
};

function extension(kind: ExportKind): string {
  return kind;
}

function safeName(target: string): string {
  return target.replace(/[^a-z0-9.-]+/gi, '_').slice(0, 48) || 'run';
}

/**
 * Export a run and hand it to the platform share sheet.
 *
 * HTML is the recommended format: it is a self-contained, print-styled report,
 * so "Save as PDF" from the share sheet produces a real PDF with no headless
 * browser on the server and no PDF library in the app.
 *
 * If the share sheet is unavailable (some emulators), the payload is copied to
 * the clipboard so the operator is never left with nothing.
 */
export async function exportRun(
  runId: string,
  kind: ExportKind,
  target: string,
): Promise<string> {
  const body = await api.exportRuns({ runIds: [runId], format: kind, includeTraces: false });

  const filename = `teo-sectest_${safeName(target)}_${new Date().toISOString().slice(0, 10)}.${extension(kind)}`;

  const available = await Sharing.isAvailableAsync();
  if (!available) {
    await Clipboard.setStringAsync(body);
    return `${kind.toUpperCase()} copied to clipboard (sharing unavailable on this device)`;
  }

  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create({ overwrite: true });
  file.write(body);

  await Sharing.shareAsync(file.uri, {
    mimeType: MIME[kind],
    dialogTitle: `Export ${kind.toUpperCase()} report`,
    UTI: kind === 'html' ? 'public.html' : kind === 'csv' ? 'public.comma-separated-values-text' : 'public.json',
  });

  return `${kind.toUpperCase()} report shared as ${filename}`;
}

/** Copy an arbitrary piece of evidence text to the clipboard. */
export async function copyEvidence(text: string): Promise<string> {
  await Clipboard.setStringAsync(text);
  return 'Copied to clipboard';
}
