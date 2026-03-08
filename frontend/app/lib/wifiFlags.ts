export type WifiClassification = {
  isOpenAuth: boolean;
  isLikelyFree: boolean;
  freeReason: string;
  securityLabel: string;
};

const FREE_KEYWORDS = [
  'free',
  'freewifi',
  'wi2',
  'guest',
  'public',
  'hotspot',
  'spot',
  'visitor',
  'open',
  'cafe',
];

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function hashSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function classifyWifiNetwork(ssid: string | null, capabilities: string | null | undefined): WifiClassification {
  const normalizedCapabilities = normalize(capabilities).toUpperCase();
  const normalizedSsid = normalize(ssid).toLowerCase();

  const hasWep = normalizedCapabilities.includes('WEP');
  const hasPsk = normalizedCapabilities.includes('PSK');
  const hasSae = normalizedCapabilities.includes('SAE');
  const hasEap = normalizedCapabilities.includes('EAP');
  const hasWpa = normalizedCapabilities.includes('WPA');
  const hasRsn = normalizedCapabilities.includes('RSN');
  const hasOwe = normalizedCapabilities.includes('OWE');

  const isOpenAuth = !hasWep && !hasPsk && !hasSae && !hasEap && !hasWpa && !hasRsn;
  const isPasswordless = isOpenAuth || hasOwe;

  const matchedKeywords = FREE_KEYWORDS.filter((keyword) => normalizedSsid.includes(keyword));
  const reasons: string[] = [];

  if (isPasswordless) {
    reasons.push(hasOwe ? 'passwordless-owe' : 'open-auth');
  }
  if (matchedKeywords.length) {
    reasons.push(`ssid-keyword:${matchedKeywords.join('+')}`);
  }

  let securityLabel = 'Unknown';
  if (hasOwe) securityLabel = 'OWE / enhanced open';
  else if (hasSae) securityLabel = 'WPA3-SAE';
  else if (hasPsk) securityLabel = 'WPA/WPA2-PSK';
  else if (hasEap) securityLabel = 'Enterprise / EAP';
  else if (hasWep) securityLabel = 'WEP';
  else if (isOpenAuth) securityLabel = 'Open';

  return {
    isOpenAuth,
    isLikelyFree: isPasswordless || matchedKeywords.length > 0,
    freeReason: reasons.join('; '),
    securityLabel,
  };
}

export function rssiFillColor(rssiDbm: number | null): string {
  if (rssiDbm == null) return 'rgba(100, 116, 139, 0.92)';
  if (rssiDbm >= -55) return 'rgba(34, 197, 94, 0.92)';
  if (rssiDbm >= -70) return 'rgba(234, 179, 8, 0.92)';
  return 'rgba(239, 68, 68, 0.92)';
}

export function rssiStrokeColor(rssiDbm: number | null): string {
  if (rssiDbm == null) return 'rgba(51, 65, 85, 1)';
  if (rssiDbm >= -55) return 'rgba(21, 128, 61, 1)';
  if (rssiDbm >= -70) return 'rgba(161, 98, 7, 1)';
  return 'rgba(185, 28, 28, 1)';
}

export function rssiLabel(rssiDbm: number | null): string {
  if (rssiDbm == null) return 'Unknown';
  if (rssiDbm >= -55) return 'Strong';
  if (rssiDbm >= -70) return 'Fair';
  return 'Weak';
}

export function offsetCoordinate(latitude: number, longitude: number, seedText: string, index: number) {
  const seed = hashSeed(`${seedText}:${index}`);
  const angle = (seed % 360) * (Math.PI / 180);
  const radiusMeters = 2 + (seed % 9);
  const latOffset = (radiusMeters * Math.cos(angle)) / 111111;
  const lngOffset = (radiusMeters * Math.sin(angle)) / (111111 * Math.max(Math.cos((latitude * Math.PI) / 180), 0.2));
  return {
    latitude: latitude + latOffset,
    longitude: longitude + lngOffset,
  };
}
