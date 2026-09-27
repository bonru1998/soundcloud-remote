'use strict';
const $ = s => document.querySelector(s);
let config;
try { config = JSON.parse(localStorage.getItem('connection') || 'null'); } catch (_) { config = null; }
let connected = false, current = {}, polling = false, commandBusy = false, toastTimer;
const nativeCallbacks = new Map();
window.nativeResult = (id, result) => { const done = nativeCallbacks.get(id); if(done) { nativeCallbacks.delete(id); done(result); } };
function nativeFetch(host, path, method, body, token) {
  return new Promise((resolve, reject) => {
    const id = String(Date.now())+Math.random().toString(16).slice(2);
    const timer = setTimeout(() => { nativeCallbacks.delete(id); reject(Error('PC did not respond. Check Wi-Fi and Windows Firewall.')); }, 13000);
    nativeCallbacks.set(id, result => { clearTimeout(timer); result.error ? reject(Error(result.error)) : resolve(result); });
    window.Android.request(id, host, path, method, body ? JSON.stringify(body) : '', token || '');
  });
}
async function request(path, body, connection=config) {
  const method = body ? 'POST' : 'GET';
  if (window.Android) return nativeFetch(connection.host, path, method, body, connection.token);
  // The browser version is served directly by the PC companion.
  const response = await fetch(path, {method, headers: {'Content-Type':'application/json', ...(connection?.token ? {Authorization:'Bearer '+connection.token} : {})}, body: body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(12000)});
  const data = await response.json();
  if (!response.ok || data.error) throw Error(data.error || 'PC connection failed');
  return data;
}
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),4500); }
function clock(n) { n=Math.max(0,Math.floor(Number(n)||0)); return Math.floor(n/60)+':'+String(n%60).padStart(2,'0'); }
function openPair() { $('#host').value=config?.host || (window.Android ? '' : location.host); $('#pairError').textContent=''; $('#pairDialog').showModal(); }
function enableControls() {
  const available = current.available || {};
  document.querySelectorAll('[data-command]').forEach(button => {
    const kind=button.dataset.command;
    const supported=kind==='seekBy' ? current.seekAvailable : (kind in available ? available[kind] : true);
    button.disabled=!connected || commandBusy || !supported;
  });
  $('#seek').disabled=!connected || !current.seekAvailable || !current.duration || commandBusy;
  for(const id of ['volume','volDown','volUp']) $('#'+id).disabled=!connected || !current.volumeAvailable || commandBusy;
  for(const id of ['search','sleep']) $('#'+id).disabled=!connected || commandBusy;
}
function paint(data) {
  connected=!!data.connected; current=data.state || {};
  $('#dot').classList.toggle('online',connected);
  $('#deviceName').textContent=data.device || 'DESKTOP PC';
  $('#connection').textContent=connected ? 'Connected via Wi-Fi' : 'Helper online · connect SoundCloud extension';
  $('#title').textContent=current.title || 'Start a track on your PC';
  $('#artist').textContent=current.artist || 'SoundCloud';
  $('#playState').textContent=connected ? (current.playing ? 'Playing on your PC' : 'Paused on your PC') : 'SoundCloud tab disconnected';
  $('#play use').setAttribute('href',current.playing ? '#i-pause' : '#i-play');
  $('#play').setAttribute('aria-label',current.playing?'Pause':'Play');
  $('#elapsed').textContent=clock(current.elapsed); $('#duration').textContent=clock(current.duration);
  const ratio=current.duration ? current.elapsed/current.duration : 0;
  if(document.activeElement!==$('#seek')) $('#seek').value=Math.round(ratio*1000);
  [...$('#wave').children].forEach((el,i)=>el.classList.toggle('played',i/64<ratio));
  if(typeof current.volume==='number') {
    if(document.activeElement!==$('#volume')) $('#volume').value=Math.round(current.volume*100);
    $('#volumeValue').textContent=Math.round(current.volume*100)+'%';
  } else $('#volumeValue').textContent='—';
  for(const [command,key] of [['like','liked'],['shuffle','shuffle'],['repeat','repeat'],['mute','muted']]) document.querySelector('[data-command="'+command+'"]').setAttribute('aria-pressed',!!current[key]);
  const artwork=typeof current.artwork==='string' && /^https:\/\/[^/]*\.sndcdn\.com\//.test(current.artwork) ? current.artwork : '';
  if(artwork && $('#art').getAttribute('src')!==artwork) { $('#art').src=artwork; $('#art').hidden=false; $('#placeholder').hidden=true; }
  if(!artwork) { $('#art').hidden=true; $('#placeholder').hidden=false; }
  $('#sleepLabel').textContent=data.sleepRemaining ? Math.ceil(data.sleepRemaining/60)+' min left' : 'Sleep timer';
  $('#hint').textContent=connected ? 'Sound plays on your PC. This phone is the remote.' : 'Open SoundCloud, click the extension, then Connect SoundCloud tab.';
  enableControls();
}
async function poll() {
  if(polling || !config || document.hidden) return;
  polling=true;
  try { paint(await request('/api/state')); }
  catch(error) { connected=false; $('#dot').classList.remove('online'); $('#connection').textContent='Disconnected · tap to reconnect'; $('#playState').textContent='PC unavailable'; $('#hint').textContent=error.message; enableControls(); }
  finally {polling=false;}
}
async function send(type,value) {
  if(!connected) { toast('Connect SoundCloud on your PC first.'); return false; }
  if(commandBusy) return false;
  commandBusy=true; enableControls();
  try { await request('/api/command',{type,...(value!==undefined?{value}:{})}); await poll(); return true; }
  catch(error) {toast(error.message); return false;}
  finally {commandBusy=false;enableControls();}
}
document.querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>send(button.dataset.command,button.dataset.value!==undefined?Number(button.dataset.value):undefined));
$('#seek').onchange=e=>send('seekTo',Number(e.target.value)/1000);
$('#volume').oninput=e=>$('#volumeValue').textContent=e.target.value+'%';
$('#volume').onchange=e=>send('volume',Number(e.target.value)/100);
$('#volDown').onclick=()=>send('volume',Math.max(0,(Number($('#volume').value)-5)/100));
$('#volUp').onclick=()=>send('volume',Math.min(1,(Number($('#volume').value)+5)/100));
$('#settings').onclick=openPair; $('#device').onclick=openPair;
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$('#'+b.dataset.close).close());
$('#pairForm').onsubmit=async e=>{
  e.preventDefault(); $('#pairSubmit').disabled=true; $('#pairError').textContent='';
  try {
    const host=$('#host').value.trim().replace(/^http:\/\//,'').replace(/\/$/,'');
    if(!/^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(host) && window.Android) throw Error('Enter the numeric PC address shown in its helper window.');
    const next={host:host.includes(':')?host:host+':8765'};
    const result=await request('/api/pair',{code:$('#code').value.trim()},next);
    next.token=result.token; config=next; localStorage.setItem('connection',JSON.stringify(config)); if(window.Android?.startRemote)window.Android.startRemote(config.host,config.token);
    $('#pairDialog').close(); $('#code').value=''; toast('Paired with your PC'); await poll();
  } catch(error) {$('#pairError').textContent=error.message;}
  finally {$('#pairSubmit').disabled=false;}
};
$('#forget').onclick=()=>{if(window.Android?.stopRemote)window.Android.stopRemote();localStorage.removeItem('connection'); config=null; connected=false; current={}; enableControls(); $('#pairDialog').close(); $('#deviceName').textContent='CONNECT YOUR PC'; $('#connection').textContent='Tap to pair over Wi-Fi'; $('#dot').classList.remove('online'); $('#title').textContent='Ready when you are'; $('#artist').textContent='Pair your phone to get started'; toast('PC forgotten on this phone');};
$('#search').onclick=()=>$('#searchDialog').showModal();
$('#searchForm').onsubmit=async e=>{e.preventDefault();const q=$('#query').value.trim();if(q){$('#searchDialog').close();if(await send('search',q))toast('Search opened on your PC');}};
$('#sleep').onclick=()=>$('#sleepDialog').showModal();
document.querySelectorAll('[data-minutes]').forEach(b=>b.onclick=async()=>{const minutes=Number(b.dataset.minutes);$('#sleepDialog').close();if(await send('sleep',minutes))toast(minutes?'Music will pause in '+minutes+' minutes':'Sleep timer cancelled');});
$('#art').onerror=()=>{$('#art').hidden=true;$('#placeholder').hidden=false;};
for(let i=0;i<64;i++){const bar=document.createElement('i');bar.style.height=(14+Math.abs(Math.sin(i*1.73)*Math.cos(i*.31))*29)+'px';$('#wave').appendChild(bar);}
window.closeDialog=()=>{const dialog=document.querySelector('dialog[open]');if(dialog)dialog.close();};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
enableControls(); if(config)poll();else openPair(); setInterval(poll,1200);

if(window.Android?.startRemote){
 const toggle=document.querySelector('#notificationToggle');toggle.hidden=false;
 const label=()=>toggle.textContent='Media notification: '+(window.Android.mediaEnabled()?'On':'Off');label();
 toggle.onclick=()=>{const enabled=!window.Android.mediaEnabled();window.Android.setMediaEnabled(enabled);label();if(enabled&&config)window.Android.startRemote(config.host,config.token);};
 if(config)window.Android.startRemote(config.host,config.token);
}
