export interface ToggleProps {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

export function Toggle({ on, onChange, disabled, size = 'md', ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
      class={`toggle ${size === 'sm' ? 'toggle-sm' : ''} ${on ? 'is-on' : ''}`}
      onClick={onChange}
    />
  );
}
