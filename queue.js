// queue.js — Evidente (fila offline + sincronização)
const DB_NAME = 'evidente-db';
const STORE = 'outbox';
const VERSION = 1;

function dbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const st = db.createObjectStore(STORE, { keyPath: 'submission_uuid' });
        st.createIndex('created_at', 'created_at');
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function putItem(item){
  const db = await dbOpen();
  return new Promise((res, rej)=>{
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function getAll(){
  const db = await dbOpen();
  return new Promise((res, rej)=>{
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).getAll();
    rq.onsuccess = () => res(rq.result.sort((a,b)=>a.created_at-b.created_at));
    rq.onerror = () => rej(rq.error);
  });
}
async function del(id){
  const db = await dbOpen();
  return new Promise((res, rej)=>{
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function postForm(url, data){
  const body = new URLSearchParams();
  Object.entries(data).forEach(([k,v])=> body.append(k, v));
  const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
  const text = await resp.text();
  let json; try{ json = JSON.parse(text); }catch(_){}
  if(!resp.ok) throw new Error(json?.mensagem || text || 'HTTP error');
  return json;
}

async function sendItem(item){
  // 1) upload_foto
  const up = await postForm(item.WEBAPP_URL, {
    action:'upload_foto',
    usuario:item.usuario, lote:item.lote,
    cod_atividade:item.cod_atividade, atividade:item.atividade,
    app_version:item.app_version, submission_uuid:item.submission_uuid,
    lat:item.lat??'', long:item.long??'', accuracy_m:item.accuracy_m??'',
    foto_base64:item.foto_base64
  });
  if(!up || up.status!=='OK') throw new Error(up?.mensagem || 'Falha no upload');

  // 2) gravar_linha_lt08
  const grava = await postForm(item.WEBAPP_URL, {
    action:'gravar_linha_lt08',
    data_hora:new Date().toISOString(),
    app_version:item.app_version, usuario:item.usuario,
    cod_atividade:item.cod_atividade, atividade:item.atividade,
    foto:up.foto_url||'', foto_id:up.foto_id||'',
    lat:item.lat??'', long:item.long??'', obs:item.obs||''
  });
  if(!grava || grava.status!=='OK') throw new Error(grava?.mensagem || 'Falha ao gravar linha');
  return true;
}

let RUNNING = false;
async function syncAll(){
  if(RUNNING || !navigator.onLine) return;
  RUNNING = true;
  try{
    const items = await getAll();
    for(const it of items){
      try{
        await sendItem(it);
        await del(it.submission_uuid);
      }catch(e){
        // para aqui (backoff simples)
        break;
      }
    }
  } finally {
    RUNNING = false;
  }
}
window.addEventListener('online', syncAll);
setInterval(syncAll, 120000); // a cada 2min

// API para a página usar
async function queueOrSendNow(item){
  if(navigator.onLine){
    try{
      await sendItem(item);
      return { queued:false, sent:true };
    }catch(_){
      await putItem(item);
      return { queued:true, sent:false };
    }
  } else {
    await putItem(item);
    return { queued:true, sent:false };
  }
}
export { queueOrSendNow, syncAll };
