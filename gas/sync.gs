/**
 * 営業参謀 Pro ―― 端末間データ同期 API (Google Apps Script)
 *
 * これは「スマホとパソコンで同じ内容を見る」ための保存場所です。
 * データはあなた自身のGoogleドライブの中だけに置かれます。
 *
 * === セットアップ手順 ===
 *  1. https://script.google.com/ を開き「新しいプロジェクト」を作る
 *  2. このファイルの中身を全部コピーして貼り付ける
 *  3. 下の SYNC_TOKEN を、自分にしか分からない合言葉に書き換える
 *  4. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *       次のユーザーとして実行 : 自分
 *       アクセスできるユーザー : 全員
 *  5. 出てきた https://script.google.com/macros/s/..../exec のURLをコピー
 *  6. アプリの「システム設定」→「端末間の同期」にURLと合言葉を貼って保存
 *
 * ※「アクセスできるユーザー: 全員」でも、合言葉を知らない人はデータを読めません。
 *   URLと合言葉はセットで人に見せないでください。
 */

// ▼▼▼ ここを自分だけの合言葉に書き換える（英数字で12文字以上を推奨） ▼▼▼
var SYNC_TOKEN = 'CHANGE_ME_your_secret_passphrase';
// ▲▲▲ ここを書き換える ▲▲▲

var FILE_NAME = 'sales-atelier-state.json';
var BACKUP_PREFIX = 'sales-atelier-state.backup-';
var BACKUP_KEEP_DAYS = 14;
var API_VERSION = 1;

/** 読み出し (GET) */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};

    if (p.action === 'ping') {
      // トークンが合っているかの確認だけ。データは返さない。
      return json({ ok: true, pong: true, version: API_VERSION, authorized: p.token === SYNC_TOKEN });
    }

    if (!isAuthorized_(p.token)) return json({ ok: false, error: 'AUTH', message: '合言葉が違います' });

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
 * application/json にするとブラウザがプリフライト(OPTIONS)を投げ、GASが応答できず失敗します。
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (!isAuthorized_(body.token)) return json({ ok: false, error: 'AUTH', message: '合言葉が違います' });
    if (body.action !== 'save') return json({ ok: false, error: 'UNKNOWN_ACTION' });
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

    file = writeJson_(file, FILE_NAME, payload);
    makeDailyBackup_(payload);

    return json({ ok: true, conflict: false, updatedAt: now });
  } catch (err) {
    return json({ ok: false, error: 'EXCEPTION', message: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) { }
  }
}

/* ------------------------------------------------------------------ */
/* 内部処理                                                            */
/* ------------------------------------------------------------------ */

function isAuthorized_(token) {
  return typeof token === 'string' && token.length > 0 && token === SYNC_TOKEN;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function findFile_(name) {
  var it = DriveApp.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
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
  return DriveApp.createFile(name, text, MimeType.PLAIN_TEXT);
}

/** 1日1回だけバックアップを残し、古いものは消す（誤上書きの保険） */
function makeDailyBackup_(payload) {
  try {
    var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var name = BACKUP_PREFIX + today + '.json';
    if (findFile_(name)) return;

    DriveApp.createFile(name, JSON.stringify(payload), MimeType.PLAIN_TEXT);

    var limit = new Date().getTime() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
    var it = DriveApp.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      if (f.getName().indexOf(BACKUP_PREFIX) !== 0) continue;
      if (f.getDateCreated().getTime() < limit) f.setTrashed(true);
    }
  } catch (err) {
    // バックアップの失敗で本体の保存を止めない
  }
}

/** スクリプトエディタから手動実行して、Driveの権限承認を先に済ませるための関数 */
function setup() {
  var file = findFile_(FILE_NAME);
  Logger.log(file ? '保存ファイルあり: ' + file.getUrl() : '保存ファイルはまだありません（初回同期時に作られます）');
  if (SYNC_TOKEN === 'CHANGE_ME_your_secret_passphrase') {
    Logger.log('※ SYNC_TOKEN がまだ初期値です。必ず自分の合言葉に書き換えてください。');
  }
}
