import type { ButtonHTMLAttributes, ReactNode } from 'react';
import * as Dialog from '@/ui/components/ui/dialog';
import { cn } from '@/ui/lib/utils';
import { Check, Globe, Loader2 } from '../icons';
import type { BrowserImportSource, BrowserImportSourceInfo } from '../../types';
import { useBrowserNativeOverlayRegistration } from './browser-native-overlay';

export const BROWSER_DIALOG_LIST_CLASS =
  'divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]';

export function BrowserDialog({
  open,
  onOpenChange,
  width = 440,
  dismissible = true,
  children,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  width?: number;
  dismissible?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}) {
  // The native page view paints above the DOM; it must step aside for the dialog.
  useBrowserNativeOverlayRegistration(open);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next || dismissible) && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/25 backdrop-blur-[2px] transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Content
          data-testid={rest['data-testid']}
          style={{ width }}
          className="fixed left-1/2 top-1/2 z-[201] flex max-h-[calc(100vh-4rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-[18px] border border-[var(--popover-border)] bg-[var(--popover-bg)] p-5 shadow-[var(--popover-shadow-lg)] outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0"
        >
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function BrowserDialogHeader({ title, subtitle, leading }: { title: ReactNode; subtitle?: ReactNode; leading?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {leading}
      <div className="flex flex-col gap-1">
        <Dialog.Title className="text-[15px] font-semibold leading-5 text-[var(--text-primary)]">{title}</Dialog.Title>
        {subtitle ? (
          <Dialog.Description className="text-[13px] leading-5 text-[var(--text-secondary)]">{subtitle}</Dialog.Description>
        ) : null}
      </div>
    </div>
  );
}

export function BrowserDialogFooter({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-2">{children}</div>;
}

const BUTTON_VARIANTS = {
  primary: 'bg-[var(--text-primary)] text-[var(--bg-primary)] hover:opacity-90',
  secondary: 'bg-[var(--sidebar-item-hover)] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-active)]',
  outline: 'border border-[var(--border)] text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]',
  ghost: 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]',
} as const;

export function BrowserDialogButton({
  variant = 'secondary',
  size = 'default',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: 'default' | 'toolbar';
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap font-medium outline-none transition-[background-color,opacity] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-45',
        size === 'toolbar' ? 'h-7 rounded-[9px] px-2.5 text-[12px]' : 'h-8 rounded-[10px] px-3.5 text-[13px]',
        BUTTON_VARIANTS[variant],
        className
      )}
      {...props}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function BrowserDialogRow({
  icon,
  label,
  description,
  control,
  disabled = false,
  htmlFor,
}: {
  icon: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  disabled?: boolean;
  htmlFor?: string;
}) {
  return (
    <div className={cn('flex min-h-12 items-center gap-3 px-3 py-2.5', disabled && 'opacity-55')}>
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--text-secondary)]">{icon}</span>
      <label htmlFor={htmlFor} className="flex min-w-0 flex-1 select-none flex-col gap-0.5">
        <span className="text-[13px] font-medium leading-[18px] text-[var(--text-primary)]">{label}</span>
        {description ? <span className="text-[12px] leading-4 text-[var(--text-secondary)]">{description}</span> : null}
      </label>
      {control}
    </div>
  );
}

export function BrowserCheckbox({
  id,
  checked,
  disabled,
  onChange,
  label,
}: {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-45',
        checked
          ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-[var(--bg-primary)]'
          : 'border-[color-mix(in_srgb,var(--text-primary)_28%,transparent)] bg-transparent'
      )}
    >
      {checked ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" /> : null}
    </button>
  );
}

export function BrowserSegmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-[9px] bg-[var(--sidebar-item-hover)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-6 rounded-[7px] px-2.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-45',
            value === option.value
              ? 'bg-[var(--popover-bg)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function BrowserSourceIcon({
  source,
  sources,
  className = 'h-4 w-4',
}: {
  source: BrowserImportSource;
  sources?: BrowserImportSourceInfo[];
  className?: string;
}) {
  const icon = sources?.find((info) => info.source === source)?.iconDataUrl;
  return icon ? (
    <img src={icon} alt="" aria-hidden="true" draggable={false} className={cn('shrink-0 object-contain', className)} />
  ) : (
    <Globe className={cn('shrink-0 text-[var(--text-muted)]', className)} aria-hidden="true" />
  );
}
