import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { colors, fontFamily, type ColorName, type Weight } from '@/theme';

export type Variant = 'title' | 'heading' | 'body' | 'small' | 'caption';

const variants: Record<Variant, { size: number; line: number; weight: Weight }> = {
  title: { size: 24, line: 32, weight: 'bold' },
  heading: { size: 17, line: 24, weight: 'semibold' },
  body: { size: 15, line: 22, weight: 'regular' },
  small: { size: 14, line: 20, weight: 'regular' },
  caption: { size: 13, line: 18, weight: 'medium' },
};

export interface TextProps extends RNTextProps {
  variant?: Variant;
  color?: ColorName;
  weight?: Weight;
}

/** Themed text. Scales with the user's font size setting; nothing here fixes a height. */
export function Text({ variant = 'body', color = 'text', weight, style, ...rest }: TextProps) {
  const v = variants[variant];
  const base: TextStyle = {
    color: colors[color],
    fontSize: v.size,
    lineHeight: v.line,
    fontFamily: fontFamily[weight ?? v.weight],
  };
  return <RNText {...rest} style={[base, style]} />;
}
