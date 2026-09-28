/* ============================================================
   おでかけナビ「📸 みんなのおでかけ」専用フォーム — 共通ロジック
   ・画像は一切扱いません（保存もアップロードもしません）
   ・登録内容は Google Apps Script（SUBMIT_API_URL）経由で
     Googleスプレッドシートに自動で備蓄されます（初期状態は非公開）
   ・通信に失敗したときだけ、JSONのコピー/ダウンロードに切り替わります
   ============================================================ */

const ODEKAKE = (() => {

  /* ---------------------------------------------------------
     設定：既存の施設データ（おでかけナビ本体）の参照先。
     本番では、おでかけナビ本体が使っている施設JSONの
     公開URL（または同一リポジトリ内の相対パス）に書き換えてください。
     取得できない場合は同梱のサンプルデータで動作確認できます。
  --------------------------------------------------------- */
  const SPOTS_DATA_URLS = [
    './data/spots.json',        // このリポジトリに配置する本番用の施設データ（★ここに置いてください）
    './data/spots.sample.json'  // フォールバック（動作確認用サンプル）
  ];

  // 既存で公開済みの紹介者一覧（本体サイトに置かれる contributors.json）
  const CONTRIBUTORS_DATA_URLS = [
    './data/contributors.json',
    './data/contributors.sample.json'
  ];

  // 既存で公開済みの紹介投稿一覧（本体サイトに置かれる contributions.json）
  const CONTRIBUTIONS_DATA_URLS = [
    './data/contributions.json',
    './data/contributions.sample.json'
  ];

  /* ---------------------------------------------------------
     ★ 送信先：Google Apps Script のウェブアプリURL（…/exec で終わるもの）
     セットアップ手順（README_setup.md）の手順4で発行されたURLを貼り付けてください。
     空のままの場合は、従来どおりJSONのコピー/ダウンロード方式になります。
  --------------------------------------------------------- */
  const SUBMIT_API_URL = 'https://script.google.com/macros/s/AKfycbwoIFOD0jlu4LMael6Q_ofnCrbowA3Bs7ICJwjEQMkzp82_EMBRpjQWxoU_UOWza_TF/exec';

  const LS_KEYS = {
    draftContributor: 'odekake_mnO_draftContributor', // このブラウザで登録した「自分」の情報（次回以降の入力省略用）
    pendingContributions: 'odekake_mnO_pendingContributions', // まだ運営者に送っていない下書き
    adminDb: 'odekake_mnO_adminDb' // 管理画面が扱う「現在の全データ」
  };

  /* ---------------- 汎用 ---------------- */

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function todayISO() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, s => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
  }

  function readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeLS(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('localStorage への保存に失敗しました', e);
      return false;
    }
  }

  /* ---------------- バリデーション ---------------- */

  function isValidInstagramProfileUrl(url) {
    if (!url) return false;
    // https://www.instagram.com/xxxxx/ or instagram.com/xxxxx (英数・._-、末尾スラッシュ任意)
    return /^https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._-]+\/?(\?.*)?$/.test(url.trim());
  }

  function isValidInstagramPostUrl(url) {
    if (!url) return false;
    // https://www.instagram.com/p/xxxx/ または /reel/xxxx/
    return /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[a-zA-Z0-9_-]+\/?(\?.*)?$/.test(url.trim());
  }

  function extractInstagramUsername(url) {
    if (!url) return '';
    const m = url.trim().match(/instagram\.com\/([a-zA-Z0-9._]+)\/?/i);
    return m ? m[1] : '';
  }

  function normalizeUrl(url) {
    return (url || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  /* ---------------- 施設データ ---------------- */

  async function fetchFirstAvailable(urls) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) return { data, source: url };
        }
      } catch (e) { /* 次の候補へ */ }
    }
    return { data: [], source: null };
  }

  let _spotsCache = null;
  async function loadSpots() {
    if (_spotsCache) return _spotsCache;
    const { data, source } = await fetchFirstAvailable(SPOTS_DATA_URLS);
    // 既存施設データの想定フィールド: id, name, area / address, category
    // フィールド名が異なる場合はここで正規化してください。
    _spotsCache = {
      source,
      items: data.map((s, i) => ({
        // data/spots.json に id / spotId / spot_id が無い場合でも施設が弾かれないよう、
        // name（無ければ配列のインデックス）からIDを補って生成する
        id: s.id ?? s.spotId ?? s.spot_id ?? (s.name ? `spot_${s.name}` : `spot_${i}`),
        name: s.name ?? s.spotName ?? s.title ?? '(名称未設定)',
        area: s.area ?? s.address ?? s.category ?? ''
      })).filter(s => s.id)
    };
    return _spotsCache;
  }

  function searchSpots(items, keyword) {
    const kw = (keyword || '').trim().toLowerCase();
    if (!kw) return [];
    return items.filter(s =>
      (s.name && s.name.toLowerCase().includes(kw)) ||
      (s.area && s.area.toLowerCase().includes(kw))
    ).slice(0, 20);
  }

  /* ---------------- 紹介者データ（公開済み一覧） ---------------- */

  let _contributorsCache = null;
  async function loadPublishedContributors() {
    if (_contributorsCache) return _contributorsCache;
    const { data } = await fetchFirstAvailable(CONTRIBUTORS_DATA_URLS);
    _contributorsCache = (data || []).filter(c => c && c.displayName);
    return _contributorsCache;
  }

  function findContributorById(list, id) {
    if (!id) return null;
    return (list || []).find(c => c.id === id) || null;
  }

  function findContributorBySnsUrl(list, snsUrl) {
    const target = normalizeUrl(snsUrl);
    if (!target) return null;
    return (list || []).find(c => normalizeUrl(c.snsUrl) === target) || null;
  }

  let _contributionsCache = null;
  async function loadPublishedContributions() {
    if (_contributionsCache) return _contributionsCache;
    const { data } = await fetchFirstAvailable(CONTRIBUTIONS_DATA_URLS);
    _contributionsCache = data || [];
    return _contributionsCache;
  }

  /* ---------------- 管理用データベース（admin.html が使用） ---------------- */

  function getAdminDb() {
    return readLS(LS_KEYS.adminDb, { contributors: [], contributions: [] });
  }

  function setAdminDb(db) {
    return writeLS(LS_KEYS.adminDb, db);
  }

  /* ---------------- 完成版JSON生成 ---------------- */

  function buildContributorsJson(list) {
    return list.map(c => ({
      id: c.id,
      displayName: c.displayName,
      snsType: 'instagram',
      snsUrl: c.snsUrl,
      profileText: c.profileText || '',
      published: !!c.published
    }));
  }

  function buildContributionsJson(list) {
    return list.map(c => ({
      id: c.id,
      contributorId: c.contributorId,
      spotId: c.spotId,
      postUrl: c.postUrl,
      comment: c.comment || '',
      visitDate: c.visitDate || '',
      published: !!c.published
    }));
  }

  /* ---------------- サーバー（GAS）との通信 ---------------- */

  // 登録内容を送信する。成功時は { ok:true, contributorId, contributionId, isNewContributor } を返す。
  // ※ Content-Type を text/plain にしているのは、CORSのプリフライトを避けるため（GASの仕様）
  async function submitToServer(payload) {
    if (!SUBMIT_API_URL) throw new Error('送信先が設定されていません');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(SUBMIT_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('通信エラー（' + res.status + '）');
      const data = await res.json();
      if (!data || !data.ok) throw new Error((data && data.error) || '登録に失敗しました');
      return data;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('通信がタイムアウトしました');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // 公開済み（スプレッドシートで published=TRUE のもの）だけを取得する。
  // おでかけナビ本体から使う場合は  ODEKAKE.fetchPublicData()  で
  // { contributors: [...], contributions: [...] } が返ります。
  async function fetchPublicData() {
    if (!SUBMIT_API_URL) return { contributors: [], contributions: [] };
    const res = await fetch(SUBMIT_API_URL + '?action=public', { cache: 'no-store' });
    if (!res.ok) throw new Error('公開データの取得に失敗しました（' + res.status + '）');
    const data = await res.json();
    return {
      contributors: Array.isArray(data.contributors) ? data.contributors : [],
      contributions: Array.isArray(data.contributions) ? data.contributions : []
    };
  }

  function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      // フォールバック
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* noop */ }
      document.body.removeChild(ta);
      return true;
    }
  }

  return {
    LS_KEYS, uid, todayISO, escapeHtml, readLS, writeLS,
    isValidInstagramProfileUrl, isValidInstagramPostUrl,
    extractInstagramUsername, normalizeUrl,
    loadSpots, searchSpots, loadPublishedContributors, loadPublishedContributions,
    findContributorById, findContributorBySnsUrl,
    getAdminDb, setAdminDb,
    buildContributorsJson, buildContributionsJson,
    submitToServer, fetchPublicData,
    downloadJson, copyText
  };
})();
