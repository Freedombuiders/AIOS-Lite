/**
 * Be Vietnam Pro, the face the desktop mockups use for Vietnamese text. The
 * font files ship inside the app bundle (the @expo-google-fonts package holds
 * the TTFs), so nothing is downloaded at run time.
 */
import {
  BeVietnamPro_400Regular,
  BeVietnamPro_500Medium,
  BeVietnamPro_600SemiBold,
  BeVietnamPro_700Bold,
} from '@expo-google-fonts/be-vietnam-pro';

export const fontFiles = {
  BeVietnamPro_400Regular,
  BeVietnamPro_500Medium,
  BeVietnamPro_600SemiBold,
  BeVietnamPro_700Bold,
};

export type Weight = 'regular' | 'medium' | 'semibold' | 'bold';

export const fontFamily: Record<Weight, string> = {
  regular: 'BeVietnamPro_400Regular',
  medium: 'BeVietnamPro_500Medium',
  semibold: 'BeVietnamPro_600SemiBold',
  bold: 'BeVietnamPro_700Bold',
};
