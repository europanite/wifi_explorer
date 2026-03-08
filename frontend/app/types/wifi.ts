export type WifiAccessPointRecord = {
  id: string;
  sessionId: string;
  scanId: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  ssid: string | null;
  bssid: string | null;
  rssiDbm: number | null;
  frequency: number | null;
  capabilities: string;
  timestampMicros: number | null;
  isOpenAuth: boolean;
  isLikelyFree: boolean;
  freeReason: string;
  securityLabel: string;
};

export type SessionInfo = {
  sessionId: string;
  fileUri: string;
  startedAt: string;
};
