/* ============================================================
   おでかけナビ「📸 みんなのおでかけ」— 受付・備蓄用 Google Apps Script

   ・フォームから届いた内容を、スプレッドシートに自動で1行追加します
   ・新規の投稿は必ず「非公開（published = FALSE）」で保存されます
   ・スプレッドシートの contributions シートで published のチェックを
     入れると公開、外すと非公開になります
   ・公開データは ?action=public などで JSON として取得できます
   ============================================================ */

const CONTRIBUTORS_SHEET = 'contributors';
const CONTRIBUTIONS_SHEET = 'contributions';

// 列の並び。列の順番を入れ替えても、見出し名で読み書きするので動きます
const CONTRIBUTOR_HEADERS = ['id', 'displayName', 'snsType', 'snsUrl', 'profileText', 'createdAt'];
const CONTRIBUTION_HEADERS = [
  'published', 'id', 'contributorId', 'contributorName',
  'spotId', 'spotName', 'spotArea', 'postUrl', 'comment', 'visitDate', 'createdAt'
];

const MAX_PER_MINUTE = 20;      // 全体で1分間に受け付ける件数の上限（いたずら対策）
const PUBLIC_CACHE_SECONDS = 60; // 公開データのキャッシュ秒数（チェック後、最大この秒数で反映）

const PROFILE_URL_RE = /^https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._-]+\/?(\?.*)?$/;
const POST_URL_RE = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[a-zA-Z0-9_-]+\/?(\?.*)?$/;

/* ============================================================
   最初に1回だけ実行：シートと見出し、書式を準備します
   ============================================================ */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  prepareSheet_(ss, CONTRIBUTORS_SHEET, CONTRIBUTOR_HEADERS);
  const sheet = prepareSheet_(ss, CONTRIBUTIONS_SHEET, CONTRIBUTION_HEADERS);
  sheet.setColumnWidth(1, 70);
  // 既定の「シート1」が空なら削除
  const def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 2) ss.deleteSheet(def);
  SpreadsheetApp.getUi().alert('準備ができました。次はウェブアプリとしてデプロイしてください。');
}

function prepareSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#fff3cd');
  sheet.setFrozenRows(1);
  // published 以外は「書式なしテキスト」にして、日付や数式への自動変換を防ぐ
  headers.forEach((h, i) => {
    if (h !== 'published') sheet.getRange(1, i + 1, sheet.getMaxRows(), 1).setNumberFormat('@');
  });
  return sheet;
}

/* ============================================================
   受付（フォーム → スプレッドシート）
   ============================================================ */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (err) {
    return json_({ ok: false, error: '混み合っています。しばらくしてからもう一度お試しください。' });
  }

  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return json_({ ok: false, error: 'データがありません。' });
    if (raw.length > 20000) return json_({ ok: false, error: 'データが大きすぎます。' });

    let body;
    try { body = JSON.parse(raw); } catch (err) { return json_({ ok: false, error: 'データの形式が正しくありません。' }); }

    if (!rateLimitOk_()) {
      return json_({ ok: false, error: '現在アクセスが集中しています。少し時間をおいてからお試しください。' });
    }

    const c = body.contributor || {};
    const item = body.contribution || {};

    // ---- 入力チェック（フォーム側と同じ条件を、サーバー側でも必ず確認する） ----
    const snsUrl = clean_(c.snsUrl, 200);
    const postUrl = clean_(item.postUrl, 300);
    const displayName = clean_(c.displayName, 30);
    const comment = clean_(item.comment, 300);
    const visitDate = clean_(item.visitDate, 10);
    const spotId = clean_(item.spotId, 120);
    const spotName = clean_(item.spotName, 120);
    const spotArea = clean_(item.spotArea, 120);

    if (!PROFILE_URL_RE.test(snsUrl)) return json_({ ok: false, error: 'Instagram URLの形式が正しくありません。' });
    if (!POST_URL_RE.test(postUrl)) return json_({ ok: false, error: '投稿URLの形式が正しくありません。' });
    if (!displayName) return json_({ ok: false, error: '表示名がありません。' });
    if (!spotId || !spotName) return json_({ ok: false, error: '施設が選ばれていません。' });
    if (visitDate && !/^\d{4}-\d{2}-\d{2}$/.test(visitDate)) return json_({ ok: false, error: '訪問日の形式が正しくありません。' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const cSheet = ss.getSheetByName(CONTRIBUTORS_SHEET);
    const nSheet = ss.getSheetByName(CONTRIBUTIONS_SHEET);
    if (!cSheet || !nSheet) return json_({ ok: false, error: 'サーバーの準備ができていません（setup未実行）。' });

    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss");

    // ---- 紹介者：同じInstagram URLの人がいれば、その人のIDを使う ----
    const contributors = readTable_(cSheet);
    const existing = contributors.find(r => normalizeUrl_(r.snsUrl) === normalizeUrl_(snsUrl));
    let contributorId;
    let isNewContributor = false;
    if (existing) {
      contributorId = existing.id;
    } else {
      const wanted = clean_(c.id, 80);
      const usable = /^creator_[A-Za-z0-9]+$/.test(wanted) && !contributors.some(r => r.id === wanted);
      contributorId = usable ? wanted : newId_('creator');
      isNewContributor = true;
    }

    // ---- 投稿：重複チェック ----
    const contributions = readTable_(nSheet);
    const wantedId = clean_(item.id, 80);
    const contributionId = /^contribution_[A-Za-z0-9]+$/.test(wantedId) ? wantedId : newId_('contribution');

    if (contributions.some(r => r.id === contributionId)) {
      // 通信が途中で切れて再送された場合など：すでに保存済みなので成功として返す
      return json_({ ok: true, duplicate: true, contributorId: contributorId, contributionId: contributionId, isNewContributor: false });
    }
    const samePost = contributions.some(r =>
      normalizeUrl_(r.postUrl) === normalizeUrl_(postUrl) && r.spotId === spotId);
    if (samePost) return json_({ ok: false, error: 'この投稿は、この施設ですでに登録されています。' });

    // ---- 書き込み（新規は必ず非公開） ----
    if (isNewContributor) {
      appendRow_(cSheet, CONTRIBUTOR_HEADERS, {
        id: contributorId, displayName: displayName, snsType: 'instagram',
        snsUrl: snsUrl, profileText: clean_(c.profileText, 300), createdAt: now
      });
    }
    appendRow_(nSheet, CONTRIBUTION_HEADERS, {
      published: false, id: contributionId, contributorId: contributorId,
      contributorName: existing ? existing.displayName : displayName,
      spotId: spotId, spotName: spotName, spotArea: spotArea,
      postUrl: postUrl, comment: comment, visitDate: visitDate, createdAt: now
    });

    CacheService.getScriptCache().remove('public');
    return json_({ ok: true, contributorId: contributorId, contributionId: contributionId, isNewContributor: isNewContributor });

  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'サーバーでエラーが発生しました。' });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   公開データの配信（published がチェックされたものだけ）
     ?action=public         → { contributors: [...], contributions: [...] }
     ?action=contributors   → [...]  （従来の contributors.json と同じ形）
     ?action=contributions  → [...]  （従来の contributions.json と同じ形）
   ============================================================ */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'public';
  const data = getPublicData_();
  if (action === 'public') return json_(data);
  if (action === 'contributors') return json_(data.contributors);
  if (action === 'contributions') return json_(data.contributions);
  return json_({ ok: false, error: 'unknown action' });
}

function getPublicData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('public');
  if (hit) {
    try { return JSON.parse(hit); } catch (err) { /* 再生成 */ }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cRows = readTable_(ss.getSheetByName(CONTRIBUTORS_SHEET));
  const nRows = readTable_(ss.getSheetByName(CONTRIBUTIONS_SHEET));

  const contributions = nRows.filter(r => isTrue_(r.published)).map(r => ({
    id: r.id,
    contributorId: r.contributorId,
    spotId: r.spotId,
    postUrl: r.postUrl,
    comment: r.comment || '',
    visitDate: r.visitDate || '',
    published: true
  }));

  // 公開投稿が1件以上ある紹介者だけを公開する（紹介者側の操作は不要）
  const activeIds = {};
  contributions.forEach(n => { activeIds[n.contributorId] = true; });
  const contributors = cRows.filter(r => activeIds[r.id]).map(r => ({
    id: r.id,
    displayName: r.displayName,
    snsType: 'instagram',
    snsUrl: r.snsUrl,
    profileText: r.profileText || '',
    published: true
  }));

  const result = { contributors: contributors, contributions: contributions };
  try { cache.put('public', JSON.stringify(result), PUBLIC_CACHE_SECONDS); } catch (err) { /* 大きすぎる場合はキャッシュしない */ }
  return result;
}

/* ============================================================
   ユーティリティ
   ============================================================ */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function readTable_(sheet) {
  if (!sheet) return [];
  const last = sheet.getLastRow();
  const cols = sheet.getLastColumn();
  if (last < 2 || cols < 1) return [];
  const values = sheet.getRange(1, 1, last, cols).getValues();
  const headers = values[0].map(h => String(h).trim());
  const tz = Session.getScriptTimeZone();
  return values.slice(1)
    .filter(row => row.some(v => v !== '' && v !== false))
    .map(row => {
      const o = {};
      headers.forEach((h, i) => {
        let v = row[i];
        if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        o[h] = v;
      });
      return o;
    });
}

function appendRow_(sheet, headerNames, obj) {
  const sheetHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const row = sheetHeaders.map(h => (obj[h] === undefined ? '' : obj[h]));
  const rowIndex = sheet.getLastRow() + 1;
  sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  const pubCol = sheetHeaders.indexOf('published');
  if (pubCol >= 0) {
    // 公開チェックボックスを付ける（最初は必ず未チェック＝非公開）
    sheet.getRange(rowIndex, pubCol + 1).insertCheckboxes().setValue(false);
  }
}

function clean_(v, max) {
  let s = String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

function normalizeUrl_(url) {
  return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
}

function isTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function newId_(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 全体で1分間に受け付ける件数を制限する
function rateLimitOk_() {
  const cache = CacheService.getScriptCache();
  const key = 'rate_' + Math.floor(Date.now() / 60000);
  const n = Number(cache.get(key) || 0);
  if (n >= MAX_PER_MINUTE) return false;
  cache.put(key, String(n + 1), 120);
  return true;
}
