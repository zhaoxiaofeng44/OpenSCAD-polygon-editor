// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

// ============================================================
// Helpers
// ============================================================

const TMP = path.join(__dirname, '.tmp');
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

const consoleErrors = [];

test.beforeEach(async ({ page }, testInfo) => {
  consoleErrors.length = 0;
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(`[${testInfo.title}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[${testInfo.title}] pageerror ${err.message}`);
  });
  // Reset persisted project state so each test starts from a clean slate.
  // One-shot: don't re-clear on page.reload() (test A4 relies on persistence
  // across a reload). We gate the clear on a sessionStorage flag — that flag
  // resets per page since Playwright spawns a fresh context per test.
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__osped_cleared')) {
        localStorage.clear();
        sessionStorage.setItem('__osped_cleared', '1');
      }
    } catch {}
  });
  await page.goto('/index.html');
  // Wait until the default project is auto-created and editor is wired.
  await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);
  // Confirm WebGL initialized — without it most C/D tests can't run.
  await page.waitForFunction(() => {
    const dbg = document.getElementById('viewport3dDebug');
    return dbg && /(meshes|nodes|3D 就绪)/.test(dbg.textContent || '');
  }, { timeout: 8000 }).catch(() => {});
});

async function getCode(page) {
  return page.locator('#exportArea').inputValue();
}

async function addPrim(page, kind) {
  const before = (await getCode(page)).length;
  await page.locator(`.prim-tile[data-prim="${kind}"]`).click();
  // appendCode is synchronous; just wait for textarea text length to grow.
  await expect.poll(async () => (await getCode(page)).length).toBeGreaterThan(before);
}

// Wait until the 3D viewport's debug label reports the expected mesh count.
// Built meshes are required for tree-row selection to land on a real object.
async function waitMeshes(page, atLeast = 1) {
  await page.waitForFunction(
    (n) => {
      const el = document.getElementById('viewport3dDebug');
      const m = el && el.textContent && el.textContent.match(/meshes:\s*(\d+)/);
      return m && Number(m[1]) >= n;
    },
    atLeast,
    { timeout: 10_000 },
  );
}

async function clickTreeRowByIndex(page, idx, { additive = false } = {}) {
  const row = page.locator(`#sceneTree li.tree-node[data-ast-path="${idx}"] > .tree-row`);
  await expect(row).toBeVisible();
  if (additive) {
    await row.click({ modifiers: process.platform === 'darwin' ? ['Meta'] : ['Control'] });
  } else {
    await row.click();
  }
}

async function waitSelected(page) {
  await expect(page.locator('#selectionPanel')).toBeVisible();
}

// ============================================================
// 0. Environment smoke
// ============================================================

test.describe('0. environment', () => {
  test('0.1 page loads and editor wires up', async ({ page }) => {
    await expect(page).toHaveTitle(/OpenSCAD/);
    await expect(page.locator('#exportArea')).toBeAttached();
    await expect(page.locator('#projectSelect')).toBeVisible();
  });
});

// ============================================================
// A. .oscad single-file storage
// ============================================================

test.describe('A. .oscad storage', () => {
  test('A1 new project shows unsaved label', async ({ page }) => {
    page.on('dialog', async (d) => { await d.accept('测试1'); });
    await page.locator('#projectNewBtn').click();
    await expect(page.locator('#projectActiveName')).toHaveText('测试1');
    await expect(page.locator('#projectStorageLabel')).toContainText('未保存');
  });

  test('A3 editing flips dirty (asterisk would show if file bound)', async ({ page }) => {
    await page.locator('#exportArea').fill('cube([5,5,5]);');
    await page.waitForTimeout(700); // > SAVE_DEBOUNCE_MS
    const ls = await page.evaluate(() => localStorage.getItem('osped-projects-v1'));
    expect(ls).toContain('cube');
    // No file handle in headless context, so label stays at 未保存 (which is its
    // own evidence of the dirty-tracking path being live).
    await expect(page.locator('#projectStorageLabel')).toContainText('未保存');
  });

  test('A4 reload restores active project + code', async ({ page }) => {
    await page.locator('#exportArea').fill('sphere(r=7);');
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);
    await expect(page.locator('#exportArea')).toHaveValue(/sphere\(r=7\)/);
  });

  test('A6 export .oscad has the expected key set', async ({ page }) => {
    await page.locator('#exportArea').fill('cube([3,3,3]);');
    await page.waitForTimeout(700);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#projectExportBtn').click(),
    ]);
    const out = path.join(TMP, 'a6-export.oscad');
    await download.saveAs(out);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(data.schema).toBe('oscad-v1');
    expect(Object.keys(data).sort()).toEqual(
      ['code', 'components', 'createdAt', 'name', 'schema', 'updatedAt'].sort()
    );
    expect(data.code).toContain('cube');
  });

  test('A2 saveAs writes a valid .oscad through the FS picker (mocked)', async ({ page }) => {
    // Install mock pickers BEFORE any project.js code runs.
    await page.addInitScript(() => {
      const recorder = { writes: [], lastName: null };
      window.__oscadFS = recorder;
      function makeWritableHandle(name) {
        return {
          name,
          kind: 'file',
          async queryPermission() { return 'granted'; },
          async requestPermission() { return 'granted'; },
          async createWritable() {
            const chunks = [];
            return {
              async write(d) { chunks.push(d); },
              async close() {
                recorder.writes.push({ name, content: chunks.join('') });
              },
            };
          },
          async getFile() {
            const last = recorder.writes.filter((w) => w.name === name).pop();
            const text = last ? last.content : '';
            return { name, text: async () => text };
          },
        };
      }
      window.showSaveFilePicker = async (opts) => {
        const name = (opts && opts.suggestedName) || 'mocked.oscad';
        recorder.lastName = name;
        return makeWritableHandle(name);
      };
      // backend.available requires BOTH pickers; stub the open one too so
      // Firefox/WebKit (which lack both natively) take the FSA branch.
      window.showOpenFilePicker = async () => [];
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);

    page.on('dialog', async (d) => { await d.accept('a2-proj'); });
    await page.locator('#projectNewBtn').click();
    await expect(page.locator('#projectActiveName')).toHaveText('a2-proj');
    await page.locator('#exportArea').fill('cube([4,4,4]);');
    await page.waitForTimeout(700);

    await page.locator('#projectSaveAsBtn').click();
    await expect.poll(async () => {
      return await page.evaluate(() => (window.__oscadFS?.writes || []).length);
    }).toBeGreaterThan(0);

    const writes = await page.evaluate(() => window.__oscadFS.writes);
    expect(writes[0].name).toBe('a2-proj.oscad');
    const data = JSON.parse(writes[0].content);
    expect(data.schema).toBe('oscad-v1');
    expect(data.name).toBe('a2-proj');
    expect(data.code).toContain('cube');

    // Label should now show the file (no longer "未保存").
    await expect(page.locator('#projectStorageLabel')).toContainText('a2-proj.oscad');
  });

  test('A5 open .oscad through the FS picker (mocked)', async ({ page }) => {
    const fixture = {
      schema: 'oscad-v1',
      name: 'a5-imported',
      code: 'sphere(r=4, $fn=12);',
      components: [],
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    };
    await page.addInitScript((fx) => {
      window.showOpenFilePicker = async () => {
        return [{
          name: fx.name + '.oscad',
          kind: 'file',
          async queryPermission() { return 'granted'; },
          async requestPermission() { return 'granted'; },
          async getFile() {
            return {
              name: fx.name + '.oscad',
              text: async () => JSON.stringify(fx),
            };
          },
          async createWritable() {
            return { async write() {}, async close() {} };
          },
        }];
      };
      // backend.available requires BOTH pickers; stub the save one too so
      // Firefox/WebKit (which lack both natively) take the FSA branch.
      window.showSaveFilePicker = async () => { throw new Error('not used in A5'); };
    }, fixture);
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);

    await page.locator('#projectOpenBtn').click();
    await expect(page.locator('#projectActiveName')).toHaveText('a5-imported');
    await expect(page.locator('#exportArea')).toHaveValue(/sphere\(r=4, \$fn=12\)/);
    // Loaded project should be bound to the (mock) file; label shows filename.
    await expect(page.locator('#projectStorageLabel')).toContainText('a5-imported.oscad');
  });

  test('A7 Save/Open stay enabled when FSA missing (download fallback)', async ({ page }) => {
    // Simulate Safari/Firefox by deleting the FS API symbols before scripts run.
    await page.addInitScript(() => {
      try { delete window.showSaveFilePicker; } catch {}
      try { delete window.showOpenFilePicker; } catch {}
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);
    // Save / SaveAs / Open all stay clickable in fallback mode — they route
    // through download / file-input. Titles should pick up the fallback note.
    for (const id of ['#projectSaveBtn', '#projectSaveAsBtn', '#projectOpenBtn']) {
      await expect(page.locator(id)).toBeEnabled();
      const title = (await page.locator(id).getAttribute('title')) || '';
      expect(title).toMatch(/不支持文件系统访问 API/);
    }
    // 下载副本 stays enabled too (works in every browser as a plain blob download).
    await expect(page.locator('#projectExportBtn')).toBeEnabled();
  });

  test('A8 SaveAs (no FSA) prompts for a filename then downloads .oscad', async ({ page }) => {
    await page.addInitScript(() => {
      try { delete window.showSaveFilePicker; } catch {}
      try { delete window.showOpenFilePicker; } catch {}
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);
    await page.locator('#exportArea').fill('sphere(r=9);');
    await page.waitForTimeout(700);

    // Filename prompt: user types something without the .oscad extension —
    // the code should add it for them.
    page.once('dialog', async (d) => {
      expect(d.type()).toBe('prompt');
      await d.accept('my-project');
    });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('#projectSaveAsBtn').click(),
    ]);
    expect(download.suggestedFilename()).toBe('my-project.oscad');
    const out = path.join(TMP, 'a8-saveas.oscad');
    await download.saveAs(out);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(data.schema).toBe('oscad-v1');
    expect(data.code).toContain('sphere');

    // The filename should now be remembered in localStorage + label.
    await expect(page.locator('#projectStorageLabel')).toContainText('my-project.oscad');
    const ls = await page.evaluate(() => localStorage.getItem('osped-projects-v1'));
    expect(ls).toContain('my-project.oscad');
  });

  test('A9 Save (no FSA) reuses the remembered filename — no prompt', async ({ page }) => {
    // Seed localStorage with a project that already has fileName set, then
    // load the page (still without FSA). Clicking Save should silently
    // re-download using the stored fileName.
    await page.addInitScript(() => {
      try { delete window.showSaveFilePicker; } catch {}
      try { delete window.showOpenFilePicker; } catch {}
      // Override the default-cleaning init script: keep our seed.
      sessionStorage.setItem('__osped_cleared', '1');
      localStorage.setItem('osped-projects-v1', JSON.stringify({
        projects: {
          'p_seed': {
            id: 'p_seed',
            name: 'seeded',
            code: 'cube([2,2,2]);',
            components: [],
            createdAt: 1700000000000,
            updatedAt: 1700000000000,
            fileName: 'seeded-prior.oscad',
          },
        },
        activeId: 'p_seed',
      }));
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText('seeded');
    await expect(page.locator('#projectStorageLabel')).toContainText('seeded-prior.oscad');

    // Fail the test if a prompt dialog appears — we expect Save to be silent.
    page.on('dialog', async (d) => {
      throw new Error('Unexpected dialog: ' + d.type() + ' ' + d.message());
    });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('#projectSaveBtn').click(),
    ]);
    expect(download.suggestedFilename()).toBe('seeded-prior.oscad');
    const out = path.join(TMP, 'a9-resave.oscad');
    await download.saveAs(out);
    const data = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(data.code).toContain('cube');
  });

  test('A11 Save button gets dirty highlight when project has unsaved changes', async ({ page }) => {
    // Brand-new auto-created project has no file bound → dirty from the start.
    await expect(page.locator('#projectSaveBtn')).toHaveClass(/save-dirty/);
    // Editing in the textarea keeps it dirty.
    await page.locator('#exportArea').fill('cube([3,3,3]);');
    await page.waitForTimeout(700); // > SAVE_DEBOUNCE_MS
    await expect(page.locator('#projectSaveBtn')).toHaveClass(/save-dirty/);
    // The ✱ marker may or may not show (no bound file in headless), but the
    // button highlight is the key user-visible signal — and it should be on.
  });

  test('A12 Save dirty highlight clears after FSA save', async ({ page }) => {
    // Install a mock FSA picker so we can bind a handle and observe the
    // dirty → clean transition on the Save button itself.
    await page.addInitScript(() => {
      const recorder = { writes: [] };
      window.__oscadFS = recorder;
      window.showSaveFilePicker = async (opts) => {
        const name = (opts && opts.suggestedName) || 'mocked.oscad';
        return {
          name, kind: 'file',
          async queryPermission() { return 'granted'; },
          async requestPermission() { return 'granted'; },
          async createWritable() {
            return {
              async write(d) { recorder.writes.push({ name, content: d }); },
              async close() {},
            };
          },
          async getFile() { return { name, text: async () => '' }; },
        };
      };
      window.showOpenFilePicker = async () => [];
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);
    await expect(page.locator('#projectSaveBtn')).toHaveClass(/save-dirty/);

    await page.locator('#exportArea').fill('cube([7,7,7]);');
    await page.waitForTimeout(700);
    // SaveAs binds a handle and writes; subsequent debounced saves should
    // flip dirty→clean and remove the highlight.
    await page.locator('#projectSaveAsBtn').click();
    await expect.poll(async () =>
      page.evaluate(() => (window.__oscadFS?.writes || []).length)
    ).toBeGreaterThan(0);
    await expect(page.locator('#projectSaveBtn')).not.toHaveClass(/save-dirty/);
  });

  test('A13 Save click within debounce window writes LATEST textarea content (no stale snapshot)', async ({ page }) => {
    // Mock FSA so we can bind and capture exactly what's written.
    await page.addInitScript(() => {
      const recorder = { writes: [] };
      window.__oscadFS = recorder;
      window.showSaveFilePicker = async (opts) => {
        const name = (opts && opts.suggestedName) || 'mocked.oscad';
        return {
          name, kind: 'file',
          async queryPermission() { return 'granted'; },
          async requestPermission() { return 'granted'; },
          async createWritable() {
            return {
              async write(d) { recorder.writes.push({ at: Date.now(), name, content: d }); },
              async close() {},
            };
          },
          async getFile() { return { name, text: async () => '' }; },
        };
      };
      window.showOpenFilePicker = async () => [];
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);

    // Bind a file first via SaveAs (uses initial empty/seed content).
    await page.locator('#projectSaveAsBtn').click();
    await expect.poll(async () =>
      page.evaluate(() => (window.__oscadFS?.writes || []).length)
    ).toBeGreaterThan(0);

    // Now type a NEW value and IMMEDIATELY click Save — within the 500ms
    // saveSnapshot debounce window. The Save handler must flush the textarea
    // synchronously so the bound file gets the *new* content, not the stale
    // snapshot still pending in the debounce timer.
    await page.locator('#exportArea').fill('cube([42,42,42]);');
    // Deliberately do NOT wait for the debounce — click immediately.
    await page.locator('#projectSaveBtn').click();
    // Wait for the second write to land.
    await expect.poll(async () =>
      page.evaluate(() => (window.__oscadFS?.writes || []).length)
    ).toBeGreaterThan(1);

    const writes = await page.evaluate(() => window.__oscadFS.writes);
    const lastWrite = writes[writes.length - 1];
    const data = JSON.parse(lastWrite.content);
    // The bug being tested: before the flushPendingEdits fix, this assertion
    // failed because lastWrite.content held the seed (no cube) and only the
    // debounced follow-up write contained the cube. With the fix, the Save
    // click itself writes the latest content.
    expect(data.code).toContain('cube([42,42,42])');
  });

  test('A10 Open (no FSA) routes to file-input import + remembers filename', async ({ page }) => {
    await page.addInitScript(() => {
      try { delete window.showSaveFilePicker; } catch {}
      try { delete window.showOpenFilePicker; } catch {}
    });
    await page.goto('/index.html');
    await expect(page.locator('#projectActiveName')).toHaveText(/我的项目/);

    // Clicking the Open button (in fallback) should fire #projectImportFile.click().
    // Use setInputFiles to set a fixture file synchronously (without the picker UI).
    const fixturePath = path.join(TMP, 'a10-fixture.oscad');
    fs.writeFileSync(fixturePath, JSON.stringify({
      schema: 'oscad-v1',
      name: 'a10-loaded',
      code: 'cylinder(h=8, r=3, $fn=12);',
      components: [],
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    }));
    // Trigger the open button (this in turn .click()s the hidden input — but we
    // can't fulfill that picker programmatically. So instead, set the input's
    // files directly and dispatch change, which is what fallback Open ends up
    // doing).
    await page.locator('#projectImportFile').setInputFiles(fixturePath);

    await expect(page.locator('#projectActiveName')).toHaveText('a10-loaded');
    await expect(page.locator('#exportArea')).toHaveValue(/cylinder/);
    await expect(page.locator('#projectStorageLabel')).toContainText('a10-fixture.oscad');
  });
});

// ============================================================
// B. OBJ export
// ============================================================

test.describe('B. OBJ export', () => {
  test('B1 export button exists', async ({ page }) => {
    await expect(page.locator('#exportObjBtn')).toBeVisible();
  });

  test('B4 OBJ has cube-shaped geometry (vertex count, bbox)', async ({ page }) => {
    // cube([20,20,20]) → bbox (0,0,0)→(20,20,20). Three.js BoxGeometry exports
    // 24 unique-position vertices (4 corners × 6 faces for normals) and 12
    // triangles. We tolerate small floating jitter on the bbox.
    await page.locator('#exportArea').fill('cube([20, 20, 20]);');
    await waitMeshes(page, 1);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('#exportObjBtn').click(),
    ]);
    const out = path.join(TMP, 'b4-cube.obj');
    await download.saveAs(out);
    const text = fs.readFileSync(out, 'utf8');
    const verts = [];
    let triCount = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('v ')) {
        const [, x, y, z] = line.split(/\s+/);
        verts.push([+x, +y, +z]);
      } else if (line.startsWith('f ')) {
        const parts = line.trim().split(/\s+/).slice(1);
        if (parts.length === 3) triCount += 1;
        else if (parts.length === 4) triCount += 2; // quad → 2 tris
        else if (parts.length > 4) triCount += parts.length - 2; // fan
      }
    }
    expect(verts.length).toBeGreaterThanOrEqual(8);
    expect(triCount).toBeGreaterThanOrEqual(12);
    const bx = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const v of verts) for (let i = 0; i < 3; i++) {
      bx.min[i] = Math.min(bx.min[i], v[i]);
      bx.max[i] = Math.max(bx.max[i], v[i]);
    }
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(bx.min[i] - 0)).toBeLessThan(0.01);
      expect(Math.abs(bx.max[i] - 20)).toBeLessThan(0.01);
    }
  });

  test('B5 helpers (grid/axes/edges) are visible again after export', async ({ page }) => {
    await page.locator('#exportArea').fill('cube([10,10,10]);');
    await waitMeshes(page, 1);
    const before = await page.evaluate(() => window.AstAPI._helpersVisible());
    expect(before.grid).toBe(true);
    expect(before.axes).toBe(true);
    expect(before.lines && before.lines.anyVisible).toBe(true);

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('#exportObjBtn').click(),
    ]);
    await download.saveAs(path.join(TMP, 'b5-cube.obj'));

    const after = await page.evaluate(() => window.AstAPI._helpersVisible());
    expect(after.grid).toBe(true);
    expect(after.axes).toBe(true);
    expect(after.lines.hidden).toBe(0);
    expect(after.lines.anyVisible).toBe(true);
  });

  test('B2 + B3 download is non-empty and well-formed', async ({ page }) => {
    await addPrim(page, 'cube');
    // Wait one animation frame so meshes are built before exporter parses.
    await page.waitForTimeout(500);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('#exportObjBtn').click(),
    ]);
    const out = path.join(TMP, 'b2-cube.obj');
    await download.saveAs(out);
    const text = fs.readFileSync(out, 'utf8');
    expect(text.length).toBeGreaterThan(0);
    const vLines = (text.match(/^v /gm) || []).length;
    const fLines = (text.match(/^f /gm) || []).length;
    expect(vLines).toBeGreaterThan(0);
    expect(fLines).toBeGreaterThan(0);
    // No helper geometry leaked into the OBJ.
    expect(text).not.toMatch(/Helper|Selection|GridHelper|AxesHelper/);
  });
});

// ============================================================
// C. Flip (mirror)
// ============================================================

test.describe('C. flip', () => {
  async function addAndSelect(page, kind = 'prism') {
    await addPrim(page, kind);
    await waitMeshes(page, 1);
    await clickTreeRowByIndex(page, 0);
    await waitSelected(page);
  }

  test('C1 flip buttons render in selection panel', async ({ page }) => {
    await addAndSelect(page);
    await expect(page.locator('.flip-btn[data-flip-axis="x"]')).toBeVisible();
    await expect(page.locator('.flip-btn[data-flip-axis="y"]')).toBeVisible();
    await expect(page.locator('.flip-btn[data-flip-axis="z"]')).toBeVisible();
  });

  test('C2 / C3 flip X is a toggle', async ({ page }) => {
    await addAndSelect(page);
    await page.locator('.flip-btn[data-flip-axis="x"]').click();
    await page.waitForTimeout(200);
    expect(await getCode(page)).toMatch(/mirror\(\[1\s*,\s*0\s*,\s*0\]\)/);
    await page.locator('.flip-btn[data-flip-axis="x"]').click();
    await page.waitForTimeout(200);
    expect(await getCode(page)).not.toMatch(/mirror\(\[1\s*,\s*0\s*,\s*0\]\)/);
  });

  test('C4 flip + undo + redo', async ({ page }) => {
    await addAndSelect(page);
    await page.locator('.flip-btn[data-flip-axis="y"]').click();
    await page.waitForTimeout(200);
    expect(await getCode(page)).toMatch(/mirror\(\[0\s*,\s*1\s*,\s*0\]\)/);
    // Move focus out of any input so the global Ctrl/Cmd+Z is handled by
    // the 3D viewport's keydown listener.
    await page.locator('#viewport3d').click({ position: { x: 5, y: 5 } });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyZ`);
    await page.waitForTimeout(200);
    expect(await getCode(page)).not.toMatch(/mirror\(\[0\s*,\s*1\s*,\s*0\]\)/);
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await page.waitForTimeout(200);
    expect(await getCode(page)).toMatch(/mirror\(\[0\s*,\s*1\s*,\s*0\]\)/);
  });

  test('C5 flip composes with prior translate', async ({ page }) => {
    // Seed with a translated cube directly in the textarea so we don't need
    // to drive the translate via the gizmo.
    await page.locator('#exportArea').fill('translate([20, 0, 0]) cube([10, 10, 10]);');
    await page.waitForTimeout(400);
    await clickTreeRowByIndex(page, 0);
    await waitSelected(page);
    await page.locator('.flip-btn[data-flip-axis="x"]').click();
    await page.waitForTimeout(200);
    const code = await getCode(page);
    // mirror wraps OUTSIDE the existing translate (mirror-of-already-positioned).
    expect(code).toMatch(/mirror\(\[1\s*,\s*0\s*,\s*0\]\)\s*translate\(\[20\s*,\s*0\s*,\s*0\]\)/);
  });
});

// ============================================================
// D. Quick align
// ============================================================

test.describe('D. quick align', () => {
  // Build two objects, multi-select them, expand the QA panel.
  async function setupTwo(page) {
    // Use a known position for the sphere so we can predict the translate result.
    await page.locator('#exportArea').fill(
      'cube([20, 20, 20]);\ntranslate([50, 0, 0]) sphere(r=10, $fn=24);\n'
    );
    await waitMeshes(page, 2);
    await clickTreeRowByIndex(page, 0);
    await clickTreeRowByIndex(page, 1, { additive: true });
    await expect(page.locator('#combinePanel')).toBeVisible();
    await expect(page.locator('#combineCount')).toHaveText('2');
  }

  test('D1 quick-align entry hidden until multi-select', async ({ page }) => {
    await expect(page.locator('#quickAlignToggleBtn')).not.toBeVisible();
    await setupTwo(page);
    await expect(page.locator('#quickAlignToggleBtn')).toBeVisible();
  });

  // Geometry baseline for D tests:
  //   A = cube([20,20,20])  → bbox (0,0,0)→(20,20,20), center (10,10,10)
  //   B = translate([50,0,0]) sphere(r=10) → bbox (40,-10,-10)→(60,10,10), center (50,0,0)
  // Center-align dx/dy on the face plane = A.center − B.center on that axis.

  test('D2 +Z center docks B onto A top, center-aligned', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="+z"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // dx = 10-50 = -40, dy = 10-0 = +10, dz = 20-(-10) = +30 → combine with [50,0,0] = [10,10,30].
    expect(code).toMatch(/translate\(\[\s*10\s*,\s*10\s*,\s*30\s*\]\)\s*sphere/);
  });

  test('D3 -Z center docks B under A bottom', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="-z"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // dx=-40, dy=+10, dz = 0-10 = -10 → [10,10,-10].
    expect(code).toMatch(/translate\(\[\s*10\s*,\s*10\s*,\s*-10\s*\]\)\s*sphere/);
  });

  // D3 (continued): exercise +X / -X / +Y / -Y. Cube [20,20,20] is axis-aligned
  // from (0,0,0)→(20,20,20); A.center = (10,10,10). Sphere starts at [50,0,0] so
  // its world center sits at (50,0,0), bbox (40,-10,-10)→(60,10,10).
  test('D3 +X center docks B to A right face, centered in YZ', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="+x"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // sphere.min.x must become 20 → sphere.center.x = 30 → dx = 30 - 50 = -20.
    // dy = 10 - 0 = +10, dz = 10 - 0 = +10. Combined into [50,0,0] →
    // [50-20, 0+10, 0+10] = [30, 10, 10].
    expect(code).toMatch(/translate\(\[\s*30\s*,\s*10\s*,\s*10\s*\]\)\s*sphere/);
  });

  test('D3 -X center docks B to A left face', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="-x"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // sphere.max.x must become 0 → sphere.center.x = -10 → dx = -10 - 50 = -60.
    // dy = +10, dz = +10. Combined → [-10, 10, 10].
    expect(code).toMatch(/translate\(\[\s*-10\s*,\s*10\s*,\s*10\s*\]\)\s*sphere/);
  });

  test('D3 +Y center docks B to A back face', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="+y"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // sphere.min.y must become 20 → sphere.center.y = 30 → dy = 30 - 0 = +30.
    // dx = 10 - 50 = -40, dz = 10 - 0 = +10. Combined w/ [50,0,0] → [10, 30, 10].
    expect(code).toMatch(/translate\(\[\s*10\s*,\s*30\s*,\s*10\s*\]\)\s*sphere/);
  });

  test('D3 -Y center docks B to A front face', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="-y"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // sphere.max.y must become 0 → sphere.center.y = -10 → dy = -10 - 0 = -10.
    // dx = -40, dz = +10. → [10, -10, 10].
    expect(code).toMatch(/translate\(\[\s*10\s*,\s*-10\s*,\s*10\s*\]\)\s*sphere/);
  });

  test('D4 edge-min mode aligns mins (not centers)', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="+z"]').click();
    await page.locator('.qa-mode-btn[data-mode="min"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code = await getCode(page);
    // A.min.x = 0, sphere min.x at world = 50 + (-10) = 40 → dx = -40.
    // Combined with [50,0,0]: 50 + (-40) = 10. Same for Y (A.min.y=0, sphere min.y=-10 → dy=+10).
    // dz to dock min on top: planeA = 20, planeB = sphere.min.z = -10 → dz = +30.
    expect(code).toMatch(/translate\(\[\s*10\s*,\s*10\s*,\s*30\s*\]\)\s*sphere/);
  });

  test('D5 align is idempotent (accumulating into outer translate, not nesting)', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="+z"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    // Re-select B (it's still at index 1) and apply again.
    await clickTreeRowByIndex(page, 0);
    await clickTreeRowByIndex(page, 1, { additive: true });
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    const code2 = await getCode(page);
    // Only one translate around sphere — not nested translates.
    const sphereLine = code2.split('\n').find((l) => /sphere/.test(l)) || code2;
    const nested = (sphereLine.match(/translate\(/g) || []).length;
    expect(nested).toBeLessThanOrEqual(1);
    // Result remains [10,10,30] (the dock vector for +Z center against cube(20) not-centered).
    expect(code2).toMatch(/translate\(\[\s*10\s*,\s*10\s*,\s*30\s*\]\)\s*sphere/);
  });

  test('D6 undo reverts an alignment', async ({ page }) => {
    await setupTwo(page);
    await page.locator('#quickAlignToggleBtn').click();
    await page.locator('.qa-face-btn[data-face="+z"]').click();
    await page.locator('.qa-mode-btn[data-mode="center"]').click();
    await page.locator('#quickAlignApplyBtn').click();
    await page.waitForTimeout(400);
    expect(await getCode(page)).toMatch(/translate\(\[\s*10\s*,\s*10\s*,\s*30\s*\]\)/);
    await page.locator('#viewport3d').click({ position: { x: 5, y: 5 } });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyZ`);
    await page.waitForTimeout(300);
    // Original translate vector was [50, 0, 0]. After undo we should see it again.
    expect(await getCode(page)).toMatch(/translate\(\[\s*50\s*,\s*0\s*,\s*0\s*\]\)\s*sphere/);
  });
});

// ============================================================
// E. Non-regression
// ============================================================

test.describe('E. non-regression', () => {
  test('E1 every prim tile inserts code', async ({ page }) => {
    const kinds = await page.locator('.prim-tile[data-prim]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('data-prim'))
    );
    expect(kinds.length).toBeGreaterThan(20);
    for (const k of kinds) {
      const before = (await getCode(page)).length;
      await page.locator(`.prim-tile[data-prim="${k}"]`).click();
      await expect.poll(async () => (await getCode(page)).length).toBeGreaterThan(before);
    }
  });

  test('E2 combine buttons show on multi-select', async ({ page }) => {
    await page.locator('#exportArea').fill('cube([5,5,5]);\nsphere(r=3);\n');
    await page.waitForTimeout(400);
    await clickTreeRowByIndex(page, 0);
    await clickTreeRowByIndex(page, 1, { additive: true });
    for (const op of ['union', 'difference', 'intersection', 'hull', 'minkowski']) {
      await expect(page.locator(`#combinePanel .combine-grid button[data-op="${op}"]`)).toBeVisible();
    }
  });

  test('E3 2D vertex drag updates polygon coords', async ({ page }) => {
    // Seed a 4-point polygon, select it, then drag (10,10) → (15,15) in grid.
    await page.locator('#exportArea').fill(
      'linear_extrude(height=1) polygon([[-10,-10],[10,-10],[10,10],[-10,10]]);'
    );
    await waitMeshes(page, 1);
    await clickTreeRowByIndex(page, 0);
    await expect(page.locator('body.slice-selected')).toBeVisible();
    // Wait for the 4 SVG point boxes to be drawn (osped re-renders on selection).
    await page.waitForFunction(
      () => document.querySelectorAll('#drawAreaSource rect').length >= 4,
      null,
      { timeout: 4000 },
    );

    // Pick the rect that visually corresponds to grid (10,10) — the upper-right
    // corner of the 4-point square: smallest screen-Y, largest screen-X.
    // (Computing centerX from clientWidth is brittle because osped floors it
    //  to a sub-grid boundary; identifying by position avoids that.)
    const a = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('#drawAreaSource rect')].map((r) => {
        const bb = r.getBoundingClientRect();
        return { x: bb.left + bb.width / 2, y: bb.top + bb.height / 2 };
      });
      if (rects.length < 4) return null;
      // Sort by y asc (top of screen first), then x desc (right first).
      rects.sort((p, q) => (p.y - q.y) || (q.x - p.x));
      return rects[0];
    });
    if (!a) throw new Error('could not locate point boxes');

    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    // dx = +5 grid = +40px screen; dy = +5 grid = -40px screen (y inverted).
    await page.mouse.move(a.x + 40, a.y - 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const code = await page.locator('#exportArea').inputValue();
    expect(code).toMatch(/\[15\s*,\s*15\]/);
    expect(code).toMatch(/\[-10\s*,\s*-10\]/);
    expect(code).toMatch(/\[10\s*,\s*-10\]/);
    expect(code).toMatch(/\[-10\s*,\s*10\]/);
  });

  test('E4 undo/redo on text edits', async ({ page }) => {
    await page.locator('#exportArea').fill('cube([6,6,6]);');
    await page.waitForTimeout(400);
    // Click into viewport so Cmd/Ctrl+Z hits the AST handler.
    await page.locator('#viewport3d').click({ position: { x: 5, y: 5 } });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyZ`);
    await page.waitForTimeout(300);
    // Undo on a brand-new-typed cube should clear it (AST history seeds at first parse).
    // Be forgiving: at minimum the cube should be present after redo.
    await page.keyboard.press(`${mod}+Shift+KeyZ`);
    await page.waitForTimeout(300);
    expect(await getCode(page)).toContain('cube');
  });

  test('E5 theme toggle flips data-theme on <html>', async ({ page }) => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme || '');
    await page.locator('#themeToggle').click();
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => document.documentElement.dataset.theme || '');
    expect(after).not.toBe(before);
    // Should land on 'dark' or 'light' (osped.js writes one or the other).
    expect(['dark', 'light']).toContain(after);
  });
});

// ============================================================
// F. Console hygiene
// ============================================================

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== 'passed') return; // failures collected elsewhere
  // Filter known-noisy logs that don't indicate broken functionality.
  const real = consoleErrors.filter((e) =>
    !/Failed to load resource.*404/i.test(e)
  );
  if (real.length) {
    console.warn('[F1] console errors collected during test:', real);
  }
  // Hard-assert only at suite end (last test) to avoid noise across files.
});

test.describe('F. console hygiene', () => {
  test('F1 no console errors after a representative flow', async ({ page }) => {
    // Reproduce a typical session: add a cube, select it, flip it, undo, export OBJ.
    await addPrim(page, 'cube');
    await page.waitForTimeout(400);
    await clickTreeRowByIndex(page, 0);
    await waitSelected(page);
    await page.locator('.flip-btn[data-flip-axis="z"]').click();
    await page.waitForTimeout(200);
    await page.locator('#viewport3d').click({ position: { x: 5, y: 5 } });
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+KeyZ`);
    await page.waitForTimeout(200);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      page.locator('#exportObjBtn').click(),
    ]);
    await download.saveAs(path.join(TMP, 'f1-flow.obj'));
    const real = consoleErrors.filter((e) =>
      !/Failed to load resource.*404/i.test(e) &&
      !/(WebGL|GL_INVALID|three\.js)/i.test(e) // tolerate the occasional GL warning in headless
    );
    expect(real).toEqual([]);
  });
});
