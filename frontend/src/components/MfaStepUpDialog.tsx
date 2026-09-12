import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Flex, SegmentedControl, Text, TextField } from '@radix-ui/themes';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { buildApiRequest } from '../utils/api';
import { normalizeMfaCode, registerMfaStepUpHandler, type MfaMethod } from '../utils/mfa';

export default function MfaStepUpDialog() {
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const pendingRequestRef = useRef<{ resolver: (value: boolean) => void; controller: AbortController } | null>(null);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<MfaMethod>('totp');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const finish = (success: boolean) => {
    if (!resolver.current) return;
    const resolve = resolver.current;
    resolver.current = null;
    pendingRequestRef.current?.controller.abort();
    pendingRequestRef.current = null;
    setOpen(false);
    setSubmitting(false);
    setCode('');
    setError('');
    setMethod('totp');
    resolve(success);
  };

  useEffect(() => registerMfaStepUpHandler(() => new Promise<boolean>((resolve) => {
    resolver.current = resolve;
    setOpen(true);
  })), []);

  useEffect(() => () => {
    pendingRequestRef.current?.controller.abort();
    pendingRequestRef.current = null;
    resolver.current?.(false);
    resolver.current = null;
  }, []);

  const submit = async () => {
    const activeResolver = resolver.current;
    if (!activeResolver || pendingRequestRef.current) return;
    const normalized = normalizeMfaCode(code, method);
    if (!normalized) {
      setError(method === 'totp' ? '请输入 6 位动态验证码' : '恢复码格式无效');
      return;
    }

    const request = { resolver: activeResolver, controller: new AbortController() };
    pendingRequestRef.current = request;
    const isCurrent = () => resolver.current === activeResolver && pendingRequestRef.current === request;
    setSubmitting(true);
    setError('');
    try {
      const { url, init } = buildApiRequest('/admin/account/mfa/step-up', {
        method: 'POST',
        signal: request.controller.signal,
        body: JSON.stringify({ method, code: normalized }),
      });
      const response = await fetch(url, init);
      const data = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!response.ok) {
        setError(data.error || '验证失败');
        return;
      }
      finish(true);
    } catch {
      if (isCurrent()) setError('网络错误，请稍后重试');
    } finally {
      if (pendingRequestRef.current === request) {
        pendingRequestRef.current = null;
        setSubmitting(false);
      }
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen) finish(false);
    }}>
      <Dialog.Content className="mfa-step-up-dialog" style={{ maxWidth: 420 }}>
        <Dialog.Title>
          <Flex align="center" gap="2"><ShieldCheck size={20} />确认敏感操作</Flex>
        </Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          本次验证通过后，5 分钟内执行敏感操作无需重复输入。
        </Dialog.Description>

        <Flex direction="column" gap="3">
          <SegmentedControl.Root
            value={method}
            disabled={submitting}
            onValueChange={(value) => {
              if (pendingRequestRef.current) return;
              setMethod(value as MfaMethod);
              setCode('');
              setError('');
            }}
          >
            <SegmentedControl.Item value="totp">动态验证码</SegmentedControl.Item>
            <SegmentedControl.Item value="recovery_code">恢复码</SegmentedControl.Item>
          </SegmentedControl.Root>

          <label htmlFor="mfa-step-up-code">
            <Text size="2" weight="bold">
              {method === 'totp' ? '6 位验证码' : '一次性恢复码'}
            </Text>
            <TextField.Root
              id="mfa-step-up-code"
              mt="1"
              size="3"
              value={code}
              readOnly={submitting}
              onChange={(event) => setCode(event.target.value)}
              placeholder={method === 'totp' ? '000000' : 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX'}
              autoComplete="one-time-code"
              inputMode={method === 'totp' ? 'numeric' : 'text'}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </label>

          {error && <Text size="2" color="red" role="alert">{error}</Text>}

          <Flex justify="end" gap="2" mt="2">
            <Button variant="soft" color="gray" onClick={() => finish(false)}>
              取消
            </Button>
            <Button disabled={submitting} onClick={() => void submit()}>
              <KeyRound size={16} />{submitting ? '验证中...' : '确认'}
            </Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
