export type WifiSnapshot = {
  id: string;
  sessionId: string;
  capturedAt: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  speed: number | null;
  ssid: string | null;
  bssid: string | null;
  strength: number | null;
  frequency: number | null;
  linkSpeed: number | null;
  isConnected: boolean;
  isInternetReachable: boolean | null;
};

export type SessionInfo = {
  sessionId: string;
  fileUri: string;
  startedAt: string;
};
