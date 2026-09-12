import assert from 'node:assert/strict';
import { createHarness, settleCall, settleRender, waitForCall } from './helpers/harness.mjs';

const moduleFlag = process.argv.indexOf('--playwright-module');
const playwrightModule = moduleFlag >= 0 ? process.argv[moduleFlag + 1] : process.env.CF_MONITOR_PLAYWRIGHT_MODULE;
const { origin, check, finish } = await createHarness({ selection: 'ALL', playwrightModule });

try {
  for (const mode of ['continue', 'cancel', 'normal']) {
    await check(`R-D05-backup-${mode}`, 'recovery remains a deliberate available action after a failed safety backup', async (page, data) => {
      const confirmations = [];
      const downloads = [];
      page.on('download', download => downloads.push(download.suggestedFilename()));
      page.on('dialog', async dialog => {
        confirmations.push({ type: dialog.type(), message: dialog.message() });
        if (mode === 'continue') await dialog.accept();
        else await dialog.dismiss();
      });
      data.handlers.push(async ({ path, json }) => {
        if (path === '/api/admin/download/backup') {
          await json(mode === 'normal' ? { format: 'synthetic-encrypted-backup' } : { error: '备份失败' }, mode === 'normal' ? 200 : 500);
          return true;
        }
        if (path === '/api/admin/upload/backup') { await json({ success: true }); return true; }
        return false;
      });
      await page.goto(origin + '/admin/settings');
      await page.getByRole('button', { name: '导入备份', exact: true }).waitFor();
      await page.locator('#backup-upload-site').setInputFiles({ name: 'synthetic-recovery.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":true}') });
      const password = page.getByRole('dialog', { name: '请输入该备份文件的加密密码', exact: true });
      await password.locator('input[type="password"]').fill('synthetic-input-password');
      await password.getByRole('button', { name: '确认', exact: true }).click();
      const safetyPassword = page.getByRole('dialog', { name: /恢复前会自动下载当前配置的加密备份/ });
      await safetyPassword.locator('input[type="password"]').fill('synthetic-safety-password');
      await safetyPassword.getByRole('button', { name: '确认', exact: true }).click();
      await settleCall(page, await waitForCall(data, call => call.path === '/api/admin/download/backup'));
      await settleRender(page);
      data.observed = { confirmations, downloads, restoreCalls: data.calls.filter(call => call.path === '/api/admin/upload/backup').length };
      assert.equal(confirmations.length, mode === 'normal' ? 0 : 1, 'An actual failed backup must offer a deliberate recovery decision');
      if (mode !== 'normal') {
        assert.equal(confirmations[0].type, 'confirm');
        assert.match(confirmations[0].message, /备份.*失败/);
        assert.match(confirmations[0].message, /覆盖.*当前配置/);
        assert.equal(downloads.length, 0, 'A failed download must never look like a usable backup');
      }
      if (mode === 'cancel') {
        assert.equal(data.observed.restoreCalls, 0, 'Cancel preserves the current configuration');
      } else {
        const restore = await waitForCall(data, call => call.path === '/api/admin/upload/backup');
        await settleCall(page, restore);
        assert.equal(restore.body.confirm_restore, true);
        assert.equal(restore.body.acknowledge_overwrite, true);
        assert.equal(restore.body.backup_password, 'synthetic-input-password');
        await page.getByText('备份已恢复', { exact: true }).waitFor();
        if (mode === 'normal') assert.equal(downloads.length, 1, 'Normal restore still downloads the previous configuration first');
      }
    });
  }
} finally { await finish(); }
