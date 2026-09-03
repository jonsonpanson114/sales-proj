/**
 * 営業参謀 Pro ―― データ保管サーバー (Google Apps Script)
 *
 * これ1本で次の2つをまかなう。
 *   1. 端末間の同期  … スマホとパソコンで同じ内容を見るための保管場所
 *   2. 記録の書き出し … 朝の作戦・夜の報告・知識の倉庫をGoogleドライブにファイルとして残す
 *
 * データはすべて、このスクリプトを動かしているあなた自身のGoogleドライブにだけ保存される。
 *
 * ===========================================================
 *  やること（この下の1行を書き換えるだけ）
 * ===========================================================
 */

// ▼▼▼ ここだけ書き換える ▼▼▼
// アプリの「システム設定 → 端末間の同期 →【合言葉を作る】」で作った文字列を、
// 下のクォート('')の中に貼り付ける。クォートは消さないこと。
var SYNC_TOKEN = 'PASTE_YOUR_PASSPHRASE_HERE';
// ▲▲▲ ここだけ書き換える ▲▲▲

/**
 * ===========================================================
 *  続きの手順
 * ===========================================================
 *  1. 上の SYNC_TOKEN を貼り替えて保存（Ctrl+S / ⌘+S）
 *  2. 上部の関数選択で setup を選び「実行」→ 権限を承認する
 *       「このアプリは確認されていません」→「詳細」→「(プロジェクト名)に移動」→「許可」
 *  3. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行 : 自分
 *       アクセスできるユーザー : 全員
 *  4. 出てきた https://script.google.com/macros/s/..../exec をコピー
 *  5. アプリの「システム設定 → 端末間の同期」にURLを貼って【保存】
 *
 *  ※「全員」でも、合言葉を知らない相手にはデータを一切返さない。
 *    ただしURLと合言葉をセットで人に渡さないこと。
 */

var FILE_NAME = 'sales-atelier-state.json';
var BACKUP_PREFIX = 'sales-atelier-state.backup-';
var BACKUP_KEEP_DAYS = 14;
var ROOT_FOLDER_NAME = '営業参謀Pro';
var API_VERSION = 2;

/* ================================================================== */
/* 入り口                                                              */
/* ================================================================== */

/** 読み出し (GET) */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};

    // 疎通確認。合言葉が合っているかどうかだけを返し、データは返さない。
    if (p.action === 'ping') {
      return json({
        ok: true,
        pong: true,
        version: API_VERSION,
        authorized: matchesToken_(p.token),
        tokenConfigured: isTokenConfigured_()
      });
    }

    if (!isAuthorized_(p.token)) return json(authError_());

    if (p.action === 'load') {
      var file = findFile_(FILE_NAME);
      if (!file) return json({ ok: true, exists: false, updatedAt: 0, state: null });
      var payload = readJson_(file);
      if (!payload) return json({ ok: true, exists: false, updatedAt: 0, state: null });
      return json({
        ok: true,
        exists: true,
        updatedAt: payload.updatedAt || 0,
        deviceName: payload.deviceName || '',
        state: payload.state || null
      });
    }

    return json({ ok: false, error: 'UNKNOWN_ACTION' });
  } catch (err) {
    return json({ ok: false, error: 'EXCEPTION', message: String(err) });
  }
}

/**
 * 書き込み (POST)
 * Content-Type は text/plain で送ること。
 * application/json にするとブラウザがプリフライト(OPTIONS)を投げ、GASが応答できず必ず失敗する。
 */
function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // 旧版のアプリは auth_token という名前で送ってくるので両方受ける
    var token = body.token || body.auth_token;
    if (!isAuthorized_(token)) return json(authError_());

    switch (body.action) {
      case 'save': return saveState_(body);
      case 'content': return saveContent_(body);
      case 'log': case undefined: case '': return appendLog_(body);
      default: return json({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    return json({ ok: false, error: 'EXCEPTION', message: String(err) });
  }
}

/* ================================================================== */
/* 1. 端末間の同期                                                     */
/* ================================================================== */

function saveState_(body) {
  var lock = LockService.getScriptLock();
  try {
    if (!body.state || typeof body.state !== 'object') return json({ ok: false, error: 'NO_STATE' });

    lock.waitLock(20000);

    var file = findFile_(FILE_NAME);
    var current = file ? readJson_(file) : null;
    var serverUpdatedAt = (current && current.updatedAt) || 0;
    var base = Number(body.baseUpdatedAt || 0);

    // 別の端末が先に保存していたら、上書きせずに競合として返す
    if (!body.force && current && serverUpdatedAt > base) {
      return json({
        ok: true,
        conflict: true,
        updatedAt: serverUpdatedAt,
        deviceName: current.deviceName || '',
        state: current.state || null
      });
    }

    var now = Date.now();
    var payload = {
      updatedAt: now,
      deviceName: String(body.deviceName || ''),
      savedAtText: new Date(now).toLocaleString('ja-JP'),
      state: body.state
    };

    writeJson_(file, FILE_NAME, payload);
    makeDailyBackup_(payload);

    return json({ ok: true, conflict: false, updatedAt: now });
  } catch (err) {
    return json({ ok: false, error: 'EXCEPTION', message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) { }
  }
}

/** 1日1回だけバックアップを残し、古いものは消す（誤上書きの保険） */
function makeDailyBackup_(payload) {
  try {
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var name = BACKUP_PREFIX + today + '.json';
    if (findFile_(name)) return;

    getFolder_('バックアップ').createFile(name, JSON.stringify(payload), MimeType.PLAIN_TEXT);

    var limit = new Date().getTime() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
    var it = getFolder_('バックアップ').getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getName().indexOf(BACKUP_PREFIX) !== 0) continue;
      if (f.getDateCreated().getTime() < limit) f.setTrashed(true);
    }
  } catch (err) {
    // バックアップの失敗で本体の保存を止めない
  }
}

/* ================================================================== */
/* 2. 記録の書き出し                                                   */
/* ================================================================== */

/** 朝の作戦・夜の報告・知識の倉庫を、種類別フォルダにファイルとして残す */
function saveContent_(body) {
  var type = sanitizeName_(body.content_type || 'other');
  var title = sanitizeName_(body.title || ('無題_' + Date.now()));
  var folder = getFolder_(type);

  // 同じ名前が既にあるなら中身を差し替える（同じ日に2回書いても増殖させない）
  var existing = folder.getFilesByName(title + '.md');
  if (existing.hasNext()) {
    var f = existing.next();
    f.setContent(String(body.content || ''));
    return json({ ok: true, updated: true, url: f.getUrl() });
  }

  var created = folder.createFile(title + '.md', String(body.content || ''), MimeType.PLAIN_TEXT);
  return json({ ok: true, created: true, url: created.getUrl() });
}

/** 動作ログを月ごとのテキストファイルに追記する */
function appendLog_(body) {
  var month = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM');
  var name = 'app-log-' + month + '.txt';
  var folder = getFolder_('ログ');

  var line = [
    new Date().toISOString(),
    String(body.level || 'INFO'),
    String(body.app_name || ''),
    String(body.message || ''),
    body.details ? JSON.stringify(body.details) : ''
  ].join('\t') + '\n';

  var it = folder.getFilesByName(name);
  if (it.hasNext()) {
    var f = it.next();
    f.setContent(f.getBlob().getDataAsString('UTF-8') + line);
  } else {
    folder.createFile(name, line, MimeType.PLAIN_TEXT);
  }
  return json({ ok: true, logged: true });
}

/* ================================================================== */
/* 内部処理                                                            */
/* ================================================================== */

function isTokenConfigured_() {
  var t = String(SYNC_TOKEN || '').trim();
  return t.length > 0 && t !== 'PASTE_YOUR_PASSPHRASE_HERE';
}

function matchesToken_(token) {
  return isTokenConfigured_() && String(token || '').trim() === String(SYNC_TOKEN).trim();
}

function isAuthorized_(token) {
  return matchesToken_(token);
}

function authError_() {
  if (!isTokenConfigured_()) {
    return { ok: false, error: 'NO_TOKEN', message: 'スクリプト側の SYNC_TOKEN がまだ初期値のままです' };
  }
  return { ok: false, error: 'AUTH', message: '合言葉が違います' };
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 「営業参謀Pro / <名前>」フォルダを用意して返す */
function getFolder_(name) {
  var root = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
  return name ? getOrCreateFolder_(root, name) : root;
}

function getOrCreateFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** 同期の本体ファイルは「営業参謀Pro」直下に置く */
function findFile_(name) {
  var it = getFolder_().getFilesByName(name);
  if (it.hasNext()) return it.next();

  // 旧版でドライブ直下に作られていた場合は、それを引き継ぐ
  var legacy = DriveApp.getFilesByName(name);
  return legacy.hasNext() ? legacy.next() : null;
}

function readJson_(file) {
  try {
    return JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  } catch (err) {
    return null;
  }
}

function writeJson_(file, name, payload) {
  var text = JSON.stringify(payload);
  if (file) {
    file.setContent(text);
    return file;
  }
  return getFolder_().createFile(name, text, MimeType.PLAIN_TEXT);
}

/** ファイル名に使えない文字を落とす */
function sanitizeName_(s) {
  return String(s).replace(/[\\\/:*?"<>|]/g, '_').slice(0, 120);
}

/**
 * 手動で1回実行して、Driveへのアクセス権限を承認するための関数。
 * 設定が正しいかどうかもここで確認できる。
 */
function setup() {
  if (!isTokenConfigured_()) {
    Logger.log('■ まだ SYNC_TOKEN が初期値です。');
    Logger.log('  アプリの「システム設定 → 端末間の同期 →【合言葉を作る】」で作った文字列を');
    Logger.log('  ファイル先頭の SYNC_TOKEN に貼り付けてから、もう一度この setup を実行してください。');
    return;
  }

  var root = getFolder_();
  Logger.log('■ 準備できました。');
  Logger.log('  保存先フォルダ : ' + root.getUrl());

  var file = findFile_(FILE_NAME);
  Logger.log('  同期ファイル   : ' + (file ? file.getUrl() : 'まだありません（初回同期時に作られます）'));
  Logger.log('');
  Logger.log('  次は「デプロイ → 新しいデプロイ → ウェブアプリ」');
  Logger.log('  （実行するユーザー: 自分 / アクセスできるユーザー: 全員）に進んでください。');
}
