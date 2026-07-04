/**
 * Reusable SettingCard components for admin forms.
 * Provides collapsible sections with consistent styling
 */
import React, { useState } from 'react';
import { Card, Flex, Text, Switch, TextField, TextArea, IconButton } from '@radix-ui/themes';
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
      <Flex
        align="center"
        justify="between"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={toggle}
      >
        <Flex direction="column">
          <Text size="3" weight="bold">{title}</Text>
          {description && <Text size="1" color="gray">{description}</Text>}
        </Flex>
        <IconButton variant="ghost" size="1">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </IconButton>
      </Flex>
      {open && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--gray-4)' }}>
          {children}
        </div>
      )}
    </Card>
  );
}

/* ========== Setting Row ========== */
interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

export function SettingRow({ label, description, children }: SettingRowProps) {
  return (
    <Flex justify="between" align="center" style={{ padding: '8px 0' }}>
      <Flex direction="column" style={{ flex: 1, minWidth: 0 }}>
        <Text size="2" weight="medium">{label}</Text>
        {description && <Text size="1" color="gray">{description}</Text>}
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
  return (
    <SettingRow label={label} description={description}>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
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
  const inputWidth = width || (type === 'number' ? 180 : type === 'password' ? 360 : 420);

  return (
    <div style={{ marginBottom: 12 }}>
      <Text size="2" weight="medium" style={{ display: 'block', marginBottom: 4 }}>{label}</Text>
      {description && <Text size="1" color="gray" style={{ display: 'block', marginBottom: 6 }}>{description}</Text>}
      <TextField.Root
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
  return (
    <div style={{ marginBottom: 12 }}>
      <Text size="2" weight="medium" style={{ display: 'block', marginBottom: 4 }}>{label}</Text>
      {description && <Text size="1" color="gray" style={{ display: 'block', marginBottom: 6 }}>{description}</Text>}
      <TextArea
        style={{ width: 'min(720px, 100%)' }}
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows || 3}
        placeholder={placeholder}
      />
    </div>
  );
}
