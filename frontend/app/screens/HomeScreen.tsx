import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import NetInfo, { NetInfoState, NetInfoSubscription } from '@react-native-community/netinfo';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import SignalLegend from '../components/SignalLegend';
import { appendSnapshot, createSessionFile } from '../lib/csv';
import { circleRadius, strengthFillColor, strengthLabel, strengthStrokeColor } from '../lib/signal';
import { SessionInfo, WifiSnapshot } from '../types/wifi';

const DEFAULT_CENTER = {
  latitude: 35.681236,
  longitude: 139.767125,
};

const WIFI_POLL_MS = 3000;
const MIN_MOVE_METERS = 8;
const MIN_STRENGTH_DELTA = 4;
const MAX_POINTS_IN_MEMORY = 600;

type WebMapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  ssid: string | null;
  strength: number | null;
  fillColor: string;
  strokeColor: string;
  radius: number;
};

type WebMapPayload = {
  center: { latitude: number; longitude: number };
  samples: WebMapPoint[];
  path: Array<[number, number]>;
  current: WebMapPoint | null;
};

function makeSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `wifi-log-${stamp}`;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getWifiDetails(state: NetInfoState | null) {
  const details = ((state?.details ?? {}) as Record<string, unknown>);
  return {
    ssid: typeof details.ssid === 'string' ? details.ssid : null,
    bssid: typeof details.bssid === 'string' ? details.bssid : null,
    strength: toNullableNumber(details.strength),
    frequency: toNullableNumber(details.frequency),
    linkSpeed: toNullableNumber(details.linkSpeed),
  };
}

function formatNumber(value: number | null, digits = 0): string {
  return value == null ? '—' : value.toFixed(digits);
}

function distanceMeters(a: Pick<WifiSnapshot, 'latitude' | 'longitude'>, b: Pick<WifiSnapshot, 'latitude' | 'longitude'>): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * earthRadius * Math.asin(Math.sqrt(h));
}

function makeLeafletHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
    <style>
      html, body, #map { height: 100%; margin: 0; padding: 0; background: #dbeafe; }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .leaflet-container { background: #dbeafe; }
      #status {
        position: absolute;
        z-index: 1000;
        left: 12px;
        right: 12px;
        bottom: 12px;
        padding: 8px 10px;
        border-radius: 10px;
        background: rgba(15, 23, 42, 0.82);
        color: white;
        font-size: 12px;
        line-height: 1.4;
      }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div id="status">Loading map…</div>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
    <script>
      (function () {
        const statusEl = document.getElementById('status');
        function setStatus(text) {
          if (statusEl) statusEl.textContent = text;
        }

        if (!window.L) {
          setStatus('Leaflet failed to load. Check network access.');
          return;
        }

        const initialCenter = [35.681236, 139.767125];
        const map = L.map('map', { zoomControl: true }).setView(initialCenter, 16);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        const circlesLayer = L.layerGroup().addTo(map);
        const pathLayer = L.layerGroup().addTo(map);
        const markerLayer = L.layerGroup().addTo(map);
        let hasFitted = false;

        window.__applyPayload = function (payload) {
          try {
            circlesLayer.clearLayers();
            pathLayer.clearLayers();
            markerLayer.clearLayers();

            const points = Array.isArray(payload.samples) ? payload.samples : [];
            const path = Array.isArray(payload.path) ? payload.path : [];
            const current = payload.current || null;
            const center = payload.center || { latitude: 35.681236, longitude: 139.767125 };

            points.forEach(function (point) {
              L.circleMarker([point.latitude, point.longitude], {
                radius: point.radius,
                color: point.strokeColor,
                weight: 1,
                fillColor: point.fillColor,
                fillOpacity: 0.9,
              })
                .bindPopup((point.ssid || 'Current Wi-Fi') + '<br/>Strength: ' + (point.strength == null ? '—' : point.strength + '/100'))
                .addTo(circlesLayer);
            });

            if (path.length >= 2) {
              L.polyline(path, {
                color: 'rgba(30, 41, 59, 0.85)',
                weight: 3,
              }).addTo(pathLayer);
            }

            if (current) {
              L.marker([current.latitude, current.longitude])
                .bindPopup((current.ssid || 'Current Wi-Fi') + '<br/>Strength: ' + (current.strength == null ? '—' : current.strength + '/100'))
                .addTo(markerLayer);
            }

            if (!hasFitted) {
              if (path.length >= 2) {
                map.fitBounds(path, { padding: [30, 30] });
                hasFitted = true;
              } else {
                map.setView([center.latitude, center.longitude], 16);
              }
            } else if (current) {
              map.panTo([current.latitude, current.longitude], { animate: true, duration: 0.35 });
            }

            setStatus(points.length > 0 ? ('Samples: ' + points.length) : 'Waiting for samples…');
          } catch (error) {
            setStatus('Map render error: ' + (error && error.message ? error.message : String(error)));
          }
        };

        document.addEventListener('message', function (event) {
          try {
            const payload = JSON.parse(event.data);
            if (window.__applyPayload) window.__applyPayload(payload);
          } catch (error) {
            setStatus('Message parse error: ' + (error && error.message ? error.message : String(error)));
          }
        });

        if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
        }

        setStatus('Map ready');
      })();
    </script>
  </body>
</html>`;
}

export default function HomeScreen() {
  const webViewRef = useRef<WebView | null>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const netInfoSubRef = useRef<NetInfoSubscription | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);

  const [isStarting, setIsStarting] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
  const [isMapReady, setIsMapReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState('Ready');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [samples, setSamples] = useState<WifiSnapshot[]>([]);
  const [currentLocation, setCurrentLocation] = useState<Location.LocationObjectCoords | null>(null);
  const [wifiState, setWifiState] = useState<NetInfoState | null>(null);
  const [rowsWritten, setRowsWritten] = useState(0);

  const currentWifi = useMemo(() => {
    const details = getWifiDetails(wifiState);
    return {
      ...details,
      isConnected: Boolean(wifiState?.isConnected) && wifiState?.type === 'wifi',
      isInternetReachable: wifiState?.isInternetReachable ?? null,
    };
  }, [wifiState]);

  const currentSample = samples.length > 0 ? samples[samples.length - 1] : null;

  const webMapPayload = useMemo<WebMapPayload>(() => {
    const center = currentLocation
      ? { latitude: currentLocation.latitude, longitude: currentLocation.longitude }
      : currentSample
        ? { latitude: currentSample.latitude, longitude: currentSample.longitude }
        : DEFAULT_CENTER;

    const mappedSamples = samples.map((sample) => ({
      id: sample.id,
      latitude: sample.latitude,
      longitude: sample.longitude,
      ssid: sample.ssid,
      strength: sample.strength,
      fillColor: strengthFillColor(sample.strength),
      strokeColor: strengthStrokeColor(sample.strength),
      radius: Math.max(5, Math.min(18, circleRadius(sample.strength) / 2.2)),
    }));

    return {
      center,
      samples: mappedSamples,
      path: samples.map((sample) => [sample.latitude, sample.longitude] as [number, number]),
      current: mappedSamples.length > 0 ? mappedSamples[mappedSamples.length - 1] : null,
    };
  }, [currentLocation, currentSample, samples]);

  const mapHtml = useMemo(() => makeLeafletHtml(), []);

  const syncMap = useCallback(() => {
    if (!isMapReady || !webViewRef.current) {
      return;
    }

    const payload = JSON.stringify(webMapPayload).replace(/</g, '\\u003c');
    webViewRef.current.injectJavaScript(`window.__applyPayload(${payload}); true;`);
  }, [isMapReady, webMapPayload]);

  const stopTracking = useCallback(() => {
    locationSubRef.current?.remove();
    locationSubRef.current = null;

    netInfoSubRef.current?.();
    netInfoSubRef.current = null;

    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    setIsTracking(false);
    setStatusText((previous) => (previous === 'Ready' ? previous : 'Tracking stopped.'));
  }, []);

  const readWifiState = useCallback(async () => {
    const state = await NetInfo.fetch('wifi');
    setWifiState(state);
    return state;
  }, []);

  const appendTrackedSnapshot = useCallback(async (
    coords: Location.LocationObjectCoords,
    netState: NetInfoState | null,
  ) => {
    const activeSession = sessionRef.current;
    if (!activeSession) {
      throw new Error('No active session is available.');
    }

    const details = getWifiDetails(netState);
    const snapshot: WifiSnapshot = {
      id: `${activeSession.sessionId}-${Date.now()}`,
      sessionId: activeSession.sessionId,
      capturedAt: new Date().toISOString(),
      latitude: coords.latitude,
      longitude: coords.longitude,
      accuracy: toNullableNumber(coords.accuracy),
      speed: toNullableNumber(coords.speed),
      ssid: details.ssid,
      bssid: details.bssid,
      strength: details.strength,
      frequency: details.frequency,
      linkSpeed: details.linkSpeed,
      isConnected: Boolean(netState?.isConnected) && netState?.type === 'wifi',
      isInternetReachable: netState?.isInternetReachable ?? null,
    };

    setSamples((previous) => {
      const last = previous[previous.length - 1];
      if (last) {
        const moved = distanceMeters(last, snapshot);
        const strengthGap = Math.abs((last.strength ?? -1) - (snapshot.strength ?? -1));
        const sameNetwork = last.bssid === snapshot.bssid && last.ssid === snapshot.ssid;

        if (sameNetwork && moved < MIN_MOVE_METERS && strengthGap < MIN_STRENGTH_DELTA) {
          return previous;
        }
      }

      void appendSnapshot(activeSession.fileUri, snapshot)
        .then(() => {
          setRowsWritten((count) => count + 1);
        })
        .catch((appendError: unknown) => {
          const message = appendError instanceof Error ? appendError.message : 'Failed to append CSV data.';
          setError(message);
          setStatusText(message);
        });

      return [...previous, snapshot].slice(-MAX_POINTS_IN_MEMORY);
    });

    setCurrentLocation(coords);
  }, []);

  const handleLocationUpdate = useCallback(async (location: Location.LocationObject) => {
    const latestWifi = await readWifiState().catch(() => wifiState);
    await appendTrackedSnapshot(location.coords, latestWifi ?? wifiState);
  }, [appendTrackedSnapshot, readWifiState, wifiState]);

  const startTracking = useCallback(async () => {
    setError(null);
    setIsStarting(true);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        throw new Error('Foreground location permission was denied.');
      }

      if (Platform.OS === 'android') {
        await Location.enableNetworkProviderAsync().catch(() => undefined);
      }

      const nextSession = await createSessionFile(makeSessionId());
      sessionRef.current = nextSession;
      setSession(nextSession);
      setSamples([]);
      setRowsWritten(0);

      const initialLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const initialWifi = await readWifiState();
      await appendTrackedSnapshot(initialLocation.coords, initialWifi);

      netInfoSubRef.current?.();
      netInfoSubRef.current = NetInfo.addEventListener((state) => {
        setWifiState(state);
      });

      if (pollRef.current) {
        clearInterval(pollRef.current);
      }
      pollRef.current = setInterval(() => {
        void readWifiState().catch(() => undefined);
      }, WIFI_POLL_MS);

      locationSubRef.current?.remove();
      locationSubRef.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 2500,
          distanceInterval: 3,
          mayShowUserSettingsDialog: true,
        },
        (location) => {
          void handleLocationUpdate(location);
        },
      );

      setIsTracking(true);
      setStatusText('Tracking is running.');
    } catch (startError: unknown) {
      stopTracking();
      const message = startError instanceof Error ? startError.message : 'Failed to start tracking.';
      setError(message);
      setStatusText(message);
    } finally {
      setIsStarting(false);
    }
  }, [appendTrackedSnapshot, handleLocationUpdate, readWifiState, stopTracking]);

  const shareCsv = useCallback(async () => {
    if (!session?.fileUri) {
      Alert.alert('No session file', 'Start tracking before exporting CSV data.');
      return;
    }

    const sharingAvailable = await Sharing.isAvailableAsync();
    if (!sharingAvailable) {
      Alert.alert('Sharing unavailable', 'The system share sheet is not available on this device.');
      return;
    }

    await Sharing.shareAsync(session.fileUri, {
      dialogTitle: 'Export Wi-Fi log CSV',
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
    });
  }, [session]);

  useEffect(() => {
    return () => {
      stopTracking();
    };
  }, [stopTracking]);

  useEffect(() => {
    syncMap();
  }, [syncMap]);

  const onWebMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);
      if (payload?.type === 'ready') {
        setIsMapReady(true);
      }
    } catch {
      // Ignore non-JSON messages from the map.
    }
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <WebView
          ref={(ref) => {
            webViewRef.current = ref;
          }}
          source={{ html: mapHtml }}
          style={styles.map}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="always"
          onLoadEnd={() => {
            setIsMapReady(true);
          }}
          onMessage={onWebMessage}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.mapLoading}>
              <ActivityIndicator color="#2563eb" />
              <Text style={styles.mapLoadingText}>Loading web map…</Text>
            </View>
          )}
        />
      </View>

      <View style={styles.panelWrap}>
        <ScrollView contentContainerStyle={styles.panelContent}>
          <Text style={styles.title}>Wi-Fi signal map</Text>
          <Text style={styles.subtitle}>
            This build uses a WebView-based map so the APK can display the map without mounting the crashing native MapView. GPS logging and CSV export stay unchanged.
          </Text>

          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.button, styles.primaryButton, isTracking || isStarting ? styles.buttonDisabled : null]}
              onPress={() => {
                if (!isTracking && !isStarting) {
                  void startTracking();
                }
              }}
            >
              {isStarting ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryButtonText}>Start</Text>}
            </Pressable>

            <Pressable
              style={[styles.button, styles.secondaryButton, !isTracking ? styles.buttonDisabled : null]}
              onPress={() => {
                if (isTracking) stopTracking();
              }}
            >
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>

            <Pressable
              style={[styles.button, styles.secondaryButton]}
              onPress={() => {
                setSamples([]);
                setRowsWritten(0);
              }}
            >
              <Text style={styles.secondaryButtonText}>Clear map</Text>
            </Pressable>

            <Pressable
              style={[styles.button, styles.secondaryButton, !session ? styles.buttonDisabled : null]}
              onPress={() => {
                if (session) {
                  void shareCsv().catch((shareError: unknown) => {
                    const message = shareError instanceof Error ? shareError.message : 'Failed to export CSV data.';
                    setError(message);
                    setStatusText(message);
                  });
                }
              }}
            >
              <Text style={styles.secondaryButtonText}>Export CSV</Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Text style={styles.status}>{statusText}</Text>
          {session?.fileUri ? <Text style={styles.filePath}>CSV file: {session.fileUri}</Text> : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Current Wi-Fi</Text>
            <InfoRow label="SSID" value={currentWifi.ssid ?? 'not connected'} />
            <InfoRow label="BSSID" value={currentWifi.bssid ?? '—'} mono />
            <InfoRow label="Strength" value={currentWifi.strength == null ? '—' : `${currentWifi.strength}/100 (${strengthLabel(currentWifi.strength)})`} />
            <InfoRow label="Frequency" value={currentWifi.frequency == null ? '—' : `${currentWifi.frequency} MHz`} />
            <InfoRow label="Link speed" value={currentWifi.linkSpeed == null ? '—' : `${currentWifi.linkSpeed} Mbps`} />
            <InfoRow label="Connected" value={currentWifi.isConnected ? 'yes' : 'no'} />
            <InfoRow label="Internet" value={currentWifi.isInternetReachable == null ? 'unknown' : currentWifi.isInternetReachable ? 'reachable' : 'offline'} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Current position</Text>
            <InfoRow label="Latitude" value={currentLocation ? currentLocation.latitude.toFixed(6) : '—'} mono />
            <InfoRow label="Longitude" value={currentLocation ? currentLocation.longitude.toFixed(6) : '—'} mono />
            <InfoRow label="Accuracy" value={currentLocation ? `${formatNumber(toNullableNumber(currentLocation.accuracy), 1)} m` : '—'} />
            <InfoRow label="Speed" value={currentLocation ? `${formatNumber(toNullableNumber(currentLocation.speed), 1)} m/s` : '—'} />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Session</Text>
            <InfoRow label="Tracking" value={isTracking ? 'running' : 'stopped'} />
            <InfoRow label="Map engine" value="WebView + Leaflet" />
            <InfoRow label="Rows written" value={String(rowsWritten)} />
            <InfoRow label="Points in memory" value={String(samples.length)} />
            <InfoRow label="Last update" value={currentSample ? currentSample.capturedAt.replace('T', ' ').replace('Z', ' UTC') : '—'} mono />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Signal legend</Text>
            <SignalLegend />
          </View>

          <Text style={styles.note}>
            Limitation: this Expo-compatible build still tracks only the currently connected Wi-Fi network. The web map needs network access to load the Leaflet script and map tiles.
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono ? styles.mono : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mapWrap: {
    flex: 1.05,
    minHeight: 320,
    backgroundColor: '#dbeafe',
  },
  map: {
    width: '100%',
    height: '100%',
    backgroundColor: '#dbeafe',
  },
  mapLoading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#dbeafe',
  },
  mapLoadingText: {
    color: '#334155',
    fontSize: 13,
  },
  panelWrap: {
    flex: 0.95,
    backgroundColor: '#f8fafc',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    marginTop: -16,
    overflow: 'hidden',
  },
  panelContent: {
    padding: 16,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#0f172a',
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    color: '#475569',
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  button: {
    minWidth: 88,
    borderRadius: 999,
    paddingVertical: 11,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
  },
  secondaryButton: {
    backgroundColor: '#e2e8f0',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '700',
  },
  error: {
    color: '#b91c1c',
    fontSize: 13,
  },
  status: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '600',
  },
  filePath: {
    color: '#475569',
    fontSize: 12,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 14,
    gap: 10,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0f172a',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
  },
  infoLabel: {
    color: '#475569',
    fontSize: 13,
  },
  infoValue: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
    textAlign: 'right',
  },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
  note: {
    color: '#475569',
    fontSize: 12,
    lineHeight: 18,
  },
});
