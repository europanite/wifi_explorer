export function strengthLabel(strength: number | null): string {
  if (strength == null) return 'unknown';
  if (strength >= 75) return 'excellent';
  if (strength >= 55) return 'good';
  if (strength >= 35) return 'fair';
  return 'weak';
}

export function strengthFillColor(strength: number | null): string {
  if (strength == null) return 'rgba(148, 163, 184, 0.25)';
  if (strength >= 75) return 'rgba(34, 197, 94, 0.28)';
  if (strength >= 55) return 'rgba(132, 204, 22, 0.28)';
  if (strength >= 35) return 'rgba(250, 204, 21, 0.28)';
  return 'rgba(239, 68, 68, 0.28)';
}

export function strengthStrokeColor(strength: number | null): string {
  if (strength == null) return 'rgba(100, 116, 139, 0.9)';
  if (strength >= 75) return 'rgba(22, 163, 74, 0.95)';
  if (strength >= 55) return 'rgba(101, 163, 13, 0.95)';
  if (strength >= 35) return 'rgba(202, 138, 4, 0.95)';
  return 'rgba(185, 28, 28, 0.95)';
}

export function circleRadius(strength: number | null): number {
  if (strength == null) return 16;
  return Math.max(10, 8 + strength * 0.85);
}
