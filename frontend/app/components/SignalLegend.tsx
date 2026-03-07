import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

const rows = [
  { color: 'rgba(34, 197, 94, 0.9)', label: 'Strong' },
  { color: 'rgba(250, 204, 21, 0.9)', label: 'Fair' },
  { color: 'rgba(239, 68, 68, 0.9)', label: 'Weak' },
  { color: 'rgba(100, 116, 139, 0.9)', label: 'Unknown' },
];

export default function SignalLegend() {
  return (
    <View style={styles.container}>
      {rows.map((row) => (
        <View key={row.label} style={styles.row}>
          <View style={[styles.dot, { backgroundColor: row.color }]} />
          <Text style={styles.label}>{row.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  label: {
    color: '#334155',
    fontSize: 12,
  },
});
