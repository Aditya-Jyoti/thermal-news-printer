import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import type { DigestItem } from '@/api/types';

export const PAPER_WIDTH = 384;

const SERIF = Platform.select({ ios: 'Georgia', default: 'serif' });
const SPRITES = ['(o_o)', '(^o^)', '(o_O)', '\\(^o^)/', '(-_-)', '(>_<)', '(^_~)'];
const INK = '#000000';

function Rule({ s, double }: { s: number; double?: boolean }) {
  return (
    <View style={{ marginVertical: 6 * s }}>
      <View style={{ height: Math.max(1, 2 * s), backgroundColor: INK }} />
      {double ? <View style={{ height: Math.max(1, s), backgroundColor: INK, marginTop: 2 * s }} /> : null}
    </View>
  );
}

/**
 * Placeholder in-app approximation of the 384px newspaper receipt, used in demo mode before the
 * backend Pillow renderer exists. Black on white, serif, plain "#tag" text, no titles, margin sprites.
 */
export function ReceiptMock({ items, scale = 1 }: { items: DigestItem[]; scale?: number }) {
  const s = scale;
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <View style={[styles.paper, { width: PAPER_WIDTH * s, padding: 12 * s }]}>
      <Text style={[styles.mast, { fontSize: 30 * s }]}>THE DAILY TL;DR</Text>
      <Text style={[styles.date, { fontSize: 12 * s }]}>{date.toUpperCase()}</Text>
      <Rule s={s} double />
      {items.map((it, i) => (
        <View key={it.article_id}>
          <View style={styles.row}>
            <View style={{ width: 52 * s, paddingTop: 2 * s }}>
              <Text style={[styles.sprite, { fontSize: 10 * s }]}>{SPRITES[i % SPRITES.length]}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.tag, { fontSize: 13 * s }]}>#{it.category_slug}</Text>
              <Text style={[styles.body, { fontSize: 15 * s, lineHeight: 20 * s }]}>{it.tldr}</Text>
            </View>
          </View>
          {i < items.length - 1 ? (
            <View style={{ borderBottomWidth: Math.max(1, s), borderStyle: 'dashed', borderColor: INK, marginVertical: 8 * s }} />
          ) : null}
        </View>
      ))}
      <Rule s={s} double />
      <Text style={[styles.date, { fontSize: 11 * s }]}>- END OF EDITION -</Text>
      <Text style={[styles.note, { fontSize: 10 * s }]}>Demo layout. The real preview comes from the backend renderer.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: '#FFFFFF' },
  mast: { fontFamily: SERIF, fontWeight: '900', color: INK, textAlign: 'center', letterSpacing: 1 },
  date: { fontFamily: SERIF, color: INK, textAlign: 'center', letterSpacing: 2 },
  row: { flexDirection: 'row' },
  sprite: { fontFamily: 'monospace', color: INK },
  tag: { fontFamily: SERIF, fontWeight: '700', color: INK },
  body: { fontFamily: SERIF, color: INK, textAlign: 'justify' },
  note: { fontFamily: SERIF, color: INK, textAlign: 'center', fontStyle: 'italic', marginTop: 6 },
});
