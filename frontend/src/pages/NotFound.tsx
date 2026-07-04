import { Flex, Text, Button, Heading, Box } from '@radix-ui/themes';
import { Home, Monitor } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatAppVersion } from '../utils/version';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <Flex
      direction="column"
      align="center"
      justify="center"
      style={{ minHeight: '100vh', padding: '20px', gap: '16px' }}
    >
      <Box style={{
        width: 80, height: 80, borderRadius: '20px',
        background: 'linear-gradient(135deg, var(--accent-9), var(--accent-10))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Monitor size={40} color="white" />
      </Box>
      <Heading size="7" style={{ letterSpacing: '-0.02em' }}>404</Heading>
      <Text size="3" color="gray">页面未找到</Text>
      <Flex gap="3" mt="2">
        <Button onClick={() => navigate('/')}>
          <Home size={16} /> 返回首页
        </Button>
        <Button variant="soft" onClick={() => navigate('/admin')}>
          管理后台
        </Button>
      </Flex>
      <Text size="1" color="gray" mt="4">
        CF VPS Monitor {formatAppVersion()}
      </Text>
    </Flex>
  );
}
