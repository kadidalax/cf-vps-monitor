/**
 * Reusable SettingCard components for admin forms.
 * Provides collapsible sections with consistent styling
 */
import React, { useId, useState } from 'react';
import { Card, Flex, Text, Switch, TextField, TextArea } from '@radix-ui/themes';
import { ChevronDown, ChevronRight } from 'lucide-react';

/* ========== Collapsible SettingCard ========== */
interface SettingCardProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SettingCard({
  title,
  description,
  children,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
}: SettingCardProps) {
  const contentId = useId();
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const toggle = () => {
    const next = !open;
    if (isControlled) {
      onOpenChange?.(next);
    } else {
      setInternalOpen(next);
      onOpenChange?.(next);
    }
  };

  return (
    <Card style={{ marginBottom: 12 }}>
      <button
        type="button"
        className="setting-card-toggle"
        aria-label={title}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={toggle}
      >
        <Flex direction="column">
          <Text size="3" weight="bold">{title}</Text>
          {description && <Text size="1" color="gray">{description}</Text>}
        </Flex>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
      </button>
        <div id={contentId} hidden={!open} style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gray-4)' }}>
          {children}
        </div>
    </Card>
  );
}

/* ========== Setting Row ========== */
interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  controlId?: string;
}

export function SettingRow({ label, description, children, controlId }: SettingRowProps) {
  return (
    <Flex justify="between" align="center" style={{ padding: '8px 0' }}>
      <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
        {controlId ? <label htmlFor={controlId}><Text size="2" weight="medium">{label}</Text></label> : <Text size="2" weight="medium">{label}</Text>}
        {description && <Text id={controlId ? `${controlId}-description` : undefined} size="1" color="gray">{description}</Text>}
      </Flex>
      <div style={{ flexShrink: 0, marginLeft: 16 }}>{children}</div>
    </Flex>
  );
}

/* ========== Setting Toggle ========== */
interface SettingToggleProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SettingToggle({ label, description, checked, onCheckedChange }: SettingToggleProps) {
  const id = useId();
  return (
    <SettingRow label={label} description={description} controlId={id}>
      <Switch id={id} aria-describedby={description ? `${id}-description` : undefined} checked={checked} onCheckedChange={onCheckedChange} />
    </SettingRow>
  );
}

/* ========== Setting Input ========== */
interface SettingInputProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  width?: number | string;
}

export function SettingInput({ label, description, value, onChange, type, placeholder, width }: SettingInputProps) {
  const id = useId();
  const inputWidth = width || (type === 'number' ? 180 : type === 'password' ? 360 : 420);

  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: 4 }}><Text size="2" weight="medium">{label}</Text></label>
      {description && <Text id={`${id}-description`} size="1" color="gray" style={{ display: 'block', marginBottom: 6 }}>{description}</Text>}
      <TextField.Root
        id={id}
        aria-describedby={description ? `${id}-description` : undefined}
        size="2"
        style={{ width: inputWidth, maxWidth: '100%' }}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        type={(type || 'text') as any}
        placeholder={placeholder}
      />
    </div>
  );
}

/* ========== Setting Textarea ========== */
interface SettingTextareaProps {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}

export function SettingTextarea({ label, description, value, onChange, rows, placeholder }: SettingTextareaProps) {
  const id = useId();
  return (
    <div style={{ marginBottom: 12 }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: 4 }}><Text size="2" weight="medium">{label}</Text></label>
      {description && <Text id={`${id}-description`} size="1" color="gray" style={{ display: 'block', marginBottom: 6 }}>{description}</Text>}
      <TextArea
        id={id}
        aria-describedby={description ? `${id}-description` : undefined}
        style={{ width: 'min(720px, 100%)' }}
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows || 3}
        placeholder={placeholder}
      />
    </div>
  );
}
