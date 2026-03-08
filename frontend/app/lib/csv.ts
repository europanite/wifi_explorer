import * as FileSystem from 'expo-file-system/legacy';
import { SessionInfo, WifiAccessPointRecord } from '../types/wifi';

const DIRECTORY_NAME = 'wifi-survey-logs';
const CSV_HEADER = [
  'session_id',
  'scan_id',
  'captured_at',
  'latitude',
  'longitude',
  'accuracy_m',
  'speed_mps',
  'ssid',
  'bssid',
  'rssi_dbm',
  'frequency_mhz',
  'capabilities',
  'timestamp_micros',
  'is_open_auth',
  'is_likely_free',
  'free_reason',
  'security_label'
].join(',');

function documentRoot(): string {
  if (!FileSystem.documentDirectory) {
    throw new Error('The document directory is unavailable on this device.');
  }
  return FileSystem.documentDirectory;
}

function escapeCsvCell(value: string | number | boolean | null): string {
  const normalized = value === null ? '' : String(value);
  const escaped = normalized.replace(/"/g, '""');
  return `"${escaped}"`;
}

export async function ensureLogDirectory(): Promise<string> {
  const directory = `${documentRoot()}${DIRECTORY_NAME}`;
  const info = await FileSystem.getInfoAsync(directory);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  }
  return directory;
}

export async function createSessionFile(sessionId: string): Promise<SessionInfo> {
  const directory = await ensureLogDirectory();
  const startedAt = new Date().toISOString();
  const fileUri = `${directory}/${sessionId}.csv`;
  await FileSystem.writeAsStringAsync(fileUri, `${CSV_HEADER}\n`, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return { sessionId, fileUri, startedAt };
}

function recordToCsvRow(record: WifiAccessPointRecord): string {
  return [
    record.sessionId,
    record.scanId,
    record.capturedAt,
    record.latitude,
    record.longitude,
    record.accuracy,
    record.speed,
    record.ssid,
    record.bssid,
    record.rssiDbm,
    record.frequency,
    record.capabilities,
    record.timestampMicros,
    record.isOpenAuth,
    record.isLikelyFree,
    record.freeReason,
    record.securityLabel,
  ].map(escapeCsvCell).join(',');
}

export async function appendRecords(fileUri: string, records: WifiAccessPointRecord[]): Promise<void> {
  if (!records.length) {
    return;
  }

  const body = records.map((record) => recordToCsvRow(record)).join('\n');
  await FileSystem.writeAsStringAsync(fileUri, `${body}\n`, {
    append: true,
    encoding: FileSystem.EncodingType.UTF8,
  });
}
