const { chromium } = require('playwright');
const { PDFDocument } = require('pdf-lib');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const BASE_URL = process.env.PEPPERCIPHER_URL || 'http://127.0.0.1:4173/index.html';
const report = { url: BASE_URL, startedAt: new Date().toISOString(), tests: [], pageErrors: [], consoleErrors: [], externalRequests: [] };
let browser;

async function test(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    report.tests.push({ name, passed: true, durationMs: Date.now() - started, details: details || null });
    console.log('PASS ' + name + (details ? ' — ' + JSON.stringify(details) : ''));
  } catch (error) {
    report.tests.push({ name, passed: false, durationMs: Date.now() - started, error: String(error && error.stack || error) });
    console.error('FAIL ' + name + '\n' + (error && error.stack || error));
    throw error;
  }
}

const HUMAN_SAFE_ALPHABET = '234679ACDEFGHJKMNPQRTVWXYZ-_';
const HUMAN_SAFE_INDEX = Object.fromEntries([...HUMAN_SAFE_ALPHABET].map((ch, i) => [ch, i]));
function decodeHumanSafe(str) {
  if (!str) return Buffer.alloc(0);
  for (const ch of str) if (HUMAN_SAFE_INDEX[ch] === undefined) throw new Error('安全字符编码无效。');
  let leading = 0;
  while (leading < str.length && str[leading] === HUMAN_SAFE_ALPHABET[0]) leading++;
  const bytes = [];
  for (let i = leading; i < str.length; i++) {
    let carry = HUMAN_SAFE_INDEX[str[i]];
    for (let j = 0; j < bytes.length; j++) { const v = bytes[j] * HUMAN_SAFE_ALPHABET.length + carry; bytes[j] = v & 255; carry = Math.floor(v / 256); }
    while (carry) { bytes.push(carry & 255); carry = Math.floor(carry / 256); }
  }
  const out = Buffer.alloc(leading + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}
function parseHumanSafePackage(text, prefix) {
  return JSON.parse(decodeHumanSafe(text.slice(prefix.length)).toString('utf8'));
}

async function waitForResult(page, selector, timeout = 120000) {
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    return el && el.classList.contains('show');
  }, selector, { timeout });
}

async function saveDownload(page, selector, path) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.locator(selector).click()
  ]);
  await download.saveAs(path);
  return { suggestedFilename: download.suggestedFilename(), path };
}

(async () => {
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push(String(error && error.stack || error)));
    page.on('console', msg => { if (msg.type() === 'error') report.consoleErrors.push(msg.text()); });
    page.on('request', req => {
      const url = req.url();
      if (!url.startsWith('http://127.0.0.1:4173/') && !url.startsWith('http://localhost:4173/')) report.externalRequests.push(url);
    });

    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.waitForSelector('#app');
    assert.equal(await page.locator('#fatal.show').count(), 0, 'application must not enter fatal state');

    await test('页面启动与六个主标签', async () => {
      const tabs = ['ca', 'te', 'td', 'fe', 'fd', 'pr'];
      for (const tab of tabs) {
        await page.locator('#tab-' + tab).click();
        assert.equal(await page.locator('#tab-' + tab).getAttribute('aria-selected'), 'true', 'tab ' + tab);
        assert.equal(await page.locator('#panel-' + tab).evaluate(el => el.classList.contains('active')), true, 'panel ' + tab);
      }
      return { tabsChecked: tabs.length, fatalBanner: false };
    });

    await test('帮助版本同步且不包含已移除的校准操作', async () => {
      await page.locator('#helpBtn').click();
      const help = await page.locator('#helpBody').innerText();
      const versionMatch = help.match(/版本 (\d{4}\.\d{2}\.\d{2}\.\d{2})/);
      const footer = await page.locator('footer').innerText();
      const footerVersionMatch = footer.match(/PepperCipher (\d{4}\.\d{2}\.\d{2}\.\d{2})/);
      assert.ok(versionMatch, 'help should display the current app version');
      assert.ok(footerVersionMatch, 'footer should display the app version');
      assert.equal(versionMatch[1], footerVersionMatch[1], 'help and footer versions must match');
      assert.doesNotMatch(help, /校准当前 m \/ p/);
      await page.locator('#helpClose').click();
      return { helpVersion: versionMatch[1], footerVersion: footerVersionMatch[1], staleCalibrationText: false };
    });

    await test('源码版本号三处同步', async () => {
      const path = require('node:path');
      const candidates = ['index.html', path.join(__dirname, '..', 'index.html')];
      const sourcePath = candidates.find(p => fs.existsSync(p));
      assert.ok(sourcePath, 'index.html source must be readable for the version-sync check');
      const source = fs.readFileSync(sourcePath, 'utf8');
      const footerStatic = source.match(/id="appVersion">(\d{4}\.\d{2}\.\d{2}\.\d{2})</)?.[1];
      const appVersion = source.match(/APP_VERSION:'(\d{4}\.\d{2}\.\d{2}\.\d{2})'/)?.[1];
      const pepperVersion = source.match(/PEPPERCIPHER_VERSION='(\d{4}\.\d{2}\.\d{2}\.\d{2})'/)?.[1];
      assert.ok(footerStatic && appVersion && pepperVersion, 'footer, APP_VERSION and PEPPERCIPHER_VERSION must all exist in source');
      assert.equal(footerStatic, pepperVersion, 'static footer version must match PEPPERCIPHER_VERSION');
      assert.equal(appVersion, pepperVersion, 'APP_VERSION must match PEPPERCIPHER_VERSION');
      return { footerStatic, appVersion, pepperVersion };
    });

    await test('内置加密与格式安全自检', async () => {
      await page.locator('#selfTestBtn').click();
      await page.locator('#runTests').click();
      await page.waitForFunction(() => {
        const toast = [...document.querySelectorAll('.toast')].map(x => x.textContent || '').join(' ');
        return toast.includes('自检完成');
      }, null, { timeout: 900000 });
      const rows = await page.locator('#testResults .testrow').evaluateAll(els => els.map(el => ({
        name: el.querySelector('span')?.textContent || '',
        passed: !!el.querySelector('strong.ok'),
        result: el.querySelector('strong')?.textContent || ''
      })));
      assert.ok(rows.length >= 22, 'expected the full built-in suite including the clock regression test; got ' + rows.length);
      const failed = rows.filter(x => !x.passed);
      assert.deepEqual(failed, [], 'self-tests must all pass');
      await page.locator('#selfTestDialog [data-close-dialog="selfTestDialog"]').first().click().catch(() => {});
      return { selfTestsPassed: rows.length, failed: 0 };
    });

    await test('文本加密进度及时刷新且密码模式往返成功', async () => {
      await page.locator('#tab-te').click();
      await page.locator('#teCatalogMode').selectOption('none');
      await page.locator('#tePlain').fill('PepperCipher browser audit\n中文 Unicode 🔐\nline 3');
      await page.locator('#tePass').fill('Audit-Pepper-Password-2026!');
      await page.locator('#tePass2').fill('Audit-Pepper-Password-2026!');
      await page.locator('#teArgonMemory').fill('16384');
      await page.locator('#teArgonTime').fill('2');
      await page.locator('#teArgonParallel').fill('1');
      const oldCipher = await page.locator('#teCipher').inputValue();
      await page.evaluate(() => { window.__pcPctSamples = []; const el = document.querySelector('#tePct'); const observer = new MutationObserver(() => { if (el) window.__pcPctSamples.push(el.textContent || ''); }); observer.observe(el, { childList: true, characterData: true, subtree: true }); window.__pcPctObserver = observer; });
      await page.locator('#teEncrypt').click();
      await page.waitForFunction(() => {
        const progress = document.querySelector('#teProgress');
        return progress && progress.classList.contains('show');
      }, null, { timeout: 3000 });
      const elapsedBefore = await page.locator('#teProgressElapsed').innerText();
      const immediateEta = await page.locator('#teProgressEta').innerText();
      assert.match(immediateEta, /预计剩余/,'ETA must be rendered immediately when Argon2 progress starts');
      assert.doesNotMatch(immediateEta, /--|等待实际进度/,'ETA must not remain a blank placeholder');
      await page.waitForTimeout(220);
      const elapsedAfter = await page.locator('#teProgressElapsed').innerText();
      assert.notEqual(elapsedAfter, elapsedBefore, 'elapsed timer should tick while Argon2id runs');
      await page.waitForFunction(() => {
        const box = document.querySelector('#teProgress');
        const pct = Number.parseFloat(document.querySelector('#tePct')?.textContent || '0');
        const eta = document.querySelector('#teProgressEta')?.textContent || '';
        return !!box?.classList.contains('show') && pct > 0 && pct < 100 && !eta.includes('正在准备') && !eta.includes('正在建立实际速率');
      }, null, { timeout: 120000 });
      const liveProgress = await page.evaluate(() => ({
        percent: document.querySelector('#tePct')?.textContent || '',
        eta: document.querySelector('#teProgressEta')?.textContent || '',
        elapsed: document.querySelector('#teProgressElapsed')?.textContent || '',
        samples: [...new Set(window.__pcPctSamples || [])].map(x => Number.parseFloat(x)).filter(Number.isFinite)
      }));
      assert.ok(Number.parseFloat(liveProgress.percent) > 0 && Number.parseFloat(liveProgress.percent) < 100);
      assert.ok(liveProgress.samples.filter(x => x > 0 && x < 100).length >= 3, 'progress percentage should visibly animate between Argon2id slice checkpoints, not jump in 25% steps'); assert.ok(liveProgress.samples.some(x => Math.abs((x / 25) - Math.round(x / 25)) > 0.01), 'progress samples must include a non-25%-multiple intermediate value');
      assert.ok(liveProgress.eta && !liveProgress.eta.includes('正在建立实际速率'));
      await page.waitForFunction(prev => { const v=document.querySelector('#teCipher')?.value||''; return v && v!==prev; }, oldCipher, { timeout: 240000 });
      await waitForResult(page, '#teResult', 240000);
      const packs = await page.evaluate(() => ({
        cipher: document.querySelector('#teCipher').value,
        params: document.querySelector('#teParams').value,
        key: document.querySelector('#teKey').value,
        generationTime: document.querySelector('#teGenerationTime strong').textContent
      }));
      assert.ok(packs.cipher.startsWith('Ciphertext.'));
      assert.ok(packs.params.startsWith('Parliaments.'));
      assert.ok(packs.key.startsWith('Key.'));
      assert.notEqual(packs.generationTime, '--');
      await page.locator('#tab-td').click();
      await page.locator('#tdCipher').fill(packs.cipher);
      await page.locator('#tdParams').fill(packs.params);
      await page.locator('#tdKey').fill(packs.key);
      await page.locator('#tdPass').fill('Audit-Pepper-Password-2026!');
      await page.locator('#tdDecrypt').click();
      await waitForResult(page, '#tdResult', 240000);
      assert.equal(await page.locator('#tdPlain').inputValue(), 'PepperCipher browser audit\n中文 Unicode 🔐\nline 3');
      return { progressElapsedBefore: elapsedBefore, progressElapsedAfter: elapsedAfter, immediateEta, livePercent: liveProgress.percent, liveEta: liveProgress.eta, animatedSamples: liveProgress.samples.length, roundTrip: true, packagePrefixes: ['Ciphertext.', 'Parliaments.', 'Key.'] };
    });

    let noPasswordPacks;
    await test('无密码模式文本加密与解密往返', async () => {
      await page.locator('#tab-te').click();
      await page.locator('#teCatalogMode').selectOption('none');
      await page.locator('#tePlain').fill('No-password mode audit: 不等于无密钥');
      await page.locator('#tePass').fill('');
      await page.locator('#tePass2').fill('');
      // RAW-KEY mode must not depend on unused Argon2id parameters.
      await page.locator('#teArgonMemory').fill('');
      await page.locator('#teArgonTime').fill('');
      await page.locator('#teArgonParallel').fill('');
      await page.locator('#teNoPassword').check();
      const oldCipher = await page.locator('#teCipher').inputValue();
      await page.locator('#teEncrypt').click();
      await page.waitForFunction(prev => { const v=document.querySelector('#teCipher')?.value||''; return v && v!==prev; }, oldCipher, { timeout: 30000 });
      noPasswordPacks = await page.evaluate(() => ({
        cipher: document.querySelector('#teCipher').value,
        params: document.querySelector('#teParams').value,
        key: document.querySelector('#teKey').value
      }));
      await page.locator('#tab-td').click();
      await page.locator('#tdCipher').fill(noPasswordPacks.cipher);
      await page.locator('#tdParams').fill(noPasswordPacks.params);
      await page.locator('#tdKey').fill(noPasswordPacks.key);
      await page.locator('#tdPass').fill('');
      await page.locator('#tdDecrypt').click();
      await page.waitForFunction(expected => document.querySelector('#tdPlain')?.value===expected, 'No-password mode audit: 不等于无密钥', { timeout: 30000 });
      assert.equal(await page.locator('#tdPlain').inputValue(), 'No-password mode audit: 不等于无密钥');
      return { roundTrip: true };
    });

    await test('终止 Argon2id 会中止任务且不生成新密文', async () => {
      await page.locator('#tab-te').click();
      await page.locator('#teCatalogMode').selectOption('none');
      const oldCipher = await page.locator('#teCipher').inputValue();
      await page.locator('#tePlain').fill('this encryption must be cancelled');
      await page.locator('#tePass').fill('Cancel-Audit-Password-2026!');
      await page.locator('#tePass2').fill('Cancel-Audit-Password-2026!');
      await page.locator('#teArgonMemory').fill('8192');
      await page.locator('#teArgonTime').fill('8');
      await page.locator('#teArgonParallel').fill('1');
      await page.locator('#teEncrypt').click();
      await page.waitForFunction(() => document.querySelector('#teProgress')?.classList.contains('show'), null, { timeout: 3000 });
      await page.locator('#teArgonCancel').click();
      await page.waitForFunction(() => !document.body.hasAttribute('aria-busy'), null, { timeout: 120000 });
      assert.equal(await page.locator('#teCipher').inputValue(), oldCipher, 'cancelled operation must not replace ciphertext');
      return { cancelled: true, ciphertextUnchanged: true };
    });

    await test('空主密码会自动切换无密码模式', async () => {
      await page.locator('#tab-te').click();
      await page.locator('#teCatalogMode').selectOption('none');
      await page.locator('#teNoPassword').uncheck();
      await page.locator('#tePass').fill('');
      await page.locator('#tePass2').fill('');
      await page.locator('#tePlain').fill('Auto-switch audit: 空密码不得误走 Argon2');
      const oldCipher = await page.locator('#teCipher').inputValue();
      await page.locator('#teEncrypt').click();
      await page.waitForFunction(prev => { const v=document.querySelector('#teCipher')?.value||''; return v && v!==prev; }, oldCipher, { timeout: 30000 });
      const params = await page.locator('#teParams').inputValue();
      assert.ok(params.startsWith('Parliaments.'));
      const payload = parseHumanSafePackage(params, 'Parliaments.');
      assert.equal(payload.kdf, 'RAW-KEY', 'empty password should produce the no-password KDF package');
      const notices = await page.locator('.toast').allInnerTexts();
      assert.ok(notices.some(x => x.includes('主密码为空') && x.includes('无密码模式')));
      return { automaticModeSwitch: true, kdf: payload.kdf };
    });

    await test('目录新增、持久化和 JSON 导出', async () => {
      await page.locator('#tab-ca').click();
      await page.locator('#catNew').click();
      await page.locator('#catName').fill('Browser Audit Account');
      await page.locator('#catCategory').fill('Automated Test');
      await page.locator('#catNote').fill('test-only metadata; no secrets');
      await page.locator('#catSave').click();
      await page.waitForFunction(() => document.querySelector('#catList')?.innerText.includes('Browser Audit Account'), null, { timeout: 30000 });
      const dlPath = '/tmp/peppercipher-catalog-audit.json';
      const dl = await saveDownload(page, '#catExportJson', dlPath);
      const json = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
      assert.ok(json.records.some(r => r.name === 'Browser Audit Account'));
      for (const record of json.records) {
        assert.equal(Object.prototype.hasOwnProperty.call(record, 'password'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(record, 'secret'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(record, 'ciphertext'), false);
      }
      const now = new Date().toISOString();
      json.records.push({recordId:'PC-AAAA-BBBB-CCCC-DDDD-EEEE',name:'Imported Audit Account',category:'Import Test',note:'imported through JSON',status:'active',createdAt:now,updatedAt:now});
      await page.locator('#catImportFile').setInputFiles({name:'peppercipher-audit-import.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(json))});
      await page.waitForFunction(() => document.querySelector('#catList')?.innerText.includes('Imported Audit Account'), null, {timeout:30000});
      const csvPath = '/tmp/peppercipher-catalog-audit.csv';
      const csv = await saveDownload(page, '#catExportCsv', csvPath);
      const csvText = fs.readFileSync(csvPath, 'utf8');
      assert.ok(csvText.includes('Name,Category,Note'));
      assert.ok(csvText.includes('Imported Audit Account'));
      return { recordCreated: true, jsonImported: true, csvExported: true, exportedRecords: json.records.length, jsonFilename: dl.suggestedFilename, csvFilename: csv.suggestedFilename, secretFieldsFound: false };
    });

    await test('三种电子包均可生成纸质备份页', async () => {
      const sources = [
        ['cipher', noPasswordPacks.cipher],
        ['params', noPasswordPacks.params],
        ['key', noPasswordPacks.key]
      ];
      for (const [kind, value] of sources) {
        await page.locator('#tab-pr').click();
        await page.locator('#prPackageType').selectOption(kind);
        await page.locator('#prCipherSource').fill(value);
        await page.locator('#prGenerate').click();
        await page.waitForFunction(kind => document.querySelector('#prGenStatus')?.innerText.includes('对象：' + kind), kind, { timeout: 60000 });
        assert.equal(await page.locator('#prPrint').isDisabled(), false);
        assert.ok(await page.locator('#paperCodes .paper-card').count() >= 1, 'paper pages should be rendered for ' + kind);
      }
      const rawPackage = await page.locator('#prCipherSource').inputValue();
      const paperText = await page.locator('#paperCodes .paper-package-text').first().textContent();
      assert.notEqual(paperText, rawPackage, 'printed text must use the ambiguity-safe visual representation');
      assert.doesNotMatch(paperText, /[01ILOUilou]/, 'printed package text must contain no ambiguous 0/1/I/L/O/U glyphs');
      const keyPayload = parseHumanSafePackage(rawPackage, 'Key.');
      const paperHeader = await page.locator('#paperCodes .paper-id').first().innerText();
      assert.ok(keyPayload.recordId && paperHeader.includes('Record ID'), 'printed page must include the Record ID field');
      const paperPanelText = await page.locator('#panel-pr').innerText();
      assert.doesNotMatch(paperPanelText, /PAPER2|PAPERPAR2|PAPERKEY2/, 'paper-recovery UI must use current Ciphertext / Parliaments / Key names');
      const paperCardCount = await page.locator('#paperCodes .paper-card').count();
      assert.ok(paperCardCount >= 1);
      await page.emulateMedia({media:'print'});
      const pdfBytes = await page.pdf({format:'Letter',printBackground:true});
      const pdfDoc = await PDFDocument.load(pdfBytes);
      assert.equal(pdfDoc.getPageCount(), paperCardCount, 'print-to-PDF must not add blank pages');
      await page.emulateMedia({media:'screen'});
      return { packageTypes: sources.map(x => x[0]), rendered: true, paperCards: paperCardCount, pdfPages: pdfDoc.getPageCount(), blankPages: 0 };
    });

    await test('文件加密与解密二进制往返', async () => {
      const original = Buffer.from('PepperCipher file audit\n\u0000binary-ish\n中文 🌶️', 'utf8');
      await page.locator('#tab-fe').click();
      await page.locator('#feAllTypes').check();
      await page.locator('#feFile').setInputFiles({ name: 'audit-fixture.txt', mimeType: 'text/plain', buffer: original });
      await page.locator('#fePass').fill('File-Audit-Password-2026!');
      await page.locator('#fePass2').fill('File-Audit-Password-2026!');
      await page.locator('#feArgonMemory').fill('8');
      await page.locator('#feArgonTime').fill('1');
      await page.locator('#feArgonParallel').fill('1');
      await page.locator('#feEncrypt').click();
      await waitForResult(page, '#feResult', 120000);
      const encryptedPath = '/tmp/peppercipher-audit.paper';
      const encryptedDownload = await saveDownload(page, '#feDownload', encryptedPath);
      const encryptedBytes = fs.readFileSync(encryptedPath);
      assert.ok(encryptedBytes.length > original.length, 'encrypted file should contain authenticated header and ciphertext');

      await page.locator('#tab-fd').click();
      await page.locator('#fdFile').setInputFiles({ name: 'audit-fixture.paper', mimeType: 'application/octet-stream', buffer: encryptedBytes });
      await page.waitForTimeout(250);
      await page.locator('#fdPass').fill('File-Audit-Password-2026!');
      await page.locator('#fdDecrypt').click();
      await waitForResult(page, '#fdResult', 120000);
      const restoredPath = '/tmp/peppercipher-restored.bin';
      const restoredDownload = await saveDownload(page, '#fdDownload', restoredPath);
      const restoredBytes = fs.readFileSync(restoredPath);
      assert.deepEqual(restoredBytes, original, 'decrypted file bytes must exactly match the original');
      return { originalBytes: original.length, encryptedBytes: encryptedBytes.length, restoredBytes: restoredBytes.length, encryptedFilename: encryptedDownload.suggestedFilename, restoredFilename: restoredDownload.suggestedFilename };
    });

    await test('无密码模式文件加解密不依赖 Argon2 参数', async () => {
      const original = Buffer.from('RAW-KEY file audit: no Argon2 parameters required\\n中文', 'utf8');
      await page.locator('#tab-fe').click();
      await page.locator('#feAllTypes').check();
      await page.locator('#feFile').setInputFiles({ name: 'audit-raw-key.txt', mimeType: 'text/plain', buffer: original });
      await page.locator('#fePass').fill('');
      await page.locator('#fePass2').fill('');
      await page.locator('#feArgonMemory').fill('');
      await page.locator('#feArgonTime').fill('');
      await page.locator('#feArgonParallel').fill('');
      await page.locator('#feNoPassword').check();
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#feEncrypt').click();
      await waitForResult(page, '#feResult', 30000);
      const encryptedPath = '/tmp/peppercipher-raw-key.paper';
      const encryptedDownload = await saveDownload(page, '#feDownload', encryptedPath);
      const encryptedBytes = fs.readFileSync(encryptedPath);

      await page.locator('#tab-fd').click();
      await page.locator('#fdFile').setInputFiles({ name: 'audit-raw-key.paper', mimeType: 'application/octet-stream', buffer: encryptedBytes });
      await page.waitForTimeout(250);
      assert.equal(await page.locator('#fdPass').isDisabled(), true, 'RAW-KEY container should not require a master password');
      await page.locator('#fdDecrypt').click();
      await waitForResult(page, '#fdResult', 30000);
      const restoredPath = '/tmp/peppercipher-raw-key-restored.bin';
      const restoredDownload = await saveDownload(page, '#fdDownload', restoredPath);
      assert.deepEqual(fs.readFileSync(restoredPath), original);
      return { roundTrip: true, encryptedFilename: encryptedDownload.suggestedFilename, restoredFilename: restoredDownload.suggestedFilename };
    });

    await test('Argon2id 自定义参数保存并在重新打开后恢复', async () => {
      await page.locator('#tab-te').click();
      await page.locator('#teArgonMemory').fill('32768');
      await page.locator('#teArgonTime').fill('2');
      await page.locator('#teArgonParallel').fill('2');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('peppercipher.argon2.v1') || 'null')?.te);
      assert.equal(String(stored.memoryKiB), '32768');
      assert.equal(String(stored.timeCost), '2');
      assert.equal(String(stored.parallelism), '2');
      await page.reload({waitUntil:'load'});
      assert.equal(await page.locator('#teArgonMemory').inputValue(), '32768');
      assert.equal(await page.locator('#teArgonTime').inputValue(), '2');
      assert.equal(await page.locator('#teArgonParallel').inputValue(), '2');
      return { persisted: true, memoryKiB: 32768, timeCost: 2, parallelism: 2 };
    });

    await test('主题切换与本机离线约束', async () => {
      await page.locator('#themeBtn').click();
      const theme = await page.locator(':root').getAttribute('data-theme');
      assert.ok(theme === 'dark' || theme === 'light' || theme === null);
      assert.deepEqual(report.externalRequests, [], 'the page must not request external network resources');
      return { themeAttribute: theme, externalRequests: 0 };
    });

    assert.deepEqual(report.pageErrors, [], 'uncaught page errors must be absent');
    assert.deepEqual(report.externalRequests, [], 'no external requests should be made');
  } catch (error) {
    report.failed = true;
    report.topLevelError = String(error && error.stack || error);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.summary = {
      passed: report.tests.filter(t => t.passed).length,
      failed: report.tests.filter(t => !t.passed).length,
      pageErrors: report.pageErrors.length,
      consoleErrors: report.consoleErrors.length,
      externalRequests: report.externalRequests.length
    };
    fs.writeFileSync('audit-report.json', JSON.stringify(report, null, 2));
    if (browser) await browser.close().catch(() => {});
    console.log('AUDIT SUMMARY ' + JSON.stringify(report.summary));
    if (report.failed || report.summary.failed || report.summary.pageErrors || report.summary.externalRequests) process.exitCode = 1;
  }
})();
