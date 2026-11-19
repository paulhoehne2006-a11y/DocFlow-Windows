import { test } from 'node:test';
import assert from 'node:assert/strict';
import { de, en, setLanguage, getLanguage, getEffectiveLanguage, t, relativeTime } from '../src/js/i18n.js';

const COGNATE_ALLOWLIST = new Set([
  'appName',
  'ok',
  'tpl_CORNELL',
  'tool_FINELINER',
  'tool_LASSO',
  'transparent',
  'audioPause',
  'settingsSync',
  'themeSystem',
  'themeAnthracite',
  'themeLight',
  'langDe',
  'langEn',
  'sideAction_LASSO',
  'pageOf',
  'versionLabel',
]);

test('de and en dictionaries have 100% key and type parity', () => {
  const deKeys = Object.keys(de).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, deKeys);
  assert.ok(deKeys.length >= 290);

  for (const k of deKeys) {
    assert.equal(typeof en[k], typeof de[k], `Type mismatch for key "${k}"`);
    if (typeof de[k] === 'string') {
      assert.ok(de[k].trim().length > 0, `Empty de string for "${k}"`);
      assert.ok(en[k].trim().length > 0, `Empty en string for "${k}"`);
    } else if (typeof de[k] === 'function') {
      for (const arg of [0, 1, 3, 'Test']) {
        const deOut = de[k](arg, 5);
        const enOut = en[k](arg, 5);
        assert.equal(typeof deOut, 'string');
        assert.equal(typeof enOut, 'string');
        assert.ok(deOut.trim().length > 0, `Empty de fn output for "${k}"`);
        assert.ok(enOut.trim().length > 0, `Empty en fn output for "${k}"`);
      }
    }
  }
});

test('en dictionary has no accidental German fallbacks or German words', () => {
  const germanTokenRe = /\b(Ordner|Notizbuch|Notizbücher|Ebene|Ebenen|Papierkorb|Löschen|Speichern|Zurück|Schließen)\b/;
  for (const k of Object.keys(en)) {
    const sample = typeof en[k] === 'function' ? en[k](3, 5) : en[k];
    const deSample = typeof de[k] === 'function' ? de[k](3, 5) : de[k];
    if (!COGNATE_ALLOWLIST.has(k)) {
      assert.notEqual(sample, deSample, `en.${k} matches de.${k} unexpectedly`);
    }
    if (k !== 'langDe') {
      assert.equal(/[äöüß„]/i.test(sample), false, `German character found in en.${k}: ${sample}`);
      assert.equal(germanTokenRe.test(sample), false, `German word found in en.${k}: ${sample}`);
    }
  }
});

test('setLanguage, t(), and relativeTime() work across de, en, and auto', () => {
  const prev = getLanguage();
  try {
    setLanguage('en');
    assert.equal(getLanguage(), 'en');
    assert.equal(getEffectiveLanguage(), 'en');
    assert.equal(t('trashDaysLeft', 1), '1 day left');
    assert.equal(t('trashDaysLeft', 5), '5 days left');
    assert.equal(t('exportWithSolutions'), 'With solutions (all layers)');
    assert.equal(t('nonexistent_key_xyz'), 'nonexistent_key_xyz');

    setLanguage('de');
    assert.equal(getLanguage(), 'de');
    assert.equal(getEffectiveLanguage(), 'de');
    assert.equal(t('trashDaysLeft', 1), 'Noch 1 Tag');
    assert.equal(t('trashDaysLeft', 5), 'Noch 5 Tage');
    assert.equal(t('exportWithSolutions'), 'Mit Lösungen (alle Ebenen)');

    assert.equal(relativeTime(0), '—');
    assert.equal(relativeTime(Date.now() - 10_000), de.justNow);
    assert.equal(relativeTime(Date.now() - 5 * 60_000), de.minutesAgo(5));
    assert.equal(relativeTime(Date.now() - 2 * 3600_000), de.hoursAgo(2));
    assert.equal(relativeTime(Date.now() - 3 * 86400_000), de.daysAgo(3));

    const oldMs = Date.UTC(2025, 0, 15);
    const oldDe = relativeTime(oldMs);
    setLanguage('en');
    const oldEn = relativeTime(oldMs);
    assert.notEqual(oldDe, oldEn);

    setLanguage('auto');
    assert.equal(getLanguage(), 'auto');
    assert.ok(['de', 'en'].includes(getEffectiveLanguage()));
  } finally {
    setLanguage(prev);
  }
});
