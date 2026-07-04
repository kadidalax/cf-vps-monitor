import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

export interface WebsiteHeartbeatPoint {
  checked_at: string;
  ok: boolean;
  effective_status?: 'up' | 'down';
  effective_reason?: string | null;
  status_code?: number | null;
  raw_status_code?: number | null;
  latency_ms: number | null;
  source_type?: 'worker' | 'agent';
  source_client?: string | null;
}

function heartbeatResultText(check: WebsiteHeartbeatPoint) {
  const result = check.effective_status === 'down' || !check.ok ? '失效' : '正常';
  const statusCode = check.raw_status_code ?? check.status_code;
  const http = statusCode == null ? '' : ` · HTTP ${statusCode}`;
  return `${new Date(check.checked_at).toLocaleString()} · ${result}${http} · ${check.latency_ms ?? 0}ms`;
}

type HeartbeatTooltip = {
  text: string;
  anchorX: number;
  anchorTop: number;
  left: number;
  top: number;
  arrowLeft: number;
};

export default function WebsiteHeartbeatBar({
  checks,
  max = 60,
}: {
  checks: Array<WebsiteHeartbeatPoint | null>;
  max?: number;
}) {
  const visible = checks.slice(0, max).reverse();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<HeartbeatTooltip | null>(null);
  const blanks = Math.max(0, max - visible.length);
  const bars = [
    ...Array.from({ length: blanks }, (_, index) => ({ key: `blank-${index}`, state: 'empty', title: '暂无数据', interactive: false })),
    ...visible.map((check, index) => check ? ({
      key: check.checked_at,
      state: check.ok ? 'up' : 'down',
      title: heartbeatResultText(check),
      interactive: true,
    }) : ({ key: `slot-empty-${index}`, state: 'empty', title: '暂无数据', interactive: false })),
  ];

  const latest = [...visible].reverse().find((check): check is WebsiteHeartbeatPoint => Boolean(check));

  const showTooltip = (text: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const anchorX = rect.left + rect.width / 2;
    setTooltip({
      text,
      anchorX,
      anchorTop: rect.top,
      left: anchorX,
      top: Math.max(8, rect.top - 10),
      arrowLeft: 0,
    });
  };

  useLayoutEffect(() => {
    if (!tooltip) return;
    const element = tooltipRef.current;
    if (!element) return;

    const margin = 8;
    const rect = element.getBoundingClientRect();
    const halfWidth = rect.width / 2;
    const left = Math.min(
      Math.max(tooltip.anchorX, margin + halfWidth),
      window.innerWidth - margin - halfWidth,
    );
    const top = Math.max(margin, tooltip.anchorTop - rect.height - 10);
    const arrowLeft = Math.min(
      Math.max(tooltip.anchorX - (left - halfWidth), 10),
      Math.max(10, rect.width - 10),
    );

    if (
      Math.abs(left - tooltip.left) > 0.5 ||
      Math.abs(top - tooltip.top) > 0.5 ||
      Math.abs(arrowLeft - tooltip.arrowLeft) > 0.5
    ) {
      setTooltip({ ...tooltip, left, top, arrowLeft });
    }
  }, [tooltip]);

  return (
    <div
      className={`website-heartbeat-bar is-${latest?.ok ? 'up' : visible.length ? 'down' : 'pending'}`}
      aria-label="Website heartbeat history"
      style={{ '--heartbeat-segment-count': max } as CSSProperties}
    >
      {bars.map((bar) => (
        <span
          key={bar.key}
          className={`website-heartbeat-segment is-${bar.state}${bar.interactive ? ' is-interactive' : ''}`}
          data-tooltip={bar.interactive ? bar.title : undefined}
          aria-label={bar.interactive ? bar.title : undefined}
          tabIndex={bar.interactive ? 0 : undefined}
          onMouseEnter={bar.interactive ? (event) => showTooltip(bar.title, event.currentTarget) : undefined}
          onMouseLeave={bar.interactive ? () => setTooltip(null) : undefined}
          onPointerEnter={bar.interactive ? (event) => showTooltip(bar.title, event.currentTarget) : undefined}
          onPointerLeave={bar.interactive ? () => setTooltip(null) : undefined}
          onClick={bar.interactive ? (event) => showTooltip(bar.title, event.currentTarget) : undefined}
          onFocus={bar.interactive ? (event) => showTooltip(bar.title, event.currentTarget) : undefined}
          onBlur={bar.interactive ? () => setTooltip(null) : undefined}
        />
      ))}
      {tooltip && (
        <div
          ref={tooltipRef}
          className="website-heartbeat-tooltip"
          role="tooltip"
          style={{
            left: tooltip.left,
            top: tooltip.top,
            '--heartbeat-tooltip-arrow-left': `${tooltip.arrowLeft}px`,
          } as CSSProperties}
        >
          {tooltip.text}
          <span className="website-heartbeat-tooltip-arrow" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
