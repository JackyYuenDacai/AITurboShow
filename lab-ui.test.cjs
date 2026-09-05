const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

test('image and video lab browser workflows', async (t) => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = process.env.LAB_TEST_URL || 'http://127.0.0.1:8765';
  const errors = [];
  const requests = [];
  let runs = [];
  const refs = [
    { id: 'a', name: '<img src=x onerror=alert(1)>', image: 'hero.png' },
    { id: 'b', name: 'Market', image: 'market.png' },
  ];
  let failRewrite = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    requests.push({ path, body });
    let data;
    if (path.includes('/history')) data = { items: runs };
    else if (path === '/api/lab/references') data = { items: refs };
    else if (path.endsWith('/config')) data = { configured: true, model: 'deepseek-chat' };
    else if (path === '/api/lab/rewrite') {
      if (failRewrite) return route.fulfill({ status: 502, json: { error: 'Draft service unavailable' } });
      data = { content: 'A refined scene', model: 'test-model' };
    } else if (path.includes('/generate-')) {
      const video = path.endsWith('video');
      data = { id: String(runs.length), kind: video ? 'video' : 'image', prompt_id: 'test-prompt', prompt: body.prompt || body.video_prompt, ...(video ? body.options : body), video_mode: body.video_mode, references: body.references, duration_seconds: body.duration, created_at: new Date().toISOString(), status: 'queued' };
      runs = [...runs, data];
    } else data = { connected: true, compatible: true, capabilities: { h3: { compatible: true }, z_image_turbo: { compatible: true } } };
    return route.fulfill({ json: data });
  });
  try {
    await t.test('image rewrite, undo, presets, generation, tasks and saved drafts', async () => {
      await page.goto(base + '/image-lab.html');
      await page.fill('#prompt', 'A portrait');
      await page.fill('#instruction', 'Soft light');
      await page.click('#rewrite');
      await page.waitForFunction(() => document.querySelector('#output').value === 'A refined scene');
      assert.equal(requests.find((r) => r.path.endsWith('/rewrite')).body.instruction, 'Soft light');
      await page.click('#undoPrompt');
      assert.equal(await page.inputValue('#prompt'), 'A portrait');
      await page.selectOption('#sizePreset', '768x1024');
      await page.fill('#seed', '0');
      await page.click('#generate');
      await page.waitForFunction(() => document.querySelector('#taskQueueCount').textContent === '1');
      assert.equal(await page.getAttribute('#taskQueueButton', 'aria-expanded'), 'true');
      const payload = requests.find((r) => r.path.endsWith('/generate-image')).body;
      assert.equal(payload.width, 768);
      assert.equal(payload.seed, 0);
      await page.keyboard.press('Escape');
      assert.equal(await page.getAttribute('#taskQueueButton', 'aria-expanded'), 'false');
      await page.reload();
      assert.equal(await page.inputValue('#prompt'), 'A portrait');
      assert.equal(await page.inputValue('#seed'), '0');
      assert.equal(await page.locator('#history').count(), 1);
      runs[0] = { ...runs[0], status: 'completed', preview_urls: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLasAAAAASUVORK5CYII='] };
      await page.click('#refreshHistory');
      await page.locator('[data-preview="0"]').click();
      assert.equal(await page.isVisible('#imageLightbox'), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#imageLightbox button').evaluate((button) => button === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.isVisible('#imageLightbox'), false);
      assert.equal(await page.locator('[data-preview="0"]').evaluate((button) => button === document.activeElement), true);
      failRewrite = true;
      await page.click('#rewrite');
      await page.waitForFunction(() => document.querySelector('#status').textContent === 'Draft service unavailable');
      assert.equal(await page.isEnabled('#generate'), true);
      failRewrite = false;
    });
    await t.test('only selected references are sent, T2VA ignores hidden selections', async () => {
      await page.goto(base + '/video-lab.html');
      await page.selectOption('#mode', 'i2va');
      await page.fill('#prompt', 'Animate <Picture 1>');
      await page.click('#generate');
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('exactly one'));
      assert.equal(requests.filter((r) => r.path.endsWith('/generate-video')).length, 0);
      await page.check('[data-select-ref="b"]');
      assert.equal(await page.locator('#referenceList img').count(), 0);
      await page.click('#generate');
      await page.waitForFunction(() => document.querySelector('#taskQueuePanel').classList.contains('hidden') === false);
      const payload = requests.find((r) => r.path.endsWith('/generate-video')).body;
      assert.equal(payload.video_mode, 'i2va');
      assert.deepEqual(payload.references, [{ picture: 1, image: 'market.png', description: 'Market' }]);
      await page.keyboard.press('Escape');
      await page.selectOption('#mode', 't2va');
      await page.fill('#prompt', 'An open landscape');
      await page.click('#generate');
      await page.waitForFunction(() => document.querySelector('#taskQueuePanel').classList.contains('hidden') === false);
      assert.deepEqual(requests.filter((r) => r.path.endsWith('/generate-video')).at(-1).body.references, []);
      await page.keyboard.press('Escape');
    });
    await t.test('saved settings restore reference mode and mobile stays within viewport', async () => {
      await page.locator('[data-reuse="1"]').click();
      assert.equal(await page.inputValue('#mode'), 'i2va');
      assert.equal(await page.isChecked('[data-select-ref="b"]'), true);
      await page.reload();
      assert.equal(await page.isChecked('[data-select-ref="b"]'), true);
      for (const width of [1440, 1024, 768, 390]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
      }
      const duplicateIds = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i));
      assert.deepEqual(duplicateIds, []);
      assert.deepEqual(errors, []);
    });
  } finally { await browser.close(); }
});
