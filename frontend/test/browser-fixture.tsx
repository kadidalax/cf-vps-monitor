import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import '@radix-ui/themes/styles.css';
import '../src/index.css';
import NodeTable from '../src/components/NodeTable';
import { SettingCard, SettingInput, SettingTextarea, SettingToggle } from '../src/components/admin/SettingCard';
import { requestPassword } from '../src/utils/reauth';
import { normalizePublicClients } from '../src/utils/publicClients';
import { AuthProvider, useAuth } from '../src/contexts/AuthContext';
import { LiveDataProvider, useLiveData } from '../src/contexts/LiveDataContext';

function LiveProbe() {
  const { liveData, clientMetadata, snapshotReady, loading, error, refresh } = useLiveData();
  return <><pre id="live-result">{JSON.stringify({ liveData, clientMetadata, snapshotReady, loading, error })}</pre><button id="live-refresh" onClick={refresh}>刷新实时快照</button></>;
}

function LiveControls() {
  const auth = useAuth();
  const [mounted, setMounted] = useState(true);
  return <>
    <button id="live-clear-auth" onClick={auth.clearAuth}>清除已失效会话</button>
    <button id="live-remount" onClick={() => setMounted(value => !value)}>切换数据组件</button>
    <span id="live-auth">{String(auth.isAuthenticated)}</span>
    {mounted && <LiveDataProvider><LiveProbe /></LiveDataProvider>}
  </>;
}

function Controls() {
  const [value, setValue] = useState('synthetic');
  const [checked, setChecked] = useState(false);
  return <>
    <SettingCard title="测试分组"><SettingInput label="测试地址" value={value} onChange={setValue} /><SettingTextarea label="测试备注" value={value} onChange={setValue} /><SettingToggle label="测试开关" checked={checked} onCheckedChange={setChecked} /></SettingCard>
    <button id="password-trigger" onClick={() => void requestPassword('输入测试密码').then(value => { (window as any).auditPasswordResult = value; })}>打开密码框</button>
    <button id="outside-button">模态外部按钮</button>
  </>;
}

const root = createRoot(document.getElementById('fixture-root')!);
(window as any).mountAuditFixture = (kind: string) => {
  const nodes = normalizePublicClients([{ uuid: 'node-b', name: 'Zulu', sort_order: 0 }, { uuid: 'node-a', name: 'Alpha', sort_order: 1 }]);
  root.render(<MemoryRouter><Theme><div style={{ padding: 24 }}>{kind === 'live' ? <AuthProvider><LiveControls /></AuthProvider> : kind === 'table' ? <NodeTable nodes={nodes} liveData={{ online: [], data: {} }} /> : <Controls />}</div></Theme></MemoryRouter>);
};
