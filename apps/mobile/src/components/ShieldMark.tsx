import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { palette } from '../theme';

/**
 * The brand mark: a shield on a plinth, drawn as vector so it stays crisp at any
 * size and matches the app icon.
 */
export function ShieldMark({
  size = 120,
  style,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
}): React.JSX.Element {
  const height = size * 1.08;

  return (
    <View style={style} accessibilityRole="image" accessibilityLabel="EdgeOne Security Test">
      <Svg width={size} height={height} viewBox="0 0 100 108">
        <Defs>
          <LinearGradient id="plinthTop" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#DCE8FF" />
            <Stop offset="1" stopColor="#B9CFFA" />
          </LinearGradient>
          <LinearGradient id="plinthSide" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#8FB3EE" />
            <Stop offset="1" stopColor="#6E97DF" />
          </LinearGradient>
          <LinearGradient id="shieldFace" x1="0.2" y1="0" x2="0.8" y2="1">
            <Stop offset="0" stopColor="#FFFFFF" />
            <Stop offset="1" stopColor="#D9E6FB" />
          </LinearGradient>
          <LinearGradient id="shieldEdge" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#A8C3F0" />
            <Stop offset="1" stopColor="#7FA5E6" />
          </LinearGradient>
        </Defs>

        {/* Plinth */}
        <Path d="M50 78 L92 92 L50 106 L8 92 Z" fill="url(#plinthSide)" />
        <Path d="M50 72 L92 86 L50 100 L8 86 Z" fill="url(#plinthTop)" opacity={0.95} />

        {/* Shield body */}
        <Path
          d="M50 6 L84 18 V48 C84 66 69 78 50 88 C31 78 16 66 16 48 V18 Z"
          fill="url(#shieldEdge)"
          transform="translate(0, 2)"
        />
        <Path d="M50 6 L84 18 V48 C84 66 69 78 50 88 C31 78 16 66 16 48 V18 Z" fill="url(#shieldFace)" />

        {/* Inner facet, giving the mark a subtle isometric feel */}
        <Path d="M50 6 L84 18 V48 C84 66 69 78 50 88 Z" fill="#C3D7F7" opacity={0.45} />

        {/* Checkmark */}
        <Path
          d="M33 47 L45 59 L68 34"
          stroke={palette.primary}
          strokeWidth={7.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </View>
  );
}
