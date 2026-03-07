import * as FileSystem from 'expo-file-system/legacy';
import { SessionInfo, WifiSnapshot } from '../types/wifi';

const DIRECTORY_NAME = 'wifi-gps-logs';
const CSV_HEADER = [
  'session_id',
  'captured_at',
  'latitude',
  'longitude',
  'accuracy_m',
  'speed_mps',
  'ssid',
  'bssid',
  'strength_pct',
  'frequency_mhz',
  'link_speed_mbps',
  'is_connected',
  'is_internet_reachable'
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

function snapshotToCsvRow(snapshot: WifiSnapshot): string {
  return [
    snapshot.sessionId,
    snapshot.capturedAt,
    snapshot.latitude,
    snapshot.longitude,
    snapshot.accuracy,
    snapshot.speed,
    snapshot.ssid,
    snapshot.bssid,
    snapshot.strength,
    snapshot.frequency,
    snapshot.linkSpeed,
    snapshot.isConnected,
    snapshot.isInternetReachable,
  ].map(escapeCsvCell).join(',');
}

export async function appendSnapshot(fileUri: string, snapshot: WifiSnapshot): Promise<void> {
  await FileSystem.writeAsStringAsync(fileUri, `${snapshotToCsvRow(snapshot)}\n`, {
    append: true,
    encoding: FileSystem.EncodingType.UTF8,
  });
}
