import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import type { DigestItem } from '@/api/types';

export const PAPER_WIDTH = 384;

const SERIF = Platform.select({ ios: 'Georgia', default: 'serif' });
const INK = '#000000';

function Rule({ s, thick }: { s: number; thick?: boolean }) {
  return <View style={{ height: Math.max(1, (thick ? 3 : 1) * s), backgroundColor: INK }} />;
}

/** Thin rule with three small diamonds centred on it, used between stories. */
function DiamondRule({ s }: { s: number }) {
  const d = 5 * s;
  const line = { flex: 1, height: Math.max(1, s), backgroundColor: INK };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 4 * s }}>
      <View style={line} />
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ width: d, height: d, backgroundColor: INK, transform: [{ rotate: '45deg' }], marginHorizontal: 3 * s }} />
      ))}
      <View style={line} />
    </View>
  );
}

/**
 * In-app approximation of the text-only 384px newspaper receipt produced by the backend renderer
 * (see docs/sample_receipt.png). Black on white, serif, full paper width: masthead between rules,
 * italic date, edition row, then per story a plain italic "#tag" line and a left-aligned TL;DR
 * (no titles, no sprites), diamond rules between stories and a short footer. Rendered at
 * 384 logical px and scaled by `scale` to fit the screen.
 */
export function ReceiptMock({ items, scale = 1 }: { items: DigestItem[]; scale?: number }) {
  const s = scale;
  const date = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const pad = 4 * s;
  return (
    <View style={[styles.paper, { width: PAPER_WIDTH * s }]}>
      <Rule s={s} thick />
      <Text style={[styles.mast, { fontSize: 34 * s, paddingHorizontal: pad }]} numberOfLines={1} adjustsFontSizeToFit>
        THE THERMAL TIMES
      </Text>
      <Rule s={s} />
      <Text style={[styles.date, { fontSize: 12 * s, marginVertical: 3 * s }]}>{date}</Text>
      <Rule s={s} />
      <View style={[styles.edition, { paddingHorizontal: pad, marginVertical: 2 * s }]}>
        <Text style={[styles.small, { fontSize: 10 * s }]}>MORNING EDITION</Text>
        <Text style={[styles.small, { fontSize: 10 * s }]}>NO. {items.length}</Text>
      </View>
      <Rule s={s} />
      {items.map((it, i) => (
        <View key={it.article_id} style={{ paddingHorizontal: pad }}>
          <Text style={[styles.tag, { fontSize: 13 * s, marginTop: 4 * s }]}>#{it.category_slug}</Text>
          <Text style={[styles.body, { fontSize: 17 * s, lineHeight: 22 * s }]}>{it.tldr}</Text>
          {i < items.length - 1 ? <DiamondRule s={s} /> : null}
        </View>
      ))}
      <View style={{ marginTop: 6 * s }}>
        <Rule s={s} thick />
      </View>
      <Text style={[styles.count, { fontSize: 11 * s, marginTop: 4 * s }]}>{items.length} stories</Text>
      <View style={{ paddingHorizontal: 60 * s }}>
        <DiamondRule s={s} />
      </View>
      <Text style={[styles.thanks, { fontSize: 12 * s }]}>That's all for today!</Text>
      <Text style={[styles.foot, { fontSize: 11 * s, marginBottom: 12 * s }]}>Full stories in the app</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  paper: { backgroundColor: '#FFFFFF' },
  mast: { fontFamily: SERIF, fontWeight: '900', color: INK, textAlign: 'center', marginVertical: 2 },
  date: { fontFamily: SERIF, fontStyle: 'italic', color: INK, textAlign: 'center' },
  edition: { flexDirection: 'row', justifyContent: 'space-between' },
  small: { fontFamily: SERIF, color: INK, fontWeight: '600' },
  tag: { fontFamily: SERIF, fontStyle: 'italic', color: INK },
  body: { fontFamily: SERIF, color: INK, textAlign: 'left' },
  count: { fontFamily: SERIF, fontStyle: 'italic', color: INK, textAlign: 'center' },
  thanks: { fontFamily: SERIF, fontStyle: 'italic', fontWeight: '600', color: INK, textAlign: 'center' },
  foot: { fontFamily: SERIF, fontWeight: '700', color: INK, textAlign: 'center' },
});
