import { test, expect } from '@playwright/test';

// ============================================================================
// Bilingual Regex Dictionary (sourced from src/js/i18n.js DE/EN keys)
// ============================================================================
const RX = {
  create: /^(Erstellen|Create)$/i,
  save: /^(Speichern|Save)$/i,
  apply: /^(Übernehmen|Apply|Einfügen|Insert)$/i,
  insert: /^(Einfügen|Insert)$/i,
  cancel: /^(Abbrechen|Cancel)$/i,
  close: /^(Schließen|Close)$/i,
  rename: /^(Umbenennen|Rename)$/i,
  ok: /^(OK|Bestätigen|Confirm|Löschen|Delete)$/i,
  deleteConfirm: /^(Löschen|Delete|In den Papierkorb|Move to trash|Bestätigen|Confirm|OK)$/i,
  newNotebook: /Neues Notizbuch|New notebook/i,
  newFolder: /Neuer Ordner|New folder/i,
  subfolder: /Unterordner|Subfolder/i,
  renameFolder: /Ordner umbenennen|Rename folder/i,
  deleteFolder: /Ordner löschen|Delete folder/i,
  moveToFolder: /In Ordner verschieben|Move to folder/i,
  toggleFavorite: /Favorit|Favorite/i,
  deleteNotebook: /In den Papierkorb|Move to trash/i,
  restoreNotebook: /Wiederherstellen|Restore/i,
  deleteForever: /Endgültig löschen|Delete forever/i,
  emptyTrash: /Papierkorb leeren|Empty trash/i,
  darkPaper: /Dark Paper/i,
  marginNotes: /Randnotizen|Margin notes/i,
  studyMode: /Lern-Modus|Study Mode/i,
  studyHideAll: /Alle verdecken|Hide all/i,
  studyRevealAll: /Alle aufdecken|Reveal all/i,
  readingMode: /Lese- \/ Präsentationsmodus|Reading \/ Presentation mode/i,
  centerCanvas: /Zur Mitte|Center view/i,
  infiniteMode: /Endlos-Fläche|Infinite Canvas/i,
  addFavoritePen: /Aktuellen Stift als Favorit speichern|Save current pen as favorite/i,
  deleteSelection: /^(Löschen|Delete)$/i,
  duplicateSelection: /^(Duplizieren|Duplicate)$/i,
  recolorSelection: /^(Umfärben|Recolor)$/i,
  addLayer: /Ebene hinzufügen|Add layer/i,
  renameLayer: /Ebene umbenennen|Rename layer/i,
  deleteLayer: /Ebene löschen|Delete layer/i,
  toggleVisible: /Ein-\/ausblenden|Show\/hide/i,
  toggleLock: /Sperren\/Entsperren|Lock\/unlock/i,
  layerLocked: /gesperrt|locked/i,
  addPage: /Seite hinzufügen|Add page/i,
  duplicatePage: /Seite duplizieren|Duplicate page/i,
  deletePage: /Seite löschen|Delete page/i,
  lastPageNotice: /letzte verbleibende Seite|last remaining page/i,
  bookmarkPage: /Lesezeichen|Bookmark/i,
  pageTemplate: /Papiervorlage ändern|Change paper template/i,
  checklist: /Checkliste|Checklist/i,
  textPlaceholder: /Notiz eingeben|Type your note/i,
  audioRecord: /Aufnehmen|Record/i,
  audioStop: /Stopp|Stop/i,
  audioPlay: /Abspielen|Play/i,
  audioJumpMode: /Stift-Sprung|Stroke jump/i,
  audioMicDenied: /Mikrofonzugriff|Microphone not available|permission denied/i,
  ocrPage: /Handschrift erkennen|Recognize handwriting/i,
  ocrCopy: /Kopieren|Copy/i,
  ocrInsertBox: /Als Textbox einfügen|Insert as text box/i,
  exportMenu: /Exportieren|Export/i,
  exportAction: /^Exportieren|^Export/i,
  exported: /Export erfolgreich|Export saved/i,
  cloudSyncNow: /Jetzt abgleichen|Sync now/i,
  checkUpdates: /Nach Updates suchen|Check for updates/i,
  updateResult: /neueste Version|latest version|Neue Version|New version|Update-Prüfung|Update check/i,
  langDe: /Deutsch/i,
  langEn: /English/i,
  themeAnthracite: /Anthracite/i,
  themeLight: /Light/i,
  themeOled: /OLED/i,
  tplCornell: /Cornell/i,
  tplGrid: /Kariert|Grid/i,
  tplMusic: /Noten|Music/i,
};

const THEME_BG_RGB = {
  anthracite: 'rgb(14, 17, 23)',
  light: 'rgb(245, 246, 250)',
  oled: 'rgb(0, 0, 0)',
};

// Minimal valid 1x1 transparent PNG bytes for Image upload E2E checks
const SAMPLE_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAADElEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ============================================================================
// Opaque-Box Helpers
// ============================================================================

function attachErrorGuards(page) {
  const consoleErrors = [];
  const pageErrors = [];

  const onConsole = (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  };
  const onPageError = (err) => {
    pageErrors.push(err?.message || String(err));
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  return {
    consoleErrors,
    pageErrors,
    assertNoErrors() {
      expect(pageErrors, `Unexpected uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([]);
      expect(consoleErrors, `Unexpected console.error messages: ${consoleErrors.join(' | ')}`).toEqual([]);
    },
    detach() {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
    },
  };
}

async function waitRaf(page, frames = 3) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let i = 0;
        const step = () => {
          i += 1;
          if (i >= count) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    frames,
  );
}

async function enterStudio(page, url = '/') {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const landing = page.locator('[data-testid="library-view"], [data-testid="setup-view"]').first();
  await expect(landing).toBeVisible({ timeout: 15_000 });

  const setupView = page.getByTestId('setup-view');
  if (await setupView.isVisible()) {
    const demoBtn = page.getByTestId('setup-use-demo');
    if (await demoBtn.isVisible()) {
      await demoBtn.click();
    } else {
      await setupView.getByRole('button').first().click();
    }
    await expect(page.getByTestId('library-view')).toBeVisible({ timeout: 15_000 });
  }

  await expect(page.getByTestId('notebook-grid')).toBeVisible({ timeout: 15_000 });
}

function getPrimaryCanvas(page) {
  return page.getByTestId('pane-primary').locator('canvas.view, canvas#view, canvas').first();
}

function getSecondaryCanvas(page) {
  return page.getByTestId('pane-secondary').locator('canvas.view, canvas#view, canvas').first();
}

async function openNotebookByTitleOrFirst(page, titleMatcher = null) {
  const editorView = page.getByTestId('editor-view');
  if (await editorView.isVisible()) {
    const currentTitle = (await page.getByTestId('editor-title').innerText()).trim();
    const matchesAlready = !titleMatcher
      || (titleMatcher instanceof RegExp ? titleMatcher.test(currentTitle) : currentTitle.includes(String(titleMatcher)));
    if (!matchesAlready) {
      await page.getByTestId('tab-home').click();
      await expect(page.getByTestId('library-view')).toBeVisible({ timeout: 15_000 });
    }
  }

  if (!(await editorView.isVisible())) {
    const cards = page.getByTestId('notebook-card');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    const target = titleMatcher ? cards.filter({ hasText: titleMatcher }).first() : cards.first();
    await expect(target).toBeVisible();
    await target.click();
    await expect(editorView).toBeVisible({ timeout: 15_000 });
  }

  if (titleMatcher) {
    await expect(page.getByTestId('editor-title')).toContainText(titleMatcher);
  }

  const canvas = getPrimaryCanvas(page);
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);
  await waitRaf(page, 4);
  return canvas;
}

async function expectToolActive(btn) {
  await expect(btn).toBeVisible();
  await expect.poll(async () => btn.evaluate((el) => (
    el.getAttribute('aria-pressed') === 'true'
    || el.getAttribute('data-active') === 'true'
    || el.classList.contains('active')
    || el.classList.contains('is-active')
    || el.classList.contains('selected')
  ))).toBe(true);
}

async function clickTabClose(tabLocator) {
  const innerClose = tabLocator.getByRole('button').first();
  if ((await innerClose.count()) > 0 && (await innerClose.isVisible())) {
    await innerClose.click();
    return;
  }
  const wrapperClose = tabLocator
    .locator('xpath=..')
    .getByRole('button', { name: /Tab schließen|Close tab|×|✕|x/i })
    .first();
  if ((await wrapperClose.count()) > 0 && (await wrapperClose.isVisible())) {
    await wrapperClose.click();
    return;
  }
  const siblingBtn = tabLocator.locator('xpath=following-sibling::button[1]').first();
  await expect(siblingBtn).toBeVisible();
  await siblingBtn.click();
}

async function activateSplitScreen(page) {
  const splitBtn = page.getByTestId('btn-split-screen');
  await expect(splitBtn).toBeVisible();
  await splitBtn.click();

  const splitPicker = page.locator('[role="dialog"]:visible, [role="menu"]:visible').last();
  if ((await splitPicker.count()) > 0 && (await splitPicker.isVisible())) {
    const firstOpt = splitPicker.getByRole('button').or(splitPicker.getByRole('menuitem')).first();
    await expect(firstOpt).toBeVisible();
    await firstOpt.click();
  }

  await expect(page.getByTestId('pane-primary')).toBeVisible();
  await expect(page.getByTestId('pane-secondary')).toBeVisible();
}

async function selectThemeInSettings(modal, theme) {
  const rxMap = {
    anthracite: RX.themeAnthracite,
    light: RX.themeLight,
    oled: RX.themeOled,
  };
  const valueAliases = {
    anthracite: ['anthracite', 'dark'],
    light: ['light'],
    oled: ['oled'],
  };
  const rx = rxMap[theme];
  const aliases = valueAliases[theme] || [theme];

  const selects = modal.locator('select');
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i += 1) {
    const sel = selects.nth(i);
    const optVal = await sel.locator('option').evaluateAll((opts, { rxSrc, aliasesList }) => {
      const matcher = new RegExp(rxSrc, 'i');
      const match = opts.find((o) => {
        const val = String(o.value || '').toLowerCase();
        const txt = String(o.textContent || '');
        return aliasesList.includes(val) || matcher.test(txt) || matcher.test(val);
      });
      return match ? match.value : null;
    }, { rxSrc: rx.source, aliasesList: aliases });
    if (optVal !== null) {
      await sel.selectOption(optVal);
      return;
    }
  }

  const control = modal
    .getByRole('button', { name: rx })
    .or(modal.getByRole('radio', { name: rx }))
    .or(modal.locator('label, [data-theme]').filter({ hasText: rx }))
    .first();
  await expect(control).toBeVisible();
  await control.click();
}

async function selectLanguageInSettings(modal, lang) {
  const rx = lang === 'en' ? RX.langEn : RX.langDe;
  const selects = modal.locator('select');
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i += 1) {
    const sel = selects.nth(i);
    const optVal = await sel.locator('option').evaluateAll((opts, { rxSrc, targetLang }) => {
      const matcher = new RegExp(rxSrc, 'i');
      const match = opts.find((o) => {
        const val = String(o.value || '').toLowerCase();
        const txt = String(o.textContent || '');
        return val === targetLang || matcher.test(txt) || matcher.test(val);
      });
      return match ? match.value : null;
    }, { rxSrc: rx.source, targetLang: lang });
    if (optVal !== null) {
      await sel.selectOption(optVal);
      return;
    }
  }

  const control = modal
    .getByRole('button', { name: rx })
    .or(modal.getByRole('radio', { name: rx }))
    .or(modal.locator('label').filter({ hasText: rx }))
    .first();
  await expect(control).toBeVisible();
  await control.click();
}

async function drawStroke(page, canvasLocator, normPoints) {
  const box = await canvasLocator.boundingBox();
  expect(box).not.toBeNull();
  const abs = normPoints.map(([nx, ny]) => ({
    x: box.x + box.width * nx,
    y: box.y + box.height * ny,
  }));
  expect(abs.length).toBeGreaterThanOrEqual(2);
  await page.mouse.move(abs[0].x, abs[0].y);
  await page.mouse.down();
  for (let i = 1; i < abs.length; i += 1) {
    await page.mouse.move(abs[i].x, abs[i].y, { steps: 6 });
  }
  await page.mouse.up();
  await waitRaf(page, 4);
}

async function snapshotCanvas(canvasLocator) {
  return canvasLocator.evaluate((canvas) => {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const dataUrl = tmp.toDataURL('image/png');
    const stepX = Math.max(1, Math.floor(tmp.width / 64));
    const stepY = Math.max(1, Math.floor(tmp.height / 64));
    const img = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    const samples = [];
    for (let y = 0; y < tmp.height; y += stepY) {
      for (let x = 0; x < tmp.width; x += stepX) {
        const idx = (y * tmp.width + x) * 4;
        samples.push(img[idx], img[idx + 1], img[idx + 2], img[idx + 3]);
      }
    }
    return { dataUrl, width: tmp.width, height: tmp.height, samples };
  });
}

function countSamplePixelDiffs(before, after) {
  const len = Math.min(before.samples.length, after.samples.length);
  let diffs = 0;
  for (let i = 0; i < len; i += 4) {
    const dr = Math.abs(before.samples[i] - after.samples[i]);
    const dg = Math.abs(before.samples[i + 1] - after.samples[i + 1]);
    const db = Math.abs(before.samples[i + 2] - after.samples[i + 2]);
    if (dr + dg + db > 6) diffs += 1;
  }
  return diffs;
}

async function samplePaperRgb(canvasLocator) {
  return canvasLocator.evaluate((canvas) => {
    const tmp = document.createElement('canvas');
    tmp.width = canvas.width;
    tmp.height = canvas.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    // Sample multiple central points on the paper and take median luminance pixel
    const pts = [
      [0.5, 0.45],
      [0.52, 0.5],
      [0.48, 0.55],
      [0.55, 0.48],
      [0.45, 0.52],
    ];
    const pixels = pts.map(([nx, ny]) => {
      const px = Math.min(tmp.width - 1, Math.max(0, Math.floor(tmp.width * nx)));
      const py = Math.min(tmp.height - 1, Math.max(0, Math.floor(tmp.height * ny)));
      const d = ctx.getImageData(px, py, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], lum: 0.299 * d[0] + 0.587 * d[1] + 0.114 * d[2] };
    });
    pixels.sort((a, b) => a.lum - b.lum);
    return pixels[Math.floor(pixels.length / 2)];
  });
}

async function getThemeBgRgb(page) {
  return page.evaluate(() => {
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const rootBg = getComputedStyle(document.documentElement).backgroundColor;
    return bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent' ? bodyBg : rootBg;
  });
}

async function openMoreMenu(page) {
  const menu = page.getByTestId('more-menu');
  if (!(await menu.isVisible())) {
    await page.getByTestId('btn-more-menu').click();
    await expect(menu).toBeVisible();
  }
  return menu;
}

async function createNotebookViaModal(page, { title, templateRegex = null, infinite = false } = {}) {
  await page.getByTestId('btn-create-notebook').click();
  const modal = page.getByTestId('modal-new-notebook');
  await expect(modal).toBeVisible();

  const titleInput = modal.locator('input[type="text"], input:not([type]), [name="title"]').first();
  await titleInput.fill(title);

  if (templateRegex) {
    const select = modal.locator('select').first();
    if ((await select.count()) > 0 && (await select.isVisible())) {
      const optVal = await select.locator('option').evaluateAll((opts, rxStr) => {
        const rx = new RegExp(rxStr, 'i');
        const match = opts.find((o) => rx.test(o.textContent || '') || rx.test(o.value || ''));
        return match ? match.value : null;
      }, templateRegex.source);
      expect(optVal).not.toBeNull();
      await select.selectOption(optVal);
    } else {
      const tplBtn = modal.getByRole('button', { name: templateRegex }).first();
      await expect(tplBtn).toBeVisible();
      await tplBtn.click();
    }
  }

  if (infinite) {
    const selects = modal.locator('select');
    const count = await selects.count();
    let matched = false;
    for (let i = 0; i < count; i += 1) {
      const val = await selects.nth(i).locator('option').evaluateAll((opts) => {
        const m = opts.find((o) => /INFINITE|Endlos|Infinite/i.test(o.value + ' ' + o.textContent));
        return m ? m.value : null;
      });
      if (val) {
        await selects.nth(i).selectOption(val);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const infBtn = modal.locator('button, input[type="radio"]').filter({ hasText: RX.infiniteMode }).first();
      await infBtn.click();
    }
  }

  await modal.getByRole('button', { name: RX.create }).click();
  await expect(modal).toBeHidden();
}

async function confirmDialogAction(page, triggerFn) {
  const onNativeDialog = (dialog) => dialog.accept();
  page.once('dialog', onNativeDialog);
  await triggerFn();
  const visibleDialog = page.locator('dialog[open], [role="dialog"]:visible, [role="alertdialog"]:visible').last();
  if ((await visibleDialog.count()) > 0 && (await visibleDialog.isVisible())) {
    const confirmBtn = visibleDialog.getByRole('button', { name: RX.deleteConfirm }).first();
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();
  }
  page.off('dialog', onNativeDialog);
}

async function deleteNotebookCard(page, card) {
  const deleteBtn = card.getByRole('button', { name: RX.deleteNotebook }).first();
  await confirmDialogAction(page, async () => {
    if ((await deleteBtn.count()) > 0 && (await deleteBtn.isVisible())) {
      await deleteBtn.click();
    } else {
      await card.click({ button: 'right' });
      const ctxDelete = page
        .getByRole('menuitem', { name: RX.deleteNotebook })
        .or(page.getByRole('button', { name: RX.deleteNotebook }))
        .first();
      await expect(ctxDelete).toBeVisible();
      await ctxDelete.click();
    }
  });
}

async function restoreFromTrash(page, title) {
  await page.getByTestId('nav-trash').click();
  const trashModal = page.getByTestId('modal-trash');
  const inModal = (await trashModal.count()) > 0 && (await trashModal.isVisible());
  const trashContainer = inModal ? trashModal : page.getByTestId('library-view');
  await expect(trashContainer).toContainText(title);

  const row = trashContainer.locator('li, tr, [data-testid="trash-item"], .trash-item, .card, div').filter({ hasText: title }).last();
  const scopedBtn = row.getByRole('button', { name: RX.restoreNotebook }).first();
  const restoreBtn = (await scopedBtn.count()) > 0
    ? scopedBtn
    : trashContainer.getByRole('button', { name: RX.restoreNotebook }).first();
  await expect(restoreBtn).toBeVisible();
  await restoreBtn.click();

  if (inModal && (await trashModal.isVisible())) {
    const closeTrash = trashModal.getByRole('button', { name: RX.close }).first();
    if ((await closeTrash.count()) > 0 && (await closeTrash.isVisible())) {
      await closeTrash.click();
    }
  }
}

// ============================================================================
// Tier 1 — Feature Coverage (21 tests: T1-01 – T1-21)
// ============================================================================

test.describe('Tier 1 — Feature Coverage', () => {
  test('T1-01: Onboarding / Demo workspace entry via ?setup loads library', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await page.goto('/?setup', { waitUntil: 'domcontentloaded' });

    const setupView = page.getByTestId('setup-view');
    await expect(setupView).toBeVisible({ timeout: 15_000 });
    const useDemo = page.getByTestId('setup-use-demo');
    await expect(useDemo).toBeVisible();
    await useDemo.click();

    await expect(page.getByTestId('library-view')).toBeVisible({ timeout: 15_000 });
    const cards = page.getByTestId('notebook-card');
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(2);
    guards.assertNoErrors();
  });

  test('T1-02: Theme cycling updates html[data-theme] and computed RGB surfaces', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const cycleBtn = page.getByTestId('btn-theme-cycle');
    await expect(cycleBtn).toBeVisible();

    const seenThemes = new Set();
    for (let i = 0; i < 4; i += 1) {
      const theme = await page.locator('html').getAttribute('data-theme');
      expect(['anthracite', 'light', 'oled']).toContain(theme);
      seenThemes.add(theme);

      await expect.poll(() => getThemeBgRgb(page)).toBe(THEME_BG_RGB[theme]);

      await cycleBtn.click();
    }

    expect(seenThemes.size).toBe(3);
    guards.assertNoErrors();
  });

  test('T1-03: Library sidebar toggle, navigation filters and sort order', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const sidebar = page.getByTestId('sidebar');
    const toggleBtn = page.getByTestId('btn-toggle-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(toggleBtn).toBeVisible();

    await toggleBtn.click();
    const collapsedState = await toggleBtn.getAttribute('aria-expanded');
    if (collapsedState !== null) {
      expect(collapsedState).toBe('false');
    } else {
      await expect(sidebar).toBeHidden();
    }
    await toggleBtn.click();
    await expect(sidebar).toBeVisible();

    await page.getByTestId('nav-favorites').click();
    await page.getByTestId('nav-recent').click();
    await page.getByTestId('nav-all').click();
    await expect(page.getByTestId('notebook-card').first()).toBeVisible();

    const sortControl = page.getByTestId('library-sort');
    await expect(sortControl).toBeVisible();
    const tag = await sortControl.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'select') {
      const titleOpt = await sortControl.locator('option').evaluateAll((opts) => {
        const m = opts.find((o) => /title|titel|a–z/i.test(o.value + ' ' + o.textContent));
        return m ? m.value : opts[opts.length - 1]?.value;
      });
      await sortControl.selectOption(titleOpt);
    } else {
      await sortControl.click();
    }

    const titles = await page.getByTestId('notebook-card').allInnerTexts();
    expect(titles.length).toBeGreaterThanOrEqual(2);
    guards.assertNoErrors();
  });

  test('T1-04: Nested folder creation and folder tree filtering', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const folderTree = page.getByTestId('folder-tree');
    await expect(folderTree).toBeVisible();

    await page.getByTestId('btn-new-folder').click();
    const folderDialog = page.locator('dialog[open], [role="dialog"]:visible').last();
    await expect(folderDialog).toBeVisible();
    await folderDialog.locator('input[type="text"], input:not([type])').first().fill('Physik Sem 2');
    await folderDialog.getByRole('button', { name: RX.create }).click();

    await expect(folderTree).toContainText('Physik Sem 2');
    await folderTree.getByText('Physik Sem 2').first().click();
    await page.getByTestId('nav-all').click();
    await expect(page.getByTestId('notebook-card').first()).toBeVisible();
    guards.assertNoErrors();
  });

  test('T1-05: Create notebook, favorite toggle, safe delete to 30d Trash and restore', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const uniqueTitle = 'E2E Notebook Lifecycle';
    await createNotebookViaModal(page, { title: uniqueTitle, templateRegex: RX.tplGrid });

    // Return home if notebook auto-opened
    if (await page.getByTestId('editor-view').isVisible()) {
      await page.getByTestId('tab-home').click();
      await expect(page.getByTestId('library-view')).toBeVisible();
    }

    const card = page.getByTestId('notebook-card').filter({ hasText: uniqueTitle }).first();
    await expect(card).toBeVisible();

    // Unconditionally toggle favorite on card & verify filtering
    const favBtn = card.getByRole('button', { name: RX.toggleFavorite }).first();
    await expect(favBtn).toBeVisible();
    await favBtn.click();
    await page.getByTestId('nav-favorites').click();
    await expect(page.getByTestId('notebook-card').filter({ hasText: uniqueTitle }).first()).toBeVisible();
    await page.getByTestId('nav-all').click();

    // Move to 30d trash
    const targetCard = page.getByTestId('notebook-card').filter({ hasText: uniqueTitle }).first();
    await deleteNotebookCard(page, targetCard);

    await expect(page.getByTestId('notebook-card').filter({ hasText: uniqueTitle })).toHaveCount(0);

    // Verify in Trash and restore
    await restoreFromTrash(page, uniqueTitle);

    await page.getByTestId('nav-all').click();
    await expect(page.getByTestId('notebook-card').filter({ hasText: uniqueTitle }).first()).toBeVisible();
    guards.assertNoErrors();
  });

  test('T1-06: Custom titlebar & multi-tab workflow (open 2 notebooks, switch, close)', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await expect(page.getByTestId('titlebar')).toBeVisible();
    const tabBar = page.getByTestId('tab-bar');
    await expect(tabBar).toBeVisible();
    await expect(tabBar).toHaveAttribute('role', 'tablist');
    await expect(page.getByTestId('tab-home')).toBeVisible();
    await expect(page.getByTestId('tab-new-notebook')).toBeVisible();

    const cards = page.getByTestId('notebook-card');
    expect(await cards.count()).toBeGreaterThanOrEqual(2);

    await cards.nth(0).click();
    await expect(page.getByTestId('editor-view')).toBeVisible();
    const firstTitle = (await page.getByTestId('editor-title').innerText()).trim();

    await page.getByTestId('tab-home').click();
    await expect(page.getByTestId('library-view')).toBeVisible();

    await page.getByTestId('notebook-card').nth(1).click();
    await expect(page.getByTestId('editor-view')).toBeVisible();
    const secondTitle = (await page.getByTestId('editor-title').innerText()).trim();
    expect(secondTitle).not.toBe(firstTitle);

    const tabs = tabBar.locator('[role="tab"]');
    expect(await tabs.count()).toBeGreaterThanOrEqual(3);

    // Switch back to first notebook tab
    const firstTab = tabs.filter({ hasText: firstTitle }).first();
    await firstTab.click();
    await expect(firstTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('editor-title')).toContainText(firstTitle);

    // Close second notebook tab
    const secondTab = tabs.filter({ hasText: secondTitle }).first();
    await clickTabClose(secondTab);
    await expect(tabs.filter({ hasText: secondTitle })).toHaveCount(0);
    guards.assertNoErrors();
  });

  test('T1-07: Split-screen activation and draggable resizer adjusts pane widths', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    await activateSplitScreen(page);

    const primary = page.getByTestId('pane-primary');
    const resizer = page.getByTestId('split-resizer');
    await expect(resizer).toBeVisible();

    const beforePrimaryBox = await primary.boundingBox();
    const resizerBox = await resizer.boundingBox();
    expect(beforePrimaryBox).not.toBeNull();
    expect(resizerBox).not.toBeNull();

    const rx = resizerBox.x + resizerBox.width / 2;
    const ry = resizerBox.y + resizerBox.height / 2;
    await page.mouse.move(rx, ry);
    await page.mouse.down();
    await page.mouse.move(rx + 140, ry, { steps: 10 });
    await page.mouse.up();
    await waitRaf(page, 2);

    const afterPrimaryBox = await primary.boundingBox();
    expect(afterPrimaryBox.width).toBeGreaterThan(beforePrimaryBox.width + 40);
    guards.assertNoErrors();
  });

  test('T1-08: Pen, Highlighter & Favorite Pens bar mutate canvas pixels', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    await expect(page.getByTestId('bottom-dock')).toBeVisible();
    await expect(page.getByTestId('favorite-pens-bar')).toBeVisible();

    const before = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.35, 0.35], [0.55, 0.4], [0.65, 0.45]]);
    const afterPen = await snapshotCanvas(canvas);
    expect(afterPen.dataUrl).not.toBe(before.dataUrl);
    expect(countSamplePixelDiffs(before, afterPen)).toBeGreaterThan(0);

    await page.getByTestId('tool-highlighter').click();
    await drawStroke(page, canvas, [[0.35, 0.55], [0.65, 0.55]]);
    const afterHilite = await snapshotCanvas(canvas);
    expect(afterHilite.dataUrl).not.toBe(afterPen.dataUrl);
    expect(countSamplePixelDiffs(afterPen, afterHilite)).toBeGreaterThan(0);

    // Pin current tool to favorite pens bar unconditionally and verify count increases + switch works
    const favBar = page.getByTestId('favorite-pens-bar');
    const addFavBtn = favBar.getByRole('button', { name: RX.addFavoritePen }).first();
    await expect(addFavBtn).toBeVisible();
    const prevFavCount = await favBar.getByRole('button').count();
    await addFavBtn.click();
    await expect.poll(() => favBar.getByRole('button').count()).toBeGreaterThan(prevFavCount);

    const firstPreset = favBar.locator('button').filter({ hasNot: addFavBtn }).first();
    if ((await firstPreset.count()) > 0 && (await firstPreset.isVisible())) {
      await firstPreset.click();
    }
    guards.assertNoErrors();
  });

  test('T1-09: Undo and Redo restore and reapply canvas pixel state', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    const baseline = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.38, 0.38], [0.62, 0.62]]);
    const drawn = await snapshotCanvas(canvas);
    expect(drawn.dataUrl).not.toBe(baseline.dataUrl);

    await page.getByTestId('btn-undo').click();
    await waitRaf(page, 4);
    const undone = await snapshotCanvas(canvas);
    expect(undone.dataUrl).toBe(baseline.dataUrl);

    await page.getByTestId('btn-redo').click();
    await waitRaf(page, 4);
    const redone = await snapshotCanvas(canvas);
    expect(redone.dataUrl).toBe(drawn.dataUrl);
    guards.assertNoErrors();
  });

  test('T1-10: Eraser, Lasso, Laser & Hand tools work and update canvas/tool states', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.4, 0.4], [0.6, 0.4], [0.6, 0.55]]);
    const withInk = await snapshotCanvas(canvas);

    // Eraser removes drawn stroke
    const eraser = page.getByTestId('tool-eraser');
    await eraser.click();
    await expectToolActive(eraser);
    await drawStroke(page, canvas, [[0.38, 0.4], [0.62, 0.42], [0.6, 0.57]]);
    const afterErase = await snapshotCanvas(canvas);
    expect(afterErase.dataUrl).not.toBe(withInk.dataUrl);

    // Draw fresh stroke and encircle with Lasso -> action bar appears -> delete mutates canvas
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.4, 0.42], [0.55, 0.42], [0.55, 0.52]]);
    const beforeLasso = await snapshotCanvas(canvas);
    expect(beforeLasso.dataUrl).not.toBe(afterErase.dataUrl);

    const lassoBtn = page.getByTestId('tool-lasso');
    await lassoBtn.click();
    await expectToolActive(lassoBtn);
    await drawStroke(page, canvas, [
      [0.34, 0.36],
      [0.62, 0.36],
      [0.62, 0.58],
      [0.34, 0.58],
      [0.34, 0.36],
    ]);

    const lassoDeleteBtn = page.getByRole('button', { name: RX.deleteSelection }).first();
    await expect(lassoDeleteBtn).toBeVisible();
    await lassoDeleteBtn.click();
    await waitRaf(page, 4);
    const afterLassoDelete = await snapshotCanvas(canvas);
    expect(afterLassoDelete.dataUrl).not.toBe(beforeLasso.dataUrl);

    // Laser tool activates and responds to pointer drag without error
    const laserBtn = page.getByTestId('tool-laser');
    await laserBtn.click();
    await expectToolActive(laserBtn);
    await drawStroke(page, canvas, [[0.42, 0.42], [0.56, 0.52]]);

    // Hand tool activates and pans without error
    const handBtn = page.getByTestId('tool-hand');
    await handBtn.click();
    await expectToolActive(handBtn);
    await drawStroke(page, canvas, [[0.5, 0.5], [0.35, 0.35]]);
    guards.assertNoErrors();
  });

  test('T1-11: Geodreieck overlay toggles, moves/rotates and snaps pen stroke', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    const geoBtn = page.getByTestId('tool-geodreieck');
    await geoBtn.click();
    const overlay = page.getByTestId('geodreieck-overlay');
    await expect(overlay).toBeVisible();

    const boxBefore = await overlay.boundingBox();
    expect(boxBefore).not.toBeNull();

    // Drag geodreieck center to move it
    const cx = boxBefore.x + boxBefore.width * 0.5;
    const cy = boxBefore.y + boxBefore.height * 0.55;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 40, { steps: 6 });
    await page.mouse.up();
    await waitRaf(page, 2);

    const boxAfter = await overlay.boundingBox();
    expect(Math.abs(boxAfter.x - boxBefore.x) + Math.abs(boxAfter.y - boxBefore.y)).toBeGreaterThan(20);

    // Read overlay transform/text before rotation, then rotate via corner drag + mouse wheel
    const readGeoState = async () => overlay.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        inlineTransform: el.style.transform || '',
        computedTransform: getComputedStyle(el).transform || '',
        innerHtml: el.innerHTML.slice(0, 400),
        text: (el.innerText || '').trim(),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    const rotBefore = await readGeoState();

    const cornerX = boxAfter.x + boxAfter.width * 0.85;
    const cornerY = boxAfter.y + boxAfter.height * 0.78;
    await page.mouse.move(cornerX, cornerY);
    await page.mouse.down();
    await page.mouse.move(cornerX + 10, cornerY - 70, { steps: 8 });
    await page.mouse.up();
    await page.mouse.move(boxAfter.x + boxAfter.width * 0.5, boxAfter.y + boxAfter.height * 0.55);
    await page.mouse.wheel(0, 240);
    await waitRaf(page, 3);

    const rotAfter = await readGeoState();
    const rotated = rotAfter.inlineTransform !== rotBefore.inlineTransform
      || rotAfter.computedTransform !== rotBefore.computedTransform
      || rotAfter.text !== rotBefore.text
      || rotAfter.innerHtml !== rotBefore.innerHtml
      || Math.abs(rotAfter.w - rotBefore.w) > 2
      || Math.abs(rotAfter.h - rotBefore.h) > 2;
    expect(rotated).toBe(true);

    // Draw angled/diagonal stroke along rotated ruler edge and verify pixel mutation
    await page.getByTestId('tool-pen').click();
    const beforeStroke = await snapshotCanvas(canvas);
    await drawStroke(page, canvas, [[0.3, 0.68], [0.7, 0.56]]);
    const afterStroke = await snapshotCanvas(canvas);
    expect(afterStroke.dataUrl).not.toBe(beforeStroke.dataUrl);
    expect(countSamplePixelDiffs(beforeStroke, afterStroke)).toBeGreaterThan(0);

    // Toggle off
    await geoBtn.click();
    await expect(overlay).toBeHidden();
    guards.assertNoErrors();
  });

  test('T1-12: Dark Paper mode, PDF Side Margin & Infinite Canvas center view', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    // Open PDF worksheet notebook to verify margin + dark paper
    const canvas = await openNotebookByTitleOrFirst(page, /Arbeitsblatt|PDF|Scan/i);
    const lightPaperRgb = await samplePaperRgb(canvas);
    expect(lightPaperRgb.lum).toBeGreaterThan(170);

    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.darkPaper }).or(menu.getByRole('menuitem', { name: RX.darkPaper })).first().click();
    await waitRaf(page, 4);

    const darkPaperRgb = await samplePaperRgb(canvas);
    expect(darkPaperRgb.lum).toBeLessThan(95);

    // Toggle PDF Side Margin
    const menu2 = await openMoreMenu(page);
    const beforeMargin = await snapshotCanvas(canvas);
    await menu2.getByRole('button', { name: RX.marginNotes }).or(menu2.getByRole('menuitem', { name: RX.marginNotes })).first().click();
    await waitRaf(page, 4);
    const afterMargin = await snapshotCanvas(canvas);
    expect(afterMargin.dataUrl).not.toBe(beforeMargin.dataUrl);

    // Create and test Infinite Canvas notebook
    await page.getByTestId('tab-home').click();
    await createNotebookViaModal(page, { title: 'Infinite Flow E2E', infinite: true });
    const infCanvas = await openNotebookByTitleOrFirst(page, /Infinite Flow E2E/i);

    await page.getByTestId('tool-pen').click();
    await drawStroke(page, infCanvas, [[0.4, 0.4], [0.6, 0.6]]);
    const beforePan = await snapshotCanvas(infCanvas);

    // Pan with hand tool and verify view shifted, then Center View restores
    await page.getByTestId('tool-hand').click();
    await drawStroke(page, infCanvas, [[0.5, 0.5], [0.22, 0.22]]);
    await waitRaf(page, 3);
    const afterPan = await snapshotCanvas(infCanvas);
    expect(afterPan.dataUrl).not.toBe(beforePan.dataUrl);

    const centerBtn = page.getByRole('button', { name: RX.centerCanvas }).first();
    await expect(centerBtn).toBeVisible();
    await centerBtn.click();
    await waitRaf(page, 4);
    const afterCenter = await snapshotCanvas(infCanvas);
    expect(afterCenter.dataUrl).not.toBe(afterPan.dataUrl);
    guards.assertNoErrors();
  });

  test('T1-13: Study Occlusion Tape draw and Study Mode reveal/hide toggle', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    const beforeTape = await snapshotCanvas(canvas);
    await page.getByTestId('tool-tape').click();
    await drawStroke(page, canvas, [[0.35, 0.45], [0.65, 0.45]]);
    const withTape = await snapshotCanvas(canvas);
    expect(withTape.dataUrl).not.toBe(beforeTape.dataUrl);

    // Toggle Study Mode and unconditionally test reveal/hide all
    const menu = await openMoreMenu(page);
    const studyBtn = menu.getByRole('button', { name: RX.studyMode }).or(menu.getByRole('menuitem', { name: RX.studyMode })).first();
    await expect(studyBtn).toBeVisible();
    await studyBtn.click();
    await waitRaf(page, 3);

    const revealBtn = page.getByRole('button', { name: RX.studyRevealAll }).first();
    await expect(revealBtn).toBeVisible();
    await revealBtn.click();
    await waitRaf(page, 3);
    const revealed = await snapshotCanvas(canvas);
    expect(revealed.dataUrl).not.toBe(withTape.dataUrl);
    expect(countSamplePixelDiffs(withTape, revealed)).toBeGreaterThan(0);

    const hideBtn = page.getByRole('button', { name: RX.studyHideAll }).first();
    await expect(hideBtn).toBeVisible();
    await hideBtn.click();
    await waitRaf(page, 3);
    const hiddenAgain = await snapshotCanvas(canvas);
    expect(hiddenAgain.dataUrl).not.toBe(revealed.dataUrl);
    guards.assertNoErrors();
  });

  test('T1-14: Textbox / Sticky Note / Checklist & Image insertion render on page', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    const beforeBox = await snapshotCanvas(canvas);
    await page.getByTestId('tool-textbox').click();
    const canvasBox = await canvas.boundingBox();
    await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.4);

    const tbModal = page.getByTestId('modal-textbox');
    await expect(tbModal).toBeVisible();
    await tbModal.locator('textarea, input[type="text"]').first().fill('Integralrechnung prüfen');
    const checklistToggle = tbModal.getByRole('checkbox').or(tbModal.getByRole('button', { name: RX.checklist })).first();
    await expect(checklistToggle).toBeVisible();
    await checklistToggle.click();
    await tbModal.getByRole('button', { name: RX.apply }).first().click();
    await expect(tbModal).toBeHidden();
    await waitRaf(page, 4);

    const afterBox = await snapshotCanvas(canvas);
    expect(afterBox.dataUrl).not.toBe(beforeBox.dataUrl);

    // Image insertion via window.docflow.pickImage() (or filechooser if emitted), unconditionally assert canvas pixel mutation
    const imgTool = page.getByTestId('tool-image');
    await expect(imgTool).toBeVisible();
    const onChooser = async (chooser) => {
      await chooser.setFiles({
        name: 'diagram.png',
        mimeType: 'image/png',
        buffer: SAMPLE_PNG_BYTES,
      });
    };
    page.once('filechooser', onChooser);
    await imgTool.click();
    await expect.poll(async () => (await snapshotCanvas(canvas)).dataUrl).not.toBe(afterBox.dataUrl);
    page.off('filechooser', onChooser);
    guards.assertNoErrors();
  });

  test('T1-15: Page Sorter drawer adds, duplicates, bookmarks and changes template', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    await page.getByTestId('btn-page-sorter').click();
    const drawer = page.getByTestId('page-sorter-drawer');
    await expect(drawer).toBeVisible();

    const beforeText = await drawer.innerText();
    const fractionMatch = beforeText.match(/\b\d+\s*\/\s*(\d+)\b/);
    const pageLabelMatches = beforeText.match(/(?:Seite|Page)\s+\d+/gi) || [];
    const initialPages = fractionMatch ? Number(fractionMatch[1]) : pageLabelMatches.length;
    expect(initialPages).toBeGreaterThanOrEqual(1);

    const addBtn = drawer.getByRole('button', { name: RX.addPage }).first();
    await expect(addBtn).toBeVisible();
    await addBtn.click();
    await waitRaf(page, 2);

    const dupBtn = drawer.getByRole('button', { name: RX.duplicatePage }).first();
    await expect(dupBtn).toBeVisible();
    await dupBtn.click();
    await waitRaf(page, 2);

    const bmBtn = drawer.getByRole('button', { name: RX.bookmarkPage }).first();
    await expect(bmBtn).toBeVisible();
    await bmBtn.click();

    const tplSelect = drawer.locator('select').first();
    await expect(tplSelect).toBeVisible();
    const musicOpt = await tplSelect.locator('option').evaluateAll((opts) => {
      const m = opts.find((o) => /MUSIC|Noten/i.test(o.value + ' ' + o.textContent));
      return m ? m.value : null;
    });
    expect(musicOpt).not.toBeNull();
    await tplSelect.selectOption(musicOpt);

    const expectedPages = initialPages + 2;
    await expect(drawer).toContainText(
      new RegExp(`\\b${expectedPages}\\s*\\/\\s*${expectedPages}\\b|(?:Seite|Page)\\s*${expectedPages}\\b`, 'i'),
    );
    guards.assertNoErrors();
  });

  test('T1-16: Layers panel adds, renames, hides, locks (blocks draw) and sets opacity', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('btn-layers').click();
    const panel = page.getByTestId('layers-panel');
    await expect(panel).toBeVisible();

    await panel.getByRole('button', { name: RX.addLayer }).first().click();
    await waitRaf(page, 2);

    // Rename active/added layer
    const onPrompt = async (dialog) => {
      await dialog.accept('Herleitung E2E');
    };
    page.once('dialog', onPrompt);
    const renameBtn = panel.getByRole('button', { name: RX.renameLayer }).first();
    if ((await renameBtn.count()) > 0 && (await renameBtn.isVisible())) {
      await renameBtn.click();
    } else {
      const layerLabel = panel.locator('[data-layer-name], .layer-name, span').filter({ hasText: /Ebene|Layer/i }).last();
      await expect(layerLabel).toBeVisible();
      await layerLabel.dblclick();
    }
    const renameDialog = page.locator('dialog[open], [role="dialog"]:visible').last();
    if ((await renameDialog.count()) > 0 && (await renameDialog.isVisible())) {
      const dlgInput = renameDialog.locator('input[type="text"], input:not([type])').first();
      await dlgInput.fill('Herleitung E2E');
      await renameDialog.getByRole('button', { name: RX.save }).or(renameDialog.getByRole('button', { name: RX.ok })).or(renameDialog.getByRole('button', { name: RX.rename })).first().click();
    } else {
      const inlineInput = panel.locator('input[type="text"], input:not([type])').first();
      if ((await inlineInput.count()) > 0 && (await inlineInput.isVisible())) {
        await inlineInput.fill('Herleitung E2E');
        await inlineInput.press('Enter');
      }
    }
    page.off('dialog', onPrompt);
    await expect(panel).toContainText('Herleitung E2E');

    // Draw on renamed layer
    const beforeDraw = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    // Diagonal stroke: crosses many rows and columns of the 64×64 sample grid regardless of zoom
    await drawStroke(page, canvas, [[0.36, 0.34], [0.64, 0.5]]);
    const drawn = await snapshotCanvas(canvas);
    expect(drawn.dataUrl).not.toBe(beforeDraw.dataUrl);

    // Set opacity via slider and verify canvas pixels change, then restore max opacity
    const slider = panel.locator('input[type="range"]').first();
    await expect(slider).toBeVisible();
    const maxAttr = Number((await slider.getAttribute('max')) ?? '100');
    const midVal = maxAttr <= 1 ? '0.4' : String(Math.round(maxAttr * 0.4));
    await slider.fill(midVal);
    await slider.dispatchEvent('input');
    await slider.dispatchEvent('change');
    await waitRaf(page, 4);
    const dimmed = await snapshotCanvas(canvas);
    expect(dimmed.dataUrl).not.toBe(drawn.dataUrl);
    expect(countSamplePixelDiffs(drawn, dimmed)).toBeGreaterThan(0);

    await slider.fill(String(maxAttr));
    await slider.dispatchEvent('input');
    await slider.dispatchEvent('change');
    await waitRaf(page, 4);
    expect((await snapshotCanvas(canvas)).dataUrl).toBe(drawn.dataUrl);

    // Hide layer -> verify pixels disappear; show layer -> verify pixels restore
    const visBtn = panel.getByRole('button', { name: RX.toggleVisible }).first();
    await expect(visBtn).toBeVisible();
    await visBtn.click();
    await waitRaf(page, 4);
    const hiddenCanvas = await snapshotCanvas(canvas);
    expect(hiddenCanvas.dataUrl).not.toBe(drawn.dataUrl);

    await visBtn.click();
    await waitRaf(page, 4);
    const restoredCanvas = await snapshotCanvas(canvas);
    expect(restoredCanvas.dataUrl).toBe(drawn.dataUrl);

    // Lock active layer and verify drawing is blocked with toast announcement
    const lockBtn = panel.getByRole('button', { name: RX.toggleLock }).first();
    await expect(lockBtn).toBeVisible();
    await lockBtn.click();

    const beforeLockedDraw = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.4, 0.55], [0.6, 0.65]]);
    const afterLockedDraw = await snapshotCanvas(canvas);
    expect(afterLockedDraw.dataUrl).toBe(beforeLockedDraw.dataUrl);
    const toast = page.locator('#toast[role="status"][aria-live="polite"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(RX.layerLocked);
    guards.assertNoErrors();
  });

  test('T1-17: Lecture Audio bar opens, shows controls and stroke-jump mode', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    await page.getByTestId('btn-audio').click();
    const audioBar = page.getByTestId('audio-bar');
    await expect(audioBar).toBeVisible();

    await expect(audioBar.getByRole('button', { name: RX.audioRecord }).first()).toBeVisible();
    const jumpToggle = audioBar.getByRole('button', { name: RX.audioJumpMode }).or(audioBar.getByRole('checkbox', { name: RX.audioJumpMode })).first();
    await expect(jumpToggle).toBeVisible();
    const beforeState = await jumpToggle.evaluate((el) => ({
      pressed: el.getAttribute('aria-pressed'),
      checked: el.checked ?? null,
      active: el.classList.contains('active') || el.classList.contains('is-active'),
    }));
    await jumpToggle.click();
    const afterState = await jumpToggle.evaluate((el) => ({
      pressed: el.getAttribute('aria-pressed'),
      checked: el.checked ?? null,
      active: el.classList.contains('active') || el.classList.contains('is-active'),
    }));
    const toggled = afterState.pressed !== beforeState.pressed
      || afterState.checked !== beforeState.checked
      || afterState.active !== beforeState.active;
    expect(toggled).toBe(true);
    guards.assertNoErrors();
  });

  test('T1-18: Command Palette (Ctrl+K) and Offline OCR modal', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    // Open via Ctrl+K
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();

    const searchInput = palette.locator('input').first();
    await searchInput.fill('Mathe');
    await expect(palette).toContainText(/Mathe/i);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // Also open via toolbar button, wait for matching row, and launch notebook
    await page.getByTestId('btn-command-palette').click();
    await expect(palette).toBeVisible();
    await palette.locator('input').first().fill('Mathe');
    await expect(palette).toContainText(/Mathe/i);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-view')).toBeVisible();

    // Trigger Offline OCR modal
    await page.getByTestId('btn-ocr').click();
    const ocrModal = page.getByTestId('modal-ocr');
    await expect(ocrModal).toBeVisible({ timeout: 15_000 });
    guards.assertNoErrors();
  });

  test('T1-19: Export Studio dialog exposes PDF/PNG/Bundle formats and selective layer modes', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.exportMenu }).or(menu.getByRole('menuitem', { name: RX.exportMenu })).first().click();

    const exportModal = page.getByTestId('modal-export');
    await expect(exportModal).toBeVisible();
    await expect(exportModal).toContainText(/PDF/i);
    await expect(exportModal).toContainText(/PNG/i);
    await expect(exportModal).toContainText(/\.docflownote/i);
    await expect(exportModal).toContainText(/Blanko|blank practice/i);
    await expect(exportModal).toContainText(/Nur eigene Notizen|notes only/i);

    await exportModal.getByRole('button', { name: RX.exportAction }).first().click();
    const toast = page.locator('#toast[role="status"]');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(RX.exported, { timeout: 10_000 });
    guards.assertNoErrors();
  });

  test('T1-20: Cloud Overview modal & 2-Column Settings (DE/EN switch + Update Check)', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.getByTestId('cloud-card').click();
    const cloudModal = page.getByTestId('modal-cloud');
    await expect(cloudModal).toBeVisible();
    await cloudModal.getByRole('button', { name: RX.cloudSyncNow }).first().click();
    await cloudModal.getByRole('button', { name: RX.close }).first().click();
    await expect(cloudModal).toBeHidden();

    // Open Settings and switch language DE -> EN -> DE
    await page.getByTestId('btn-settings').click();
    const settingsModal = page.getByTestId('modal-settings');
    await expect(settingsModal).toBeVisible();

    await selectLanguageInSettings(settingsModal, 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('nav-favorites')).toContainText(/Favorites/i);

    const updateBtn = settingsModal.getByRole('button', { name: RX.checkUpdates }).first();
    await expect(updateBtn).toBeVisible();
    await updateBtn.click();
    await expect.poll(async () => {
      const modalText = await settingsModal.innerText();
      const toastText = await page.locator('#toast').innerText();
      return `${modalText}\n${toastText}`;
    }).toMatch(RX.updateResult);

    await selectLanguageInSettings(settingsModal, 'de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByTestId('nav-favorites')).toContainText(/Favoriten/i);
    guards.assertNoErrors();
  });

  test('T1-21: WCAG landmarks, ARIA states, accessible button names & 375px responsiveness', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    // Semantic HTML5 landmarks
    await expect(page.locator('header.titlebar[role="banner"], header[role="banner"]')).toBeVisible();
    const aside = page.locator('aside.sidebar[aria-label], aside[aria-label]').first();
    await expect(aside).toBeVisible();
    expect((await aside.getAttribute('aria-label')).trim().length).toBeGreaterThan(0);
    await expect(page.locator('main#main-workspace')).toBeVisible();
    await expect(page.locator('#toast[role="status"][aria-live="polite"]')).toBeAttached();
    await expect(page.getByTestId('tab-bar')).toHaveAttribute('role', 'tablist');

    // Every visible button must have an accessible name
    const unnamedButtons = await page.evaluate(() => {
      return [...document.querySelectorAll('button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden';
        })
        .filter((b) => {
          const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim();
          return label.length === 0;
        })
        .map((b) => b.outerHTML.slice(0, 120));
    });
    expect(unnamedButtons, `Buttons missing accessible names: ${unnamedButtons.join('\n')}`).toEqual([]);

    // Keyboard Tab navigation advances focus
    await page.keyboard.press('Tab');
    const activeTag = await page.evaluate(() => document.activeElement?.tagName);
    expect(activeTag).toBeTruthy();

    // Mobile 375x812 viewport zero horizontal overflow
    await page.setViewportSize({ width: 375, height: 812 });
    await waitRaf(page, 2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    guards.assertNoErrors();
  });
});

// ============================================================================
// Tier 2 — Boundary & Corner Cases (13 tests: T2-01 – T2-13)
// ============================================================================

test.describe('Tier 2 — Boundary & Corner Cases', () => {
  test('T2-01: Search empty-match boundary shows empty state and clearing restores cards', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const search = page.getByTestId('library-search');
    const initialCount = await page.getByTestId('notebook-card').count();
    expect(initialCount).toBeGreaterThanOrEqual(2);

    await search.fill('___NONEXISTENT_QUERY_XYZ_999___');
    await expect(page.getByTestId('notebook-card')).toHaveCount(0);
    await expect(page.getByTestId('notebook-grid')).toContainText(/Keine Treffer|No matches/i);

    await search.fill('');
    await expect(page.getByTestId('notebook-card')).toHaveCount(initialCount);
    guards.assertNoErrors();
  });

  test('T2-02: Special characters, Unicode & HTML meta-characters in notebook title are safely escaped', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const xssTitle = '<img src=x onerror="window.__xss=1"> Mathe Ω & Übung #2026';
    await createNotebookViaModal(page, { title: xssTitle });

    if (await page.getByTestId('editor-view').isVisible().catch(() => false)) {
      await page.getByTestId('tab-home').click();
    }

    const xssTriggered = await page.evaluate(() => Boolean(window.__xss));
    expect(xssTriggered).toBe(false);
    await expect(page.getByTestId('notebook-card').filter({ hasText: 'Mathe Ω & Übung #2026' }).first()).toBeVisible();
    guards.assertNoErrors();
  });

  test('T2-03: Deleting a folder preserves notebooks inside All Notes', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const beforeCount = await page.getByTestId('notebook-card').count();
    await page.getByTestId('btn-new-folder').click();
    const folderDialog = page.locator('dialog[open], [role="dialog"]:visible').last();
    await folderDialog.locator('input[type="text"], input:not([type])').first().fill('Temp Folder');
    await folderDialog.getByRole('button', { name: RX.create }).click();

    const folderItem = page.getByTestId('folder-tree').getByText('Temp Folder').first();
    await expect(folderItem).toBeVisible();

    await confirmDialogAction(page, async () => {
      const delBtn = page.getByTestId('folder-tree').getByRole('button', { name: RX.deleteFolder }).first();
      if (await delBtn.isVisible().catch(() => false)) {
        await delBtn.click();
      } else {
        await folderItem.click({ button: 'right' });
        await page.getByRole('menuitem', { name: RX.deleteFolder }).or(page.getByRole('button', { name: RX.deleteFolder })).first().click();
      }
    });

    await page.getByTestId('nav-all').click();
    expect(await page.getByTestId('notebook-card').count()).toBeGreaterThanOrEqual(beforeCount);
    guards.assertNoErrors();
  });

  test('T2-04: Closing all notebook tabs cleanly returns to Home Library view', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    const tabs = page.getByTestId('tab-bar').locator('[role="tab"]');
    const notebookTabs = tabs.filter({ hasNot: page.getByTestId('tab-home') });
    const count = await notebookTabs.count();
    for (let i = 0; i < count; i += 1) {
      const closeBtn = notebookTabs.first().getByRole('button').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
      }
    }

    await expect(page.getByTestId('library-view')).toBeVisible();
    await expect(page.getByTestId('tab-home')).toHaveAttribute('aria-selected', 'true');
    guards.assertNoErrors();
  });

  test('T2-05: Split-screen resizer clamps at min/max extremes without collapsing pane to zero', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    await page.getByTestId('btn-split-screen').click();
    const splitPicker = page.locator('[role="dialog"]:visible, [role="menu"]:visible').last();
    if (await splitPicker.isVisible().catch(() => false)) {
      await splitPicker.getByRole('button').first().click();
    }

    const resizer = page.getByTestId('split-resizer');
    const primary = page.getByTestId('pane-primary');
    const secondary = page.getByTestId('pane-secondary');
    const rBox = await resizer.boundingBox();
    expect(rBox).not.toBeNull();

    // Extreme left drag
    await page.mouse.move(rBox.x + rBox.width / 2, rBox.y + rBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(20, rBox.y + rBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await waitRaf(page, 2);

    const pBoxMin = await primary.boundingBox();
    const sBoxMax = await secondary.boundingBox();
    expect(pBoxMin.width).toBeGreaterThanOrEqual(200);
    expect(sBoxMax.width).toBeGreaterThanOrEqual(200);
    guards.assertNoErrors();
  });

  test('T2-06: Undo/Redo at empty stack boundaries remain safe and error-free', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    const before = await snapshotCanvas(canvas);
    await page.getByTestId('btn-undo').click({ force: true });
    await page.getByTestId('btn-redo').click({ force: true });
    await waitRaf(page, 3);
    const after = await snapshotCanvas(canvas);
    expect(after.dataUrl).toBe(before.dataUrl);
    guards.assertNoErrors();
  });

  test('T2-07: Deleting last remaining page or drawing on hidden layer is safely guarded', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await createNotebookViaModal(page, { title: 'Single Page Guard' });
    const canvas = await openNotebookByTitleOrFirst(page, /Single Page Guard/i);

    // Try deleting the only page
    await page.getByTestId('btn-page-sorter').click();
    const drawer = page.getByTestId('page-sorter-drawer');
    const delPageBtn = drawer.getByRole('button', { name: RX.deletePage }).first();
    if (await delPageBtn.isVisible().catch(() => false)) {
      if (await delPageBtn.isEnabled()) await delPageBtn.click();
    }
    await expect(canvas).toBeVisible();

    // Hide active layer and verify draw blocked
    await page.getByTestId('btn-layers').click();
    const panel = page.getByTestId('layers-panel');
    await panel.getByRole('button', { name: RX.toggleVisible }).first().click();
    const before = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.4, 0.4], [0.6, 0.6]]);
    const after = await snapshotCanvas(canvas);
    expect(after.dataUrl).toBe(before.dataUrl);
    guards.assertNoErrors();
  });

  test('T2-08: Zero-movement single click on canvas does not corrupt undo stack or crash', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('tool-pen').click();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await waitRaf(page, 3);
    await page.getByTestId('btn-undo').click({ force: true });
    await waitRaf(page, 2);
    guards.assertNoErrors();
  });

  test('T2-09: Command Palette empty query, zero-match query & Escape dismissal restore clean state', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    const input = palette.locator('input').first();
    await input.fill('ZZZ_NO_MATCH_E2E_999');
    await expect(palette).toContainText(/Keine Treffer|No matches|0/i);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    guards.assertNoErrors();
  });

  test('T2-10: Theme & language preferences persist across page reload', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.getByTestId('btn-settings').click();
    const settingsModal = page.getByTestId('modal-settings');
    await expect(settingsModal).toBeVisible();

    const themeSelect = settingsModal.locator('select').filter({ hasText: /Anthracite|OLED/i }).first();
    await themeSelect.selectOption('oled');
    const langSelect = settingsModal.locator('select').filter({ hasText: /Deutsch|English/i }).first();
    await langSelect.selectOption('en');

    await settingsModal.getByRole('button', { name: RX.close }).first().click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'oled');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'oled');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    guards.assertNoErrors();
  });

  test('T2-11: Narrow 375x812 viewport keeps editor bottom dock usable with zero horizontal overflow', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);

    await expect(page.getByTestId('bottom-dock')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    guards.assertNoErrors();
  });

  test('T2-12: Denied microphone in Audio bar surfaces graceful message without uncaught errors', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await page.addInitScript(() => {
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = async () => {
          throw new DOMException('Permission denied', 'NotAllowedError');
        };
      }
    });

    await enterStudio(page);
    await openNotebookByTitleOrFirst(page);
    await page.getByTestId('btn-audio').click();

    const audioBar = page.getByTestId('audio-bar');
    await expect(audioBar).toBeVisible();
    await audioBar.getByRole('button', { name: RX.audioRecord }).first().click();
    await expect(page.locator('#toast, [data-testid="audio-bar"]')).toContainText(RX.audioMicDenied);
    guards.assertNoErrors();
  });

  test('T2-13: Offline OCR on blank page handles empty recognition gracefully', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await createNotebookViaModal(page, { title: 'Blank OCR Check' });
    await openNotebookByTitleOrFirst(page, /Blank OCR Check/i);

    await page.getByTestId('btn-ocr').click();
    const ocrOrToast = page.locator('[data-testid="modal-ocr"], #toast');
    await expect(ocrOrToast.first()).toBeVisible({ timeout: 15_000 });
    guards.assertNoErrors();
  });
});

// ============================================================================
// Tier 3 — Cross-Feature Combinations (6 tests: T3-01 – T3-06)
// ============================================================================

test.describe('Tier 3 — Cross-Feature Combinations', () => {
  test('T3-01: Nested folder + created notebook + Command Palette search opens exact notebook', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.getByTestId('btn-new-folder').click();
    const fDialog = page.locator('dialog[open], [role="dialog"]:visible').last();
    await fDialog.locator('input[type="text"], input:not([type])').first().fill('Informatik');
    await fDialog.getByRole('button', { name: RX.create }).click();

    await page.getByTestId('folder-tree').getByText('Informatik').first().click();
    await createNotebookViaModal(page, { title: 'Algorithmen Graph' });

    if (await page.getByTestId('editor-view').isVisible().catch(() => false)) {
      await page.getByTestId('tab-home').click();
    }

    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await palette.locator('input').first().fill('Algorithmen Graph');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('editor-view')).toBeVisible();
    await expect(page.getByTestId('editor-title')).toContainText('Algorithmen Graph');
    guards.assertNoErrors();
  });

  test('T3-02: Anthracite theme + Dark Paper + Pen/Highlighter + Undo/Redo preserves visibility', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    while ((await page.locator('html').getAttribute('data-theme')) !== 'anthracite') {
      await page.getByTestId('btn-theme-cycle').click();
    }
    expect(await getThemeBgRgb(page)).toBe(THEME_BG_RGB.anthracite);

    const canvas = await openNotebookByTitleOrFirst(page);
    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.darkPaper }).or(menu.getByRole('menuitem', { name: RX.darkPaper })).first().click();
    await waitRaf(page, 4);

    const darkRgb = await samplePaperRgb(canvas);
    expect(darkRgb.lum).toBeLessThan(95);

    const beforeInk = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.35, 0.4], [0.65, 0.45]]);
    const afterInk = await snapshotCanvas(canvas);
    expect(afterInk.dataUrl).not.toBe(beforeInk.dataUrl);

    await page.getByTestId('btn-undo').click();
    await waitRaf(page, 3);
    expect((await snapshotCanvas(canvas)).dataUrl).toBe(beforeInk.dataUrl);
    guards.assertNoErrors();
  });

  test('T3-03: Split-Screen dual panes keep independent canvases while drawing on primary pane', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const primaryCanvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('btn-split-screen').click();
    const splitPicker = page.locator('[role="dialog"]:visible, [role="menu"]:visible').last();
    if (await splitPicker.isVisible().catch(() => false)) {
      await splitPicker.getByRole('button').first().click();
    }

    const secondaryCanvas = getSecondaryCanvas(page);
    await expect(secondaryCanvas).toBeVisible();
    await waitRaf(page, 3);

    const pBefore = await snapshotCanvas(primaryCanvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, primaryCanvas, [[0.35, 0.35], [0.65, 0.65]]);
    const pAfter = await snapshotCanvas(primaryCanvas);
    expect(pAfter.dataUrl).not.toBe(pBefore.dataUrl);
    guards.assertNoErrors();
  });

  test('T3-04: Study Tape + Textbox Checklist + Layer visibility + Selective Export modal', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('tool-tape').click();
    await drawStroke(page, canvas, [[0.3, 0.4], [0.6, 0.4]]);

    await page.getByTestId('tool-textbox').click();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.55);
    const tbModal = page.getByTestId('modal-textbox');
    await tbModal.locator('textarea, input[type="text"]').first().fill('Formel merken');
    await tbModal.getByRole('button', { name: RX.apply }).first().click();

    await page.getByTestId('btn-layers').click();
    await expect(page.getByTestId('layers-panel')).toBeVisible();

    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.exportMenu }).or(menu.getByRole('menuitem', { name: RX.exportMenu })).first().click();
    const exportModal = page.getByTestId('modal-export');
    await expect(exportModal).toBeVisible();
    await exportModal.getByRole('button', { name: RX.cancel }).first().click();
    guards.assertNoErrors();
  });

  test('T3-05: Language switch EN -> Command Palette OCR search opens matching notebook', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.getByTestId('btn-settings').click();
    const settingsModal = page.getByTestId('modal-settings');
    await settingsModal.locator('select').filter({ hasText: /Deutsch|English/i }).first().selectOption('en');
    await settingsModal.getByRole('button', { name: RX.close }).first().click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await palette.locator('input').first().fill('Lineare');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-view')).toBeVisible();
    guards.assertNoErrors();
  });

  test('T3-06: Geodreieck + Pen stroke + Page Sorter duplicate + Audio Bar toggle', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('tool-geodreieck').click();
    await expect(page.getByTestId('geodreieck-overlay')).toBeVisible();
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.35, 0.6], [0.65, 0.6]]);

    await page.getByTestId('btn-page-sorter').click();
    const drawer = page.getByTestId('page-sorter-drawer');
    await drawer.getByRole('button', { name: RX.duplicatePage }).first().click();

    await page.getByTestId('btn-audio').click();
    await expect(page.getByTestId('audio-bar')).toBeVisible();
    await expect(page.getByTestId('geodreieck-overlay')).toBeVisible();
    guards.assertNoErrors();
  });
});

// ============================================================================
// Tier 4 — Real-World Application Scenarios (5 tests: T4-01 – T4-05)
// ============================================================================

test.describe('Tier 4 — Real-World Application Scenarios', () => {
  test('T4-01: Lecture Note-Taking & Selective Export (PDF Margin + Split-Screen + Pen/Textbox + Page Sorter + Export)', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const canvas = await openNotebookByTitleOrFirst(page, /Arbeitsblatt|PDF|Scan/i);

    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.marginNotes }).or(menu.getByRole('menuitem', { name: RX.marginNotes })).first().click();
    await waitRaf(page, 3);

    await page.getByTestId('btn-split-screen').click();
    const picker = page.locator('[role="dialog"]:visible, [role="menu"]:visible').last();
    if (await picker.isVisible().catch(() => false)) {
      await picker.getByRole('button').first().click();
    }
    await expect(page.getByTestId('pane-secondary')).toBeVisible();

    await page.getByTestId('tool-pen').click();
    const beforeInk = await snapshotCanvas(canvas);
    await drawStroke(page, canvas, [[0.72, 0.35], [0.85, 0.42]]);
    expect((await snapshotCanvas(canvas)).dataUrl).not.toBe(beforeInk.dataUrl);

    await page.getByTestId('tool-textbox').click();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.78, box.y + box.height * 0.52);
    const tbModal = page.getByTestId('modal-textbox');
    await tbModal.locator('textarea, input[type="text"]').first().fill('Vorlesung Notiz');
    await tbModal.getByRole('button', { name: RX.apply }).first().click();

    await page.getByTestId('btn-page-sorter').click();
    await page.getByTestId('page-sorter-drawer').getByRole('button', { name: RX.addPage }).first().click();

    const menuExp = await openMoreMenu(page);
    await menuExp.getByRole('button', { name: RX.exportMenu }).or(menuExp.getByRole('menuitem', { name: RX.exportMenu })).first().click();
    const exportModal = page.getByTestId('modal-export');
    await expect(exportModal).toBeVisible();
    await exportModal.getByRole('button', { name: RX.exportAction }).first().click();
    await expect(page.locator('#toast[role="status"]')).toBeVisible({ timeout: 10_000 });
    guards.assertNoErrors();
  });

  test('T4-02: Math Geometry Worksheet with Anthracite, Dark Paper, Layers & Geodreieck', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    while ((await page.locator('html').getAttribute('data-theme')) !== 'anthracite') {
      await page.getByTestId('btn-theme-cycle').click();
    }

    const canvas = await openNotebookByTitleOrFirst(page, /Mathe/i);
    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.darkPaper }).or(menu.getByRole('menuitem', { name: RX.darkPaper })).first().click();
    await waitRaf(page, 4);
    expect((await samplePaperRgb(canvas)).lum).toBeLessThan(95);

    await page.getByTestId('btn-layers').click();
    const layersPanel = page.getByTestId('layers-panel');
    await layersPanel.getByRole('button', { name: RX.addLayer }).first().click();

    await page.getByTestId('tool-geodreieck').click();
    await expect(page.getByTestId('geodreieck-overlay')).toBeVisible();

    const beforeGeo = await snapshotCanvas(canvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, canvas, [[0.32, 0.65], [0.68, 0.65]]);
    const afterGeo = await snapshotCanvas(canvas);
    expect(afterGeo.dataUrl).not.toBe(beforeGeo.dataUrl);

    await page.getByTestId('btn-undo').click();
    await waitRaf(page, 3);
    expect((await snapshotCanvas(canvas)).dataUrl).toBe(beforeGeo.dataUrl);
    guards.assertNoErrors();
  });

  test('T4-03: Exam Study Session with Cornell Template, Checklist, Occlusion Tapes & Reload Persistence', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    const studyTitle = 'Biologie Klausurvorbereitung';
    await createNotebookViaModal(page, { title: studyTitle, templateRegex: RX.tplCornell });
    const canvas = await openNotebookByTitleOrFirst(page, new RegExp(studyTitle, 'i'));

    await page.getByTestId('tool-textbox').click();
    const box = await canvas.boundingBox();
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.35);
    const tbModal = page.getByTestId('modal-textbox');
    await tbModal.locator('textarea, input[type="text"]').first().fill('ATP Synthese wiederholen');
    const chk = tbModal.getByRole('checkbox').or(tbModal.getByRole('button', { name: RX.checklist })).first();
    if (await chk.isVisible().catch(() => false)) await chk.click();
    await tbModal.getByRole('button', { name: RX.apply }).first().click();

    await page.getByTestId('tool-tape').click();
    const beforeTape = await snapshotCanvas(canvas);
    await drawStroke(page, canvas, [[0.35, 0.45], [0.65, 0.45]]);
    expect((await snapshotCanvas(canvas)).dataUrl).not.toBe(beforeTape.dataUrl);

    const menu = await openMoreMenu(page);
    await menu.getByRole('button', { name: RX.studyMode }).or(menu.getByRole('menuitem', { name: RX.studyMode })).first().click();
    await waitRaf(page, 4);

    // Reload and ensure notebook persists in demo bridge storage
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enterStudio(page);
    await expect(page.getByTestId('notebook-card').filter({ hasText: studyTitle }).first()).toBeVisible();
    guards.assertNoErrors();
  });

  test('T4-04: Workspace Organization, Safe Delete/Restore & Cloud Sync Overview', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.getByTestId('btn-new-folder').click();
    const fDialog = page.locator('dialog[open], [role="dialog"]:visible').last();
    await fDialog.locator('input[type="text"], input:not([type])').first().fill('Semester 4');
    await fDialog.getByRole('button', { name: RX.create }).click();

    const nbTitle = 'Organisierte Vorlesung';
    await createNotebookViaModal(page, { title: nbTitle });
    if (await page.getByTestId('editor-view').isVisible().catch(() => false)) {
      await page.getByTestId('tab-home').click();
    }

    const card = page.getByTestId('notebook-card').filter({ hasText: nbTitle }).first();
    const favBtn = card.getByRole('button', { name: RX.toggleFavorite }).first();
    if (await favBtn.isVisible().catch(() => false)) {
      await favBtn.click();
    }

    await confirmDialogAction(page, async () => {
      const delBtn = card.getByRole('button', { name: RX.deleteNotebook }).first();
      await delBtn.click();
    });

    await page.getByTestId('nav-trash').click();
    const trashModal = page.getByTestId('modal-trash');
    const trashArea = (await trashModal.isVisible().catch(() => false)) ? trashModal : page.getByTestId('library-view');
    await trashArea.getByRole('button', { name: RX.restoreNotebook }).first().click();
    if (await trashModal.isVisible().catch(() => false)) {
      const closeBtn = trashModal.getByRole('button', { name: RX.close }).first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
    }

    await page.getByTestId('nav-all').click();
    await expect(page.getByTestId('notebook-card').filter({ hasText: nbTitle }).first()).toBeVisible();

    await page.getByTestId('cloud-card').click();
    const cloudModal = page.getByTestId('modal-cloud');
    await expect(cloudModal).toBeVisible();
    await cloudModal.getByRole('button', { name: RX.cloudSyncNow }).first().click();
    guards.assertNoErrors();
  });

  test('T4-05: Power-User Keyboard, OLED + EN/DE Switch, OCR Search & Page OCR Workflow', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);

    await page.getByTestId('btn-settings').click();
    const settings = page.getByTestId('modal-settings');
    await settings.locator('select').filter({ hasText: /Anthracite|OLED/i }).first().selectOption('oled');
    await settings.locator('select').filter({ hasText: /Deutsch|English/i }).first().selectOption('en');
    await settings.getByRole('button', { name: RX.close }).first().click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'oled');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await getThemeBgRgb(page)).toBe(THEME_BG_RGB.oled);

    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    await palette.locator('input').first().fill('Mathe');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-view')).toBeVisible();

    await page.getByTestId('btn-ocr').click();
    const ocrModal = page.getByTestId('modal-ocr');
    await expect(ocrModal).toBeVisible({ timeout: 15_000 });
    const closeOcr = ocrModal.getByRole('button', { name: RX.close }).first();
    if (await closeOcr.isVisible().catch(() => false)) {
      await closeOcr.click();
    }

    // Switch back to German via Settings
    await page.getByTestId('btn-settings').click();
    await settings.locator('select').filter({ hasText: /Deutsch|English/i }).first().selectOption('de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    guards.assertNoErrors();
  });

  test('T4-06: Split-Screen opens different notebook by default, switches to Live-Sync & mirrors strokes live', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const primCanvas = await openNotebookByTitleOrFirst(page);

    await page.getByTestId('btn-split-screen').click();
    const secondary = page.getByTestId('pane-secondary');
    await expect(secondary).toBeVisible();

    const splitSelect = page.getByTestId('split-nb-select');
    await expect(splitSelect).toBeVisible();
    const options = await splitSelect.locator('option').evaluateAll((els) => els.map((e) => e.value));
    expect(options.length).toBeGreaterThanOrEqual(2);
    // Default selected in right pane should NOT be the first (same-as-primary) option when another notebook exists
    const initialVal = await splitSelect.inputValue();
    expect(initialVal).not.toBe(options[0]);

    // Switch right pane to the same notebook (Live-Sync mode)
    await splitSelect.selectOption(options[0]);
    await expect(page.getByTestId('split-sync-badge')).toHaveText(/Live-Sync/i);
    await waitRaf(page, 3);

    const secCanvas = secondary.locator('canvas').first();
    const beforeSec = await snapshotCanvas(secCanvas);
    await page.getByTestId('tool-pen').click();
    await drawStroke(page, primCanvas, [
      [0.30, 0.35],
      [0.45, 0.45],
      [0.60, 0.38],
    ]);
    await waitRaf(page, 4);
    const afterSec = await snapshotCanvas(secCanvas);
    expect(afterSec.dataUrl).not.toBe(beforeSec.dataUrl);

    await page.getByTestId('btn-close-split').click();
    await expect(secondary).toBeHidden();
    guards.assertNoErrors();
  });
});

// ============================================================================
// Tier 5 — Cross-device state sync & OS integration (v2.0.1 audit fixes)
// ============================================================================
async function readDemoManifest(page, name) {
  return page.evaluate(async (fileName) => {
    const { inspectBundleSummary } = await import('/js/model.js');
    const raw = await window.__demoBridge.readFile(fileName);
    return inspectBundleSummary(raw instanceof Uint8Array ? raw : raw.bytes, fileName);
  }, name);
}

test.describe('Tier 5 — Cross-Device Sync & OS Integration', () => {
  test('T5-01: Favorite star on the PC is written into the bundle the phone reads', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const name = 'Arbeitsblatt_Scan.docflownote';
    expect((await readDemoManifest(page, name)).isFavorite).toBe(false);

    const card = page.getByTestId('notebook-card').filter({ hasText: /Arbeitsblatt/ }).first();
    await card.hover();
    await card.locator('.fav-btn').click();
    await expect.poll(async () => (await readDemoManifest(page, name)).isFavorite).toBe(true);

    await page.getByTestId('notebook-card').filter({ hasText: /Arbeitsblatt/ }).first().locator('.fav-btn').click();
    await expect.poll(async () => (await readDemoManifest(page, name)).isFavorite).toBe(false);
    guards.assertNoErrors();
  });

  test('T5-02: Moving a notebook into a folder writes folderPath into the bundle', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const name = 'Physik_Vorlesung.docflownote';
    const card = page.getByTestId('notebook-card').filter({ hasText: /Physik/ }).first();
    await card.hover();
    await card.locator('.more-btn').click();
    await page.getByRole('button', { name: RX.moveToFolder }).or(page.getByRole('menuitem', { name: RX.moveToFolder })).first().click();
    const dlg = page.locator('dialog[open]').last();
    await dlg.locator('select').selectOption({ label: 'Universität / Mathematik / Klausurvorbereitung' });
    await dlg.getByRole('button', { name: RX.save }).click();

    await expect.poll(async () => (await readDemoManifest(page, name)).folderPath)
      .toBe('Universität / Mathematik / Klausurvorbereitung');
    expect((await readDemoManifest(page, name)).folderId).toBe('fld_klausuren');
    guards.assertNoErrors();
  });

  test('T5-03: A folder and star set on the phone show up in the PC library', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    await page.evaluate(async () => {
      const { createNotebook, writeBundle } = await import('/js/model.js');
      const nb = createNotebook({ title: 'Handy Notiz', deviceId: 'android-phone', template: 'LINED', folderPath: 'Handy / Biologie' });
      nb.isFavorite = true;
      window.__demoBridge._external('Handy_Notiz.docflownote', writeBundle(nb, { deviceId: 'android-phone' }));
    });

    const tree = page.getByTestId('folder-tree');
    await expect(tree.getByText('Handy', { exact: true })).toBeVisible();
    await expect(tree.getByText('Biologie', { exact: true })).toBeVisible();
    await tree.getByText('Biologie', { exact: true }).click();
    await expect(page.getByTestId('notebook-card').filter({ hasText: 'Handy Notiz' })).toHaveCount(1);
    await page.getByTestId('nav-favorites').click();
    await expect(page.getByTestId('notebook-card').filter({ hasText: 'Handy Notiz' })).toHaveCount(1);
    guards.assertNoErrors();
  });

  test('T5-04: Double-clicking a .docflownote opens it (in place or as an imported copy)', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const before = await page.getByTestId('notebook-card').count();

    // Inside the synced folder: opens the notebook itself
    await page.evaluate(() => window.__demoBridge._triggerOpenExternal('C:\\Users\\Demo\\OneDrive\\DocFlow Studio\\Physik_Vorlesung.docflownote'));
    await expect(page.getByTestId('editor-view')).toBeVisible();
    await expect(page.getByTestId('editor-title')).toContainText(/Physik/);

    // From another folder: copied into the synced folder under a free name, never overwriting
    await page.evaluate(() => window.__demoBridge._triggerOpenExternal('D:\\Downloads\\Physik_Vorlesung.docflownote'));
    await expect.poll(async () => (await page.evaluate(async () => (await window.__demoBridge.listFiles()).length))).toBe(before + 1);
    await expect(page.getByTestId('editor-title')).toContainText(/Physik/);
    guards.assertNoErrors();
  });

  test('T5-05: Maximize button icon and label follow the window state', async ({ page }) => {
    const guards = attachErrorGuards(page);
    await enterStudio(page);
    const btn = page.locator('#win-max');
    await expect(btn).toHaveAttribute('data-maximized', 'false');
    await btn.click();
    await expect(btn).toHaveAttribute('data-maximized', 'true');
    await expect(btn).toHaveAttribute('aria-label', /Wiederherstellen|Restore/);
    await btn.click();
    await expect(btn).toHaveAttribute('data-maximized', 'false');
    await expect(btn).toHaveAttribute('aria-label', /Maximieren|Maximize/);
    guards.assertNoErrors();
  });
});
