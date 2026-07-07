import React, { useCallback, useState } from 'react';
import { Popover } from '@radix-ui/themes';
import { Popover as PopoverPrimitive } from 'radix-ui';
import MiniPingChart from './MiniPingChart';

interface MiniPingChartFloatProps {
  uuid: string;
  trigger: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  chartWidth?: string | number;
  chartHeight?: number;
  limit?: number;
  rangeHours?: number;
  includeHidden?: boolean;
}

export default function MiniPingChartFloat({
  uuid,
  trigger,
  chartWidth = 440,
  chartHeight = 260,
  limit = 360,
  rangeHours = 1,
  includeHidden = false,
}: MiniPingChartFloatProps) {
  const [open, setOpen] = useState(false);

  const handleTriggerClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    trigger.props.onClick?.(event);
  }, [trigger]);

  const handleTriggerPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    trigger.props.onPointerDown?.(event);
    event.stopPropagation();
  }, [trigger]);

  const triggerElement = React.cloneElement(trigger, {
    onClick: handleTriggerClick,
    onPointerDown: handleTriggerPointerDown,
  });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        {triggerElement}
      </PopoverPrimitive.Trigger>
      <Popover.Content
        align="end"
        sideOffset={8}
        onClick={(event) => event.stopPropagation()}
        style={{
          padding: 0,
          border: 'none',
          boxShadow: 'hsl(206 22% 7% / 35%) 0px 10px 38px -10px, hsl(206 22% 7% / 20%) 0px 10px 20px -15px',
          borderRadius: 'var(--radius-3)',
          zIndex: 5,
          width: chartWidth,
          maxWidth: 'calc(100vw - 24px)',
        }}
      >
        <MiniPingChart uuid={uuid} width="100%" height={chartHeight} limit={limit} rangeHours={rangeHours} includeHidden={includeHidden} />
      </Popover.Content>
    </Popover.Root>
  );
}
