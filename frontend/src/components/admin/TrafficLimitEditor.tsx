import { Box, Flex, Select, Text, TextField } from '@radix-ui/themes';
import {
  BANDWIDTH_UNITS,
  TRAFFIC_LIMIT_TYPES,
  TRAFFIC_LIMIT_UNITS,
  TrafficLimitFormValue,
  TrafficLimitMode,
} from '../../utils/traffic';

export function TrafficLimitEditor({
  value,
  onChange,
}: {
  value: TrafficLimitFormValue;
  onChange: (value: TrafficLimitFormValue) => void;
}) {
  const update = (patch: Partial<TrafficLimitFormValue>) => onChange({ ...value, ...patch });

  return (
    <Box className="traffic-limit-editor">
      <Text size="2" weight="bold" style={{ display: 'block', marginBottom: 4 }}>
        流量限制
      </Text>
      <Flex className="traffic-limit-controls" gap="2" align="center" wrap="nowrap">
        <Select.Root value={value.mode} onValueChange={(next) => update({ mode: next as TrafficLimitMode })}>
          <Select.Trigger className="traffic-limit-mode-select" />
          <Select.Content>
            <Select.Item value="quota">固定流量</Select.Item>
            <Select.Item value="unlimited">无限流量</Select.Item>
            <Select.Item value="bandwidth">带宽无限</Select.Item>
          </Select.Content>
        </Select.Root>

        {value.mode === 'quota' && (
          <>
            <TextField.Root
              className="traffic-limit-number-input"
              value={value.value}
              onChange={(event) => update({ value: event.target.value })}
              type="number"
              min="0"
              step="0.01"
            />
            <Select.Root value={value.unit} onValueChange={(next) => update({ unit: next as TrafficLimitFormValue['unit'] })}>
              <Select.Trigger className="traffic-limit-unit-select" />
              <Select.Content>
                {TRAFFIC_LIMIT_UNITS.map((unit) => (
                  <Select.Item key={unit.value} value={unit.value}>
                    {unit.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <Select.Root value={value.type} onValueChange={(next) => update({ type: next })}>
              <Select.Trigger className="traffic-limit-type-select" />
              <Select.Content>
                {TRAFFIC_LIMIT_TYPES.map((type) => (
                  <Select.Item key={type.value} value={type.value}>
                    {type.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </>
        )}

        {value.mode === 'bandwidth' && (
          <>
            <TextField.Root
              className="traffic-limit-number-input"
              value={value.bandwidthValue}
              onChange={(event) => update({ bandwidthValue: event.target.value })}
              type="number"
              min="0"
              step="0.01"
            />
            <Select.Root value={value.bandwidthUnit} onValueChange={(next) => update({ bandwidthUnit: next as TrafficLimitFormValue['bandwidthUnit'] })}>
              <Select.Trigger className="traffic-limit-bandwidth-unit-select" />
              <Select.Content>
                {BANDWIDTH_UNITS.map((unit) => (
                  <Select.Item key={unit} value={unit}>
                    {unit}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </>
        )}
      </Flex>
    </Box>
  );
}
