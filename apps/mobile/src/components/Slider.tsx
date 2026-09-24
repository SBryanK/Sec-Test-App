import React, { useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { font, palette, radius, spacing } from '../theme';
import { Text } from './ui';

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  /** Rendered to the right of the track (e.g. the numeric readout). */
  suffix?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Dependency-free slider.
 *
 * Built on PanResponder rather than a native slider package so the app keeps a
 * minimal native footprint — fewer native modules means fewer ways for an
 * Android/iOS build to break.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  style,
}: SliderProps): React.JSX.Element {
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const range = Math.max(1, max - min);
  const ratio = Math.max(0, Math.min(1, (value - min) / range));

  const commit = (x: number): void => {
    const w = widthRef.current;
    if (w <= 0) return;
    const raw = min + (Math.max(0, Math.min(x, w)) / w) * range;
    const snapped = Math.round(raw / step) * step;
    const clamped = Math.max(min, Math.min(max, snapped));
    if (clamped !== value) onChangeRef.current(clamped);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => commit(evt.nativeEvent.locationX),
        onPanResponderMove: (evt) => commit(evt.nativeEvent.locationX),
      }),
    // commit reads refs, so the responder never needs rebuilding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onLayout = (e: LayoutChangeEvent): void => {
    const w = e.nativeEvent.layout.width;
    widthRef.current = w;
    setWidth(w);
  };

  const thumbX = ratio * width;

  return (
    <View style={[styles.row, style]}>
      <View style={styles.trackWrap} onLayout={onLayout} {...responder.panHandlers}>
        <View style={styles.track} />
        <View style={[styles.fill, { width: thumbX }]} />
        <View style={[styles.thumb, { left: Math.max(0, thumbX - 10) }]} />
      </View>
      {suffix ? (
        <Text variant="small" tone="muted" style={styles.suffix}>
          {suffix}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  trackWrap: { flex: 1, height: 40, justifyContent: 'center' },
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.surfaceSunken,
  },
  fill: {
    position: 'absolute',
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.primary,
  },
  thumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: palette.surface,
    borderWidth: 3,
    borderColor: palette.primary,
  },
  suffix: { fontFamily: font.semibold, minWidth: 64 },
});
