import React from 'react';
import { Flex, Text, Box } from '@radix-ui/themes';

interface LoadingProps {
  fullScreen?: boolean;
  text?: string;
}

export default function Loading({ fullScreen, text }: LoadingProps) {
  const containerStyle: React.CSSProperties = fullScreen
    ? { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }
    : { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px 16px' };

  return (
    <Flex style={containerStyle} direction="column" align="center" gap="3">
      <Box
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          border: '3px solid var(--gray-4)',
          borderTopColor: 'var(--accent-9)',
        }}
        className="loading-spinner"
      />
      <Text size="2" color="gray">
        {text || '加载中...'}
      </Text>
    </Flex>
  );
}