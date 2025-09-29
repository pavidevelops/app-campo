/* queue.js — Evidente (fila offline + sincronização) — ES5 compat WebView */
(function (w) {
  'use strict';

  /*** CONFIG ***/
  // URL padrão do Apps Script (fallback se não vier no item nem no window)
  var DEFAULT_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxBj4HaY5AggfGoRXW8JvDAKFG_SRJ3GWyBsOVG1GIes0Yv5tup8pUGSyhSL2RFFo5f/exec';
  // Ative para logs no console:
  var DEBUG = true;

  function dlog() { if (DEBUG && typeof console !== 'undefined') { try { console.log.apply(console, arguments); } catch(e) {} } }
  function derr() { if (typeof console !== 'undefined') { try { console.error.apply(console, arguments); } catch(e) {} } }

  /*** IndexedDB ***/
  var DB_NAME = 'evidente-db';
  var STORE = 'outbox';
  var VERSION = 1;
  var RUNNING = false;
  var FLUSH_INTERVAL_MS = 60000; // tenta a cada 60s

  var _db = null;

  function dbOpen() {
    return new Promise(function (res, rej) {
      if (_db) return res(_db);
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var st = db.createObjectStore(STORE, { keyPath: 'submission_uuid' });
          st.createIndex('created_at', 'created_at', { unique: false });
        }
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error || new Error('DB open error')); };
    });
  }

  function putItem(item) {
    return dbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error || new Error('tx put error')); };
        // garante created_at
        if (item && !item.created_at) { item.created_at = Date.now ? Date.now() : (new Date()).getTime(); }
        tx.objectStore(STORE).put(item); // put = upsert
      });
    });
  }

  function getAll() {
    return dbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var out = [];
        var tx = db.transaction(STORE, 'readonly');
        var store = tx.objectStore(STORE);
        var idx = store.index('created_at');
        var req = idx.openCursor();
        req.onsuccess = function (e) {
          var cursor = e.target.result;
          if (cursor) { out.push(cursor.value); cursor.continue(); }
        };
        tx.oncomplete = function () { res(out); };
        tx.onerror = function () { rej(tx.error || new Error('tx cursor error')); };
      });
    });
  }

  function del(id) {
    return dbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { rej(tx.error || new Error('tx delete error')); };
        tx.objectStore(STORE).delete(id);
      });
    });
  }

  /*** Network ***/
  function encodeForm(data) {
    var p = [], k, v;
    for (k in data) if (data.hasOwnProperty(k)) {
      v = (data[k] === null || data[k] === undefined) ? '' : data[k];
      p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return p.join('&');
  }

  function postFormXHR(url, data) {
    return new Promise(function (resolve, reject) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) {
            if (xhr.status >= 200 && xhr.status < 300) {
              try { 
                var json = JSON.parse(xhr.responseText);
                dlog('[queue] POST OK', data.action, json);
                resolve(json); 
              } catch (e) { 
                derr('[queue] Resposta inválida', e);
                reject(new Error('Resposta inválida')); 
              }
            } else {
              derr('[queue] HTTP error', xhr.status, data.action);
              reject(new Error('HTTP ' + xhr.status));
            }
          }
        };
        xhr.onerror = function () { derr('[queue] HTTP 0 / network error'); reject(new Error('HTTP 0')); };
        dlog('[queue] POST →', url, data.action);
        xhr.send(encodeForm(data));
      } catch (e) {
        derr('[queue] POST exception', e);
        reject(e);
      }
    });
  }

  function safe(v, def) { return (v === null || v === undefined) ? (def || '') : v; }

  // normaliza valor de CHUVA para 'SIM' ou ''
  function normChuva(v) {
    if (v === true) return 'SIM';
    if (typeof v === 'string') {
      var s = v.trim().toLowerCase();
      if (s === 'sim' || s === 'true' || s === '1' || s === 'yes') return 'SIM';
      if (v === 'SIM') return 'SIM';
    }
    return v ? 'SIM' : '';
  }

  function getLS(key) {
    try { return localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function resolveBaseUrl(item) {
    var fromItem = item && item.WEBAPP_URL;
    var fromWindow = (typeof w !== 'undefined') && w && w.WEBAPP_URL;
    var baseUrl = fromItem || fromWindow || DEFAULT_WEBAPP_URL;
    dlog('[queue] WEBAPP_URL:', baseUrl ? 'ok' : 'MISSING', baseUrl);
    return baseUrl;
  }

  // 1 item = upload_foto -> gravar_linha_lt08
  function sendItem(item) {
    var baseUrl = resolveBaseUrl(item);
    if (!baseUrl) return Promise.reject(new Error('WEBAPP_URL não definido'));

    // valores de lote (fallback localStorage)
    var loteNome = item.lote || getLS('EVIDENTE_LOTE_NOME') || '';
    var loteCod  = item.lote_cod || getLS('EVIDENTE_LOTE_COD') || '';

    // 1) Upload da foto (manter lote/lote_cod por telemetria/consistência)
    return postFormXHR(baseUrl, {
      action: 'upload_foto',
      usuario: item.usuario,
      lote: loteNome,
      lote_cod: loteCod,
      cod_atividade: item.cod_atividade,
      atividade: item.atividade,
      app_version: item.app_version,
      submission_uuid: item.submission_uuid,
      lat: safe(item.lat, ''),
      long: safe(item.long, ''),
      accuracy_m: safe(item.accuracy_m, ''),
      foto_base64: item.foto_base64
    }).then(function (up) {
      if (!up || up.status !== 'OK') {
        throw new Error((up && up.mensagem) || 'Falha no upload');
      }

      // 2) Gravar linha (A..K + L) — inclui lote e lote_cod
      return postFormXHR(baseUrl, {
        action: 'gravar_linha_lt08',
        data_hora: new Date().toISOString(), // opcional
        app_version: item.app_version,
        usuario: item.usuario,
        cod_atividade: item.cod_atividade,
        atividade: item.atividade,
        foto: up.foto_url || '',
        foto_id: up.foto_id || '',
        lat: safe(item.lat, ''),
        long: safe(item.long, ''),
        obs: item.obs || '',
        chuva: normChuva(item.chuva),            // J
        // compat: envie ambos; seu GAS aceita fake_gps ou gps_flag
        fake_gps: item.fake_gps || item.gps_flag || '',
        gps_flag: item.gps_flag || item.fake_gps || '',
        // >>> ESSENCIAL para COLUNA L:
        lote: loteNome,
        lote_cod: loteCod,
        // idempotência
        submission_uuid: item.submission_uuid
      });
    }).then(function (grava) {
      if (!grava || grava.status !== 'OK') {
        throw new Error((grava && grava.mensagem) || 'Falha ao gravar linha');
      }
      return true;
    });
  }

  function flushOnce() {
    if (RUNNING || !navigator.onLine) return Promise.resolve(false);
    RUNNING = true;
    dlog('[queue] flushOnce() start');
    return getAll().then(function (items) {
      if (!items.length) { RUNNING = false; dlog('[queue] flushOnce() nothing to send'); return false; }
      var seq = Promise.resolve();
      for (var i = 0; i < items.length; i++) {
        (function (it) {
          seq = seq.then(function () {
            if (!navigator.onLine) return;
            dlog('[queue] sending item', it.submission_uuid);
            return sendItem(it).then(function () { 
              dlog('[queue] sent, deleting', it.submission_uuid);
              return del(it.submission_uuid); 
            });
          });
        })(items[i]);
      }
      return seq.then(function () {
        RUNNING = false;
        dlog('[queue] flushOnce() done');
        return true;
      }).catch(function (e) {
        RUNNING = false; 
        derr('[queue] flushOnce() error', e && e.message);
        return false;
      });
    }).catch(function (e) {
      RUNNING = false;
      derr('[queue] flushOnce() DB error', e && e.message);
      return false;
    });
  }

  function queueOrSendNow(item, callbacks) {
    callbacks = callbacks || {};
    // garante campos essenciais
    if (!item.submission_uuid) {
      item.submission_uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0,v=c==='x'?r:(r&0x3|0x8);return v.toString(16);});
    }
    if (!item.created_at) { item.created_at = Date.now ? Date.now() : (new Date()).getTime(); }

    if (navigator.onLine) {
      dlog('[queue] online → sending now', item.submission_uuid);
      return sendItem(item).then(function () {
        dlog('[queue] onSent', item.submission_uuid);
        if (callbacks.onSent) { try { callbacks.onSent(); } catch (e) {} }
        return { sent: true, queued: false };
      }).catch(function (err) {
        derr('[queue] send failed, queueing', err && err.message);
        return putItem(item).then(function () {
          if (callbacks.onQueued) { try { callbacks.onQueued(); } catch (e) {} }
          return { sent: false, queued: true };
        });
      });
    }
    // offline: guarda direto
    dlog('[queue] offline → queued', item.submission_uuid);
    return putItem(item).then(function () {
      if (callbacks.onQueued) { try { callbacks.onQueued(); } catch (e) {} }
      return { sent: false, queued: true };
    });
  }

  // eventos e timer
  w.addEventListener('online', function () { flushOnce(); });
  setInterval(function () { if (navigator.onLine) flushOnce(); }, FLUSH_INTERVAL_MS);
  setTimeout(function () { if (navigator.onLine) flushOnce(); }, 2000);

  // expõe API global
  w.EvidenteQueue = {
    queueOrSendNow: queueOrSendNow,
    flushNow: flushOnce
  };
})(window);
