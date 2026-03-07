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
import MapView, { Circle, Marker, Polyline, Region } from 'react-native-maps';
import SignalLegend from '../components/SignalLegend';
import { appendSnapshot, createSessionFile } from '../lib/csv';
import { circleRadius, strengthFillColor, strengthLabel, strengthStrokeColor } from '../lib/signal';
import { SessionInfo, WifiSnapshot } from '../types/wifi';

const DEFAULT_REGION: Region = {
  latitude: 35.681236,
  longitude: 139.767125,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

const MAP_FOLLOW_DELTA = {
  latitudeDelta: 0.0045,
  longitudeDelta: 0.0045,
};

const WIFI_POLL_MS = 3000;
const MIN_MOVE_METERS = 8;
const MIN_STRENGTH_DELTA = 4;
const MAX_POINTS_IN_MEMORY = 600;

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

export default function HomeScreen() {
  const mapRef = useRef<MapView | null>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const netInfoSubRef = useRef<NetInfoSubscription | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const followRef = useRef(true);
  const sessionRef = useRef<SessionInfo | null>(null);

  const [isStarting, setIsStarting] = useState(false);
  const [isTracking, setIsTracking] = useState(false);
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
  const pathCoordinates = samples.map((sample) => ({
    latitude: sample.latitude,
    longitude: sample.longitude,
  }));

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

      void appendSnapshot(activeSession.fileUri, snapshot).then(() => {
        setRowsWritten((count) => count + 1);
      }).catch((appendError: unknown) => {
        const message = appendError instanceof Error ? appendError.message : 'Failed to append CSV data.';
        setError(message);
        setStatusText(message);
      });

      return [...previous, snapshot].slice(-MAX_POINTS_IN_MEMORY);
    });

    setCurrentLocation(coords);

    if (followRef.current && mapRef.current) {
      mapRef.current.animateToRegion(
        {
          latitude: coords.latitude,
          longitude: coords.longitude,
          ...MAP_FOLLOW_DELTA,
        },
        400,
      );
    }
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
      setStatusText('Tracking is running in Expo Go mode.');
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

  return (
    <View style={styles.container}>
      <View style={styles.mapWrap}>
        <MapView
          ref={(ref) => {
            mapRef.current = ref;
          }}
          style={styles.map}
          initialRegion={DEFAULT_REGION}
          showsUserLocation
          showsMyLocationButton
          onPanDrag={() => {
            followRef.current = false;
          }}
          onPress={() => {
            followRef.current = false;
          }}
        >
          {samples.map((sample) => (
            <Circle
              key={sample.id}
              center={{ latitude: sample.latitude, longitude: sample.longitude }}
              radius={circleRadius(sample.strength)}
              fillColor={strengthFillColor(sample.strength)}
              strokeColor={strengthStrokeColor(sample.strength)}
              strokeWidth={1}
            />
          ))}

          {pathCoordinates.length >= 2 ? (
            <Polyline coordinates={pathCoordinates} strokeColor="rgba(30, 41, 59, 0.65)" strokeWidth={3} />
          ) : null}

          {currentSample ? (
            <Marker
              coordinate={{ latitude: currentSample.latitude, longitude: currentSample.longitude }}
              title={currentSample.ssid ?? 'Current Wi-Fi'}
              description={`Strength ${formatNumber(currentSample.strength)} / 100`}
            />
          ) : null}
        </MapView>
      </View>

      <View style={styles.panelWrap}>
        <ScrollView contentContainerStyle={styles.panelContent}>
          <Text style={styles.title}>Wi-Fi signal map</Text>
          <Text style={styles.subtitle}>
            Expo Go compatible mode. This app logs the currently connected Wi-Fi signal together with GPS coordinates, writes each sample to a local CSV file, and reflects the samples on the map in real time.
          </Text>

          <View style={styles.buttonRow}>
            <Pressable
              style={[styles.button, styles.primaryButton, isTracking || isStarting ? styles.buttonDisabled : null]}
              onPress={() => {
                if (!isTracking && !isStarting) {
                  followRef.current = true;
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
            <InfoRow label="Rows written" value={String(rowsWritten)} />
            <InfoRow label="Points in memory" value={String(samples.length)} />
            <InfoRow label="Last update" value={currentSample ? currentSample.capturedAt.replace('T', ' ').replace('Z', ' UTC') : '—'} mono />
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Signal legend</Text>
            <SignalLegend />
          </View>

          <Text style={styles.note}>
            Limitation: Expo Go cannot scan nearby unconnected access points. It can only use libraries included in Expo Go. This reverted version tracks the signal of the currently connected Wi-Fi network instead.
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
  },
  map: {
    width: '100%',
    height: '100%',
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
