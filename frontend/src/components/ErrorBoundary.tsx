import { Component, ErrorInfo, ReactNode } from 'react';
import { Flex, Button, Heading, Text, Card, Code } from '@radix-ui/themes';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      const showDetail = import.meta.env.DEV;

      return (
        <Flex
          direction="column"
          align="center"
          justify="center"
          style={{ minHeight: '100vh', padding: '20px' }}
        >
          <Card style={{ maxWidth: '500px', width: '100%' }}>
            <Flex direction="column" align="center" gap="3" p="4">
              <AlertTriangle size={48} color="var(--orange-9)" />
              <Heading size="4">页面出错了</Heading>
              <Text size="2" color="gray">
                抱歉，页面遇到了一个错误。请尝试刷新页面。
              </Text>
              {showDetail && this.state.error && (
                <Code size="1" style={{
                  maxWidth: '100%', padding: '8px', borderRadius: '4px',
                  backgroundColor: 'var(--gray-3)', wordBreak: 'break-all',
                  fontSize: '11px', maxHeight: '60px', overflow: 'auto',
                }}>
                  {this.state.error.message}
                </Code>
              )}
              <Flex gap="3" mt="2">
                <Button onClick={this.handleReload}>
                  <RefreshCw size={16} /> 刷新页面
                </Button>
                <Button variant="soft" onClick={this.handleGoHome}>
                  <Home size={16} /> 返回首页
                </Button>
              </Flex>
            </Flex>
          </Card>
        </Flex>
      );
    }

    return this.props.children;
  }
}
