import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import * as Sharing from 'expo-sharing';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import WifiManager from 'react-native-wifi-reborn';
import SignalLegend from '../components/SignalLegend';
import { appendRecords, createSessionFile } from '../lib/csv';
import { classifyWifiNetwork, offsetCoordinate, rssiFillColor, rssiLabel, rssiStrokeColor } from '../lib/wifiFlags';
import { SessionInfo, WifiAccessPointRecord } from '../types/wifi';

const DEFAULT_CENTER = {
  latitude: 35.681236,
  longitude: 139.767125,
};

const SCAN_INTERVAL_MS = 10000;
const CSV_FLUSH_INTERVAL_MS = 60000;
const MAX_VISIBLE_POINTS = 300;
const MAX_LIST_ITEMS = 40;

type PermissionState = 'pending' | 'granted' | 'denied' | 'blocked';

type WifiScanEntry = {
  SSID?: string;
  BSSID?: string;
  capabilities?: string;
  frequency?: number | string;
  level?: number | string;
  timestamp?: number | string;
};

type Coordinate = {
  latitude: number;
  longitude: number;
};

type WebMapPoint = {
  id: string;
  latitude: number;
  longitude: number;
  ssid: string | null;
  bssid: string | null;
  rssiDbm: number | null;
  fillColor: string;
  strokeColor: string;
  isOpenAuth: boolean;
  isLikelyFree: boolean;
};

type WebMapPayload = {
  center: Coordinate;
  points: WebMapPoint[];
  path: Array<[number, number]>;
  currentLocation: Coordinate | null;
};

function makeSessionId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `wifi-survey-${stamp}`;
}

function makeScanId(): string {
  return `scan-${Date.now()}`;
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function formatNumber(value: number | null, digits = 0): string {
  return value == null ? '—' : value.toFixed(digits);
}

function permissionLabel(value: PermissionState): string {
  if (value === 'blocked') return 'blocked';
  return value;
}

function strongestRssiValue(value: number | null): number {
  return value == null ? -999 : value;
}

function surveyKey(record: Pick<WifiAccessPointRecord, 'ssid' | 'bssid' | 'frequency'>): string {
  const normalizedSsid = (record.ssid ?? '').trim().toLowerCase();
  if (normalizedSsid) {
    return `ssid:${normalizedSsid}`;
  }
  const normalizedBssid = (record.bssid ?? '').trim().toLowerCase();
  if (normalizedBssid) {
    return `bssid:${normalizedBssid}`;
  }
  return `hidden:${record.frequency ?? 'na'}`;
}

function makeLeafletHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin="" />
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
        background: rgba(15, 23, 42, 0.84);
        color: white;
        font-size: 12px;
        line-height: 1.4;
      }
      .popup-row { margin: 2px 0; }
      .popup-row strong { display: inline-block; min-width: 54px; }
    </style>
  </head>
  <body>
    <div id="map"></div>
    <div id="status">Loading map…</div>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
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

        const map = L.map('map', { zoomControl: true }).setView([35.681236, 139.767125], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        const pointLayer = L.layerGroup().addTo(map);
        const pathLayer = L.layerGroup().addTo(map);
        const locationLayer = L.layerGroup().addTo(map);
        let hasFitted = false;

        function popupHtml(point) {
          return [
            '<div class="popup-row"><strong>SSID</strong>' + (point.ssid || '(hidden)') + '</div>',
            '<div class="popup-row"><strong>BSSID</strong>' + (point.bssid || '—') + '</div>',
            '<div class="popup-row"><strong>RSSI</strong>' + (point.rssiDbm == null ? '—' : point.rssiDbm + ' dBm') + '</div>',
            '<div class="popup-row"><strong>Open</strong>' + (point.isOpenAuth ? 'yes' : 'no') + '</div>',
            '<div class="popup-row"><strong>Free?</strong>' + (point.isLikelyFree ? 'yes' : 'no') + '</div>'
          ].join('');
        }

        window.__applyPayload = function (payload) {
          try {
            pointLayer.clearLayers();
            pathLayer.clearLayers();
            locationLayer.clearLayers();

            const points = Array.isArray(payload.points) ? payload.points : [];
            const path = Array.isArray(payload.path) ? payload.path : [];
            const currentLocation = payload.currentLocation || null;
            const center = payload.center || { latitude: 35.681236, longitude: 139.767125 };

            points.forEach(function (point) {
              L.circleMarker([point.latitude, point.longitude], {
                radius: 8,
                color: point.strokeColor,
                weight: 1,
                fillColor: point.fillColor,
                fillOpacity: 0.92,
              }).bindPopup(popupHtml(point)).addTo(pointLayer);
            });

            if (path.length >= 2) {
              L.polyline(path, { color: '#0f172a', weight: 3, opacity: 0.7 }).addTo(pathLayer);
            }

            if (currentLocation) {
              L.circleMarker([currentLocation.latitude, currentLocation.longitude], {
                radius: 10,
                color: '#2563eb',
                weight: 2,
                fillColor: '#60a5fa',
                fillOpacity: 0.9,
              }).bindPopup('Current position').addTo(locationLayer);
            }

            if (!hasFitted) {
              if (path.length >= 2) {
                map.fitBounds(path, { padding: [30, 30] });
                hasFitted = true;
              } else {
                map.setView([center.latitude, center.longitude], 16);
              }
            } else if (currentLocation) {
              map.panTo([currentLocation.latitude, currentLocation.longitude], { animate: true, duration: 0.35 });
            }

            setStatus('Visible networks: ' + points.length);
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

async function requestAndroidWifiPermissionsDetailed(): Promise<PermissionState> {
  if (Platform.OS !== 'android') {
    return 'granted';
  }

  const permissions = [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  if (Platform.Version >= 33 && PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES) {
    permissions.push(PermissionsAndroid.PERMISSIONS.NEARBY_WIFI_DEVICES);
  }

  const result = await PermissionsAndroid.requestMultiple(permissions);
  const values = permissions.map((permission) => result[permission]);

  if (values.every((value) => value === PermissionsAndroid.RESULTS.GRANTED)) {
    return 'granted';
  }
  if (values.some((value) => value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN)) {
    return 'blocked';
  }
  return 'denied';
}

async function requestLocationPermissionDetailed(): Promise<PermissionState> {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.granted) {
    return 'granted';
  }

  const requested = await Location.requestForegroundPermissionsAsync();
  if (requested.granted) {
    return 'granted';
  }

  return requested.canAskAgain ? 'denied' : 'blocked';
}

export default function HomeScreen() {
  const webViewRef = useRef<WebView | null>(null);
  const locationSubRef = useRef<Location.LocationSubscription | null>(null);
  const scanTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const csvFlushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const latestLocationRef = useRef<Location.LocationObject | null>(null);
  const mapReadyRef = useRef(false);
  const strongestFreeSamplesRef = useRef<Map<string, WifiAccessPointRecord>>(new Map());
  const pendingCsvRecordsRef = useRef<WifiAccessPointRecord[]>([]);

  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [statusText, setStatusText] = useState('Preparing Wi-Fi survey session…');
  const [isBusy, setIsBusy] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [isSurveyRunning, setIsSurveyRunning] = useState(false);
  const [locationPermission, setLocationPermission] = useState<PermissionState>('pending');
  const [wifiPermission, setWifiPermission] = useState<PermissionState>('pending');
  const [locationServicesOn, setLocationServicesOn] = useState<boolean | null>(null);
  const [lastLocation, setLastLocation] = useState<Location.LocationObject | null>(null);
  const [route, setRoute] = useState<Coordinate[]>([]);
  const [latestScan, setLatestScan] = useState<WifiAccessPointRecord[]>([]);
  const [visibleSamples, setVisibleSamples] = useState<WifiAccessPointRecord[]>([]);

  const sendPayloadToMap = useCallback((records: WifiAccessPointRecord[], currentLocation: Location.LocationObject | null, currentRoute: Coordinate[]) => {
    if (!mapReadyRef.current || !webViewRef.current) {
      return;
    }

    const points: WebMapPoint[] = records.slice(0, MAX_VISIBLE_POINTS).map((record, index) => {
      const offset = offsetCoordinate(record.latitude, record.longitude, record.bssid ?? record.ssid ?? String(index), index);
      return {
        id: record.id,
        latitude: offset.latitude,
        longitude: offset.longitude,
        ssid: record.ssid,
        bssid: record.bssid,
        rssiDbm: record.rssiDbm,
        fillColor: rssiFillColor(record.rssiDbm),
        strokeColor: rssiStrokeColor(record.rssiDbm),
        isOpenAuth: record.isOpenAuth,
        isLikelyFree: record.isLikelyFree,
      };
    });

    const payload: WebMapPayload = {
      center: currentLocation?.coords
        ? { latitude: currentLocation.coords.latitude, longitude: currentLocation.coords.longitude }
        : DEFAULT_CENTER,
      currentLocation: currentLocation?.coords
        ? { latitude: currentLocation.coords.latitude, longitude: currentLocation.coords.longitude }
        : null,
      path: currentRoute.map((point) => [point.latitude, point.longitude]),
      points,
    };

    webViewRef.current.postMessage(JSON.stringify(payload));
  }, []);

  const refreshVisibleSamples = useCallback((currentLocation: Location.LocationObject | null, currentRoute: Coordinate[] = route) => {
    const records = Array.from(strongestFreeSamplesRef.current.values())
      .sort((a, b) => strongestRssiValue(b.rssiDbm) - strongestRssiValue(a.rssiDbm))
      .slice(0, MAX_VISIBLE_POINTS);
    setVisibleSamples(records);
    sendPayloadToMap(records, currentLocation, currentRoute);
  }, [route, sendPayloadToMap]);

  const onMapMessage = useCallback((event: WebViewMessageEvent) => {
    try {
      const payload = JSON.parse(event.nativeEvent.data);
      if (payload?.type === 'ready') {
        mapReadyRef.current = true;
        sendPayloadToMap(visibleSamples, lastLocation, route);
      }
    } catch {
      // Ignore malformed messages from the web view.
    }
  }, [lastLocation, route, sendPayloadToMap, visibleSamples]);

  const ensureSession = useCallback(async () => {
    if (sessionRef.current) {
      return sessionRef.current;
    }
    const info = await createSessionFile(makeSessionId());
    sessionRef.current = info;
    setSessionInfo(info);
    return info;
  }, []);

  const startLocationTracking = useCallback(async () => {
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    setLocationServicesOn(servicesEnabled);

    if (!servicesEnabled) {
      try {
        await Location.enableNetworkProviderAsync();
        setLocationServicesOn(true);
      } catch {
        throw new Error('Location services are off. Turn GPS on and try again.');
      }
    }

    const lastKnown = await Location.getLastKnownPositionAsync({
      maxAge: 60000,
      requiredAccuracy: 100,
    });

    if (lastKnown) {
      latestLocationRef.current = lastKnown;
      setLastLocation(lastKnown);
      const nextRoute = [{ latitude: lastKnown.coords.latitude, longitude: lastKnown.coords.longitude }];
      setRoute(nextRoute);
      sendPayloadToMap(visibleSamples, lastKnown, nextRoute);
    }

    locationSubRef.current?.remove();
    locationSubRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.Balanced,
        timeInterval: 4000,
        distanceInterval: 5,
        mayShowUserSettingsDialog: true,
      },
      (location) => {
        latestLocationRef.current = location;
        setLastLocation(location);
        setRoute((currentRoute) => {
          const nextPoint = { latitude: location.coords.latitude, longitude: location.coords.longitude };
          const nextRoute = [...currentRoute, nextPoint].slice(-MAX_VISIBLE_POINTS);
          sendPayloadToMap(visibleSamples, location, nextRoute);
          return nextRoute;
        });
      }
    );
  }, [sendPayloadToMap, visibleSamples]);

  const flushPendingCsv = useCallback(async () => {
    const session = sessionRef.current;
    const records = pendingCsvRecordsRef.current;

    if (!session || !records.length) {
      return;
    }

    pendingCsvRecordsRef.current = [];
    await appendRecords(session.fileUri, records);
  }, []);

  const runWifiScan = useCallback(async (forceRescan: boolean) => {
    if (isScanning) {
      return;
    }

    const session = await ensureSession();
    const location = latestLocationRef.current;
    if (!location) {
      setStatusText('Waiting for a GPS fix before starting Wi‑Fi scans.');
      return;
    }

    setIsScanning(true);
    try {
      const entries = (((forceRescan ? await WifiManager.reScanAndLoadWifiList() : await WifiManager.loadWifiList()) as WifiScanEntry[]) ?? []);
      const scanId = makeScanId();
      const capturedAt = new Date().toISOString();
      const records: WifiAccessPointRecord[] = entries.map((entry, index) => {
        const ssid = typeof entry.SSID === 'string' && entry.SSID.trim() ? entry.SSID.trim() : null;
        const bssid = typeof entry.BSSID === 'string' && entry.BSSID.trim() ? entry.BSSID.trim() : null;
        const capabilities = typeof entry.capabilities === 'string' ? entry.capabilities : '';
        const rssiDbm = coerceNumber(entry.level);
        const frequency = coerceNumber(entry.frequency);
        const flags = classifyWifiNetwork(ssid, capabilities);
        const id = [session.sessionId, scanId, bssid ?? ssid ?? String(index), index].join(':');

        return {
          id,
          sessionId: session.sessionId,
          scanId,
          capturedAt,
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          accuracy: location.coords.accuracy ?? null,
          speed: location.coords.speed ?? null,
          ssid,
          bssid,
          rssiDbm,
          frequency,
          capabilities,
          timestampMicros: coerceNumber(entry.timestamp),
          isOpenAuth: flags.isOpenAuth,
          isLikelyFree: flags.isLikelyFree,
          freeReason: flags.freeReason,
          securityLabel: flags.securityLabel,
        };
      });

      pendingCsvRecordsRef.current.push(...records);

      const strongestFreeByKey = strongestFreeSamplesRef.current;
      for (const record of records) {
        if (!record.isLikelyFree) {
          continue;
        }

        const key = surveyKey(record);
        const current = strongestFreeByKey.get(key);
        if (!current || strongestRssiValue(record.rssiDbm) > strongestRssiValue(current.rssiDbm)) {
          strongestFreeByKey.set(key, record);
        }
      }

      const strongestFirst = [...records].sort((a, b) => strongestRssiValue(b.rssiDbm) - strongestRssiValue(a.rssiDbm));
      setLatestScan(strongestFirst.slice(0, MAX_LIST_ITEMS));

      const openCount = records.filter((record) => record.isOpenAuth).length;
      const freeCount = records.filter((record) => record.isLikelyFree).length;
      const pendingCount = pendingCsvRecordsRef.current.length;
      setStatusText(`Survey running: ${records.length} networks in the latest scan (${openCount} open, ${freeCount} free-flagged). Pending CSV rows: ${pendingCount}.`);
      refreshVisibleSamples(location);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusText(`Wi‑Fi scan failed: ${message}`);
    } finally {
      setIsScanning(false);
    }
  }, [ensureSession, isScanning, refreshVisibleSamples]);

  const exportCsv = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      Alert.alert('Nothing to export', 'Start a scan session first.');
      return;
    }

    await flushPendingCsv();

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      Alert.alert('Sharing unavailable', 'This device cannot share files from the app.');
      return;
    }

    await Sharing.shareAsync(session.fileUri, {
      dialogTitle: 'Export nearby Wi‑Fi survey CSV',
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
    });
  }, [flushPendingCsv]);

  const startSurvey = useCallback(async () => {
    if (isSurveyRunning || isScanning) {
      return;
    }

    if (locationPermission !== 'granted') {
      setStatusText('Location permission is required before starting the survey.');
      return;
    }

    if (wifiPermission !== 'granted') {
      setStatusText('Wi-Fi permission is required before starting the survey.');
      return;
    }

    const location = latestLocationRef.current;
    if (!location) {
      setStatusText('Waiting for a GPS fix before starting the continuous survey.');
      return;
    }

    setIsSurveyRunning(true);
    setStatusText('Starting continuous Wi-Fi survey…');

    await runWifiScan(true);

    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
    }
    scanTimerRef.current = setInterval(() => {
      runWifiScan(false).catch(() => undefined);
    }, SCAN_INTERVAL_MS);

    if (csvFlushTimerRef.current) {
      clearInterval(csvFlushTimerRef.current);
    }
    csvFlushTimerRef.current = setInterval(() => {
      flushPendingCsv().catch(() => undefined);
    }, CSV_FLUSH_INTERVAL_MS);

    setStatusText('Survey is running. Walk around and the app will keep scanning every 10 seconds. CSV rows are flushed every minute.');
  }, [flushPendingCsv, isScanning, isSurveyRunning, locationPermission, runWifiScan, wifiPermission]);

  const stopSurvey = useCallback(async () => {
    if (scanTimerRef.current) {
      clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    if (csvFlushTimerRef.current) {
      clearInterval(csvFlushTimerRef.current);
      csvFlushTimerRef.current = null;
    }

    setIsSurveyRunning(false);
    await flushPendingCsv();
    setStatusText('Survey stopped. The strongest free SSIDs remain on the map, and pending CSV rows were flushed.');
  }, [flushPendingCsv]);

  useEffect(() => {
    let mounted = true;

    async function bootstrap() {
      setIsBusy(true);
      try {
        await ensureSession();

        const nextLocationPermission = await requestLocationPermissionDetailed();
        if (!mounted) return;
        setLocationPermission(nextLocationPermission);

        const nextWifiPermission = await requestAndroidWifiPermissionsDetailed();
        if (!mounted) return;
        setWifiPermission(nextWifiPermission);

        if (nextLocationPermission !== 'granted') {
          setStatusText(
            nextLocationPermission === 'blocked'
              ? 'Location permission is blocked. Open app settings and allow it.'
              : 'Location permission was denied.'
          );
          return;
        }

        if (nextWifiPermission !== 'granted') {
          setStatusText(
            nextWifiPermission === 'blocked'
              ? 'Wi‑Fi scan permission is blocked. Open app settings and allow Nearby devices / Location.'
              : 'Wi‑Fi scan permission was denied.'
          );
          return;
        }

        await startLocationTracking();
        if (!mounted) return;

        setStatusText('Ready. Press Start survey, then walk around to keep scanning nearby Wi-Fi continuously.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (mounted) {
          setStatusText(message);
        }
      } finally {
        if (mounted) {
          setIsBusy(false);
        }
      }
    }

    bootstrap();

    return () => {
      mounted = false;
      if (scanTimerRef.current) {
        clearInterval(scanTimerRef.current);
        scanTimerRef.current = null;
      }
      if (csvFlushTimerRef.current) {
        clearInterval(csvFlushTimerRef.current);
        csvFlushTimerRef.current = null;
      }
      flushPendingCsv().catch(() => undefined);
      if (locationSubRef.current) {
        locationSubRef.current.remove();
        locationSubRef.current = null;
      }
    };
  }, [ensureSession, flushPendingCsv, startLocationTracking]);

  useEffect(() => {
    sendPayloadToMap(visibleSamples, lastLocation, route);
  }, [lastLocation, route, sendPayloadToMap, visibleSamples]);

  const summary = useMemo(() => {
    const openCount = latestScan.filter((record) => record.isOpenAuth).length;
    const freeCount = latestScan.filter((record) => record.isLikelyFree).length;
    return {
      total: latestScan.length,
      openCount,
      freeCount,
      mappedFreeCount: visibleSamples.length,
    };
  }, [latestScan, visibleSamples]);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.headerBlock}>
        <Text style={styles.title}>Nearby Wi‑Fi Survey</Text>
        <Text style={styles.subtitle}>
          Press Start survey, then keep walking. The app scans continuously, shows only free-flagged SSIDs on the map, keeps the strongest signal per SSID, and flushes CSV rows every minute.
        </Text>
      </View>

      <View style={styles.mapCard}>
        <View style={styles.mapWrap}>
          <WebView
            ref={(ref) => {
              webViewRef.current = ref;
            }}
            source={{ html: makeLeafletHtml() }}
            originWhitelist={['*']}
            javaScriptEnabled
            domStorageEnabled
            onMessage={onMapMessage}
            style={styles.map}
          />
        </View>
        <View style={styles.legendWrap}>
          <SignalLegend />
        </View>
      </View>

      <View style={styles.panelCard}>
        <View style={styles.metaGrid}>
          <Text style={styles.metaLine}>Session: {sessionInfo?.sessionId ?? 'starting…'}</Text>
          <Text style={styles.metaLine}>Location permission: {permissionLabel(locationPermission)}</Text>
          <Text style={styles.metaLine}>Wi‑Fi permission: {permissionLabel(wifiPermission)}</Text>
          <Text style={styles.metaLine}>Location services: {locationServicesOn == null ? 'checking…' : locationServicesOn ? 'on' : 'off'}</Text>
          <Text style={styles.metaLine}>
            Last GPS: {lastLocation ? `${lastLocation.coords.latitude.toFixed(5)}, ${lastLocation.coords.longitude.toFixed(5)}` : 'waiting…'}
          </Text>
          <Text style={styles.metaLine}>Latest scan list: {summary.total} items</Text>
          <Text style={styles.metaLine}>Open auth: {summary.openCount}</Text>
          <Text style={styles.metaLine}>Free-flagged: {summary.freeCount}</Text>
          <Text style={styles.metaLine}>Mapped free SSIDs: {summary.mappedFreeCount}</Text>
          <Text style={styles.metaLine}>Survey state: {isSurveyRunning ? 'running' : 'stopped'}</Text>
        </View>

        <Text style={styles.status}>{statusText}</Text>

        {isBusy ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
            <Text style={styles.loadingText}>Initializing permissions and sensors…</Text>
          </View>
        ) : null}

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.button, styles.primaryButton, isScanning ? styles.disabledButton : null]}
            onPress={() => {
              if (isSurveyRunning) {
                stopSurvey().catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  Alert.alert('Stop survey failed', message);
                });
              } else {
                startSurvey().catch((error) => {
                  const message = error instanceof Error ? error.message : String(error);
                  Alert.alert('Start survey failed', message);
                });
              }
            }}
            disabled={isScanning}
          >
            <Text style={styles.primaryButtonText}>{isScanning ? 'Scanning…' : isSurveyRunning ? 'Stop survey' : 'Start survey'}</Text>
          </Pressable>

          <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => {
            exportCsv().catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              Alert.alert('Export failed', message);
            });
          }}>
            <Text style={styles.secondaryButtonText}>Export CSV</Text>
          </Pressable>

          {(locationPermission === 'blocked' || wifiPermission === 'blocked') ? (
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => Linking.openSettings()}>
              <Text style={styles.secondaryButtonText}>Open settings</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <View style={styles.listCard}>
        <Text style={styles.sectionTitle}>Latest scan snapshot</Text>
        {latestScan.length ? latestScan.map((record) => (
          <View key={record.id} style={styles.listRow}>
            <View style={styles.listMain}>
              <Text style={styles.listSsid}>{record.ssid || '(hidden SSID)'}</Text>
              <Text style={styles.listMeta}>
                {record.bssid || '—'} · {record.frequency ? `${record.frequency} MHz` : 'freq —'} · {record.securityLabel}
              </Text>
              <Text style={styles.listMeta}>
                {record.isOpenAuth ? 'OPEN' : 'SECURED'}{record.isLikelyFree ? ' · FREE?' : ''}
                {record.freeReason ? ` · ${record.freeReason}` : ''}
              </Text>
            </View>
            <View style={styles.listSignalBox}>
              <Text style={styles.listSignalValue}>{formatNumber(record.rssiDbm)} dBm</Text>
              <Text style={styles.listSignalLabel}>{rssiLabel(record.rssiDbm)}</Text>
            </View>
          </View>
        )) : (
          <Text style={styles.emptyText}>No nearby Wi‑Fi networks recorded yet.</Text>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    backgroundColor: '#f8fafc',
    gap: 16,
    padding: 16,
    paddingBottom: 28,
  },
  headerBlock: {
    gap: 6,
    marginTop: 8,
  },
  title: {
    color: '#0f172a',
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    color: '#475569',
    fontSize: 14,
    lineHeight: 20,
  },
  mapCard: {
    backgroundColor: 'white',
    borderColor: '#e2e8f0',
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
  },
  mapWrap: {
    height: 360,
  },
  map: {
    flex: 1,
  },
  legendWrap: {
    borderTopColor: '#e2e8f0',
    borderTopWidth: 1,
    padding: 14,
  },
  panelCard: {
    backgroundColor: 'white',
    borderColor: '#e2e8f0',
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 16,
  },
  metaGrid: {
    gap: 6,
  },
  metaLine: {
    color: '#334155',
    fontSize: 13,
  },
  status: {
    color: '#0f172a',
    fontSize: 14,
    lineHeight: 20,
  },
  loadingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  loadingText: {
    color: '#475569',
    fontSize: 13,
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  button: {
    borderRadius: 12,
    minHeight: 42,
    minWidth: 110,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: '#e2e8f0',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    color: '#0f172a',
    fontSize: 14,
    fontWeight: '600',
  },
  disabledButton: {
    opacity: 0.55,
  },
  listCard: {
    backgroundColor: 'white',
    borderColor: '#e2e8f0',
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  sectionTitle: {
    color: '#0f172a',
    fontSize: 18,
    fontWeight: '700',
  },
  listRow: {
    alignItems: 'center',
    borderBottomColor: '#e2e8f0',
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    paddingVertical: 10,
  },
  listMain: {
    flex: 1,
    gap: 2,
  },
  listSsid: {
    color: '#0f172a',
    fontSize: 15,
    fontWeight: '600',
  },
  listMeta: {
    color: '#64748b',
    fontSize: 12,
    lineHeight: 17,
  },
  listSignalBox: {
    alignItems: 'flex-end',
    minWidth: 78,
  },
  listSignalValue: {
    color: '#0f172a',
    fontSize: 13,
    fontWeight: '700',
  },
  listSignalLabel: {
    color: '#475569',
    fontSize: 12,
  },
  emptyText: {
    color: '#64748b',
    fontSize: 13,
  },
});
