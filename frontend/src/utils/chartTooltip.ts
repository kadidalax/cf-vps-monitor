import type { CSSProperties } from 'react';

export const chartTooltipProps = {
  contentStyle: {
    // Keep a solid backing beneath the display theme's translucent surface.
    backgroundColor: 'var(--color-panel-solid)',
    backgroundImage: 'linear-gradient(var(--monitor-panel-strong), var(--monitor-panel-strong))',
    color: 'var(--gray-12)',
    border: '1px solid var(--monitor-border)',
    borderRadius: 'var(--monitor-card-radius, 8px)',
    boxShadow: 'var(--monitor-shadow)',
  },
  labelStyle: { color: 'var(--gray-12)' },
  itemStyle: { color: 'var(--gray-12)' },
} satisfies Record<'contentStyle' | 'labelStyle' | 'itemStyle', CSSProperties>;
