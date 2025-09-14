/* queue.js — Evidente (fila offline + sincronização) — ES5 compat WebView */
(function (w) {
  'use strict';

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
        // compat: cursor (getAll pode não existir)
        var req = store.index('created_at').openCursor();
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

  /* === network === */

  function encodeForm(data) {
    var p = [], k;
    for (k in data) if (data.hasOwnProperty(k)) {
      p.push(encodeURIComponent(k) + '=' + encodeURIComponent(data[k]));
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
              try { resolve(JSON.parse(xhr.responseText)); }
              catch (e) { reject(new Error('Resposta inválida')); }
            } else {
              reject(new Error('HTTP ' + xhr.status));
            }
          }
        };
        xhr.onerror = function () { reject(new Error('HTTP 0')); };
        xhr.send(encodeForm(data));
      } catch (e) {
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
      // se já vier 'SIM' em maiúsculas, mantém:
      if (v === 'SIM') return 'SIM';
    }
    return v ? 'SIM' : '';
  }

  // 1 item = upload_foto -> gravar_linha_lt08
  function sendItem(item) {
    // 1) Upload da foto
    return postFormXHR(item.WEBAPP_URL, {
      action: 'upload_foto',
      usuario: item.usuario,
      lote: item.lote,
      cod_atividade: item.cod_atividade,
      atividade: item.atividade,
      app_version: item.app_version,
      submission_uuid: item.submission_uuid,
      lat: safe(item.lat, ''),
      long: safe(item.long, ''),
      accuracy_m: safe(item.accuracy_m, ''),
      foto_base64: item.foto_base64
    }).then(function (up) {
      if (!up || up.status !== 'OK') throw new Error((up && up.mensagem) || 'Falha no upload');

      // 2) Gravar linha (inclui CHUVA e GPS_FLAG + idempotência)
      return postFormXHR(item.WEBAPP_URL, {
        action: 'gravar_linha_lt08',
        data_hora: new Date().toISOString(),     // opcional, servidor também preenche
        app_version: item.app_version,
        usuario: item.usuario,
        cod_atividade: item.cod_atividade,
        atividade: item.atividade,
        foto: up.foto_url || '',
        foto_id: up.foto_id || '',
        lat: safe(item.lat, ''),
        long: safe(item.long, ''),
        obs: item.obs || '',
        chuva: normChuva(item.chuva),            // >>> coluna J
        gps_flag: item.gps_flag || '',           // >>> coluna K ('FAKE GPS' ou '')
        submission_uuid: item.submission_uuid    // ajuda a idempotência no Apps Script
      });
    }).then(function (grava) {
      if (!grava || grava.status !== 'OK') throw new Error((grava && grava.mensagem) || 'Falha ao gravar linha');
      return true;
    });
  }

  function flushOnce() {
    if (RUNNING || !navigator.onLine) return Promise.resolve(false);
    RUNNING = true;
    return getAll().then(function (items) {
      if (!items.length) { RUNNING = false; return false; }
      var seq = Promise.resolve();
      for (var i = 0; i < items.length; i++) {
        (function (it) {
          seq = seq.then(function () {
            if (!navigator.onLine) return;
            return sendItem(it).then(function () { return del(it.submission_uuid); });
          });
        })(items[i]);
      }
      return seq.then(function () {
        RUNNING = false;
        return true;
      }).catch(function () {
        RUNNING = false; // falhou algum, tenta depois
        return false;
      });
    }).catch(function () {
      RUNNING = false;
      return false;
    });
  }

  function queueOrSendNow(item, callbacks) {
    callbacks = callbacks || {};
    if (navigator.onLine) {
      return sendItem(item).then(function () {
        if (callbacks.onSent) { try { callbacks.onSent(); } catch (e) {} }
        return { sent: true, queued: false };
      }).catch(function () {
        return putItem(item).then(function () {
          if (callbacks.onQueued) { try { callbacks.onQueued(); } catch (e) {} }
          return { sent: false, queued: true };
        });
      });
    }
    // offline: guarda direto
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
