export const monitorYAxisWidth = 32;
export const wideYAxisWidth = 48;
export const pingYAxisWidth = monitorYAxisWidth;

export const monitorYAxisProps = {
  width: monitorYAxisWidth,
  fontSize: 12,
  tickCount: 5,
  tickSize: 2,
  tickMargin: 0,
  tickLine: true,
  axisLine: true,
};

export const wideYAxisProps = {
  ...monitorYAxisProps,
  width: wideYAxisWidth,
};

export const pingYAxisProps = {
  ...monitorYAxisProps,
  width: pingYAxisWidth,
};
