// JSX typing for the <hyperframes-player> web component (@hyperframes/player, Apache-2.0).
import type { JSX } from 'preact';

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'hyperframes-player': JSX.HTMLAttributes<HTMLElement> & {
        src?: string;
        srcdoc?: string;
        width?: number | string;
        height?: number | string;
        controls?: boolean;
        muted?: boolean;
      };
    }
  }
}

export {};
