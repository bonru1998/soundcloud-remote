const $=s=>document.querySelector(s);
let tabId=null,state={},busy=false,polling=false;
const time=n=>Math.floor((Number(n)||0)/60)+':'+String(Math.floor((Number(n)||0)%60)).padStart(2,'0');
async function target(force=false){
 if(!force && tabId)return tabId;
 const saved=await chrome.storage.local.get('tabId');
 const tabs=await chrome.tabs.query({url:'https://soundcloud.com/*'});
 const chosen=force ? tabs.find(t=>t.active)||tabs[0] : tabs.find(t=>t.id===saved.tabId)||tabs.find(t=>t.active)||tabs[0];
 if(!chosen)throw Error('Open SoundCloud in this browser first.');
 tabId=chosen.id;return tabId;
}
function enable(online){
 document.querySelectorAll('[data-command]').forEach(b=>{const c=b.dataset.command;b.disabled=!online||busy||(c==='seekBy'?!state.seekAvailable:state.available?.[c]===false);});
 $('#seek').disabled=!online||busy||!state.seekAvailable||!state.duration;
 $('#volume').disabled=!online||busy||!state.volumeAvailable;
}
async function refresh(){
 if(polling)return;polling=true;
 try{
  state=await chrome.tabs.sendMessage(await target(),{action:'state'});
  if(!state)throw Error('Refresh SoundCloud, then reconnect.');
  $('#connection').textContent='● SoundCloud tab connected';
  $('#title').textContent=state.title;$('#artist').textContent=state.artist;
  $('#play').textContent=state.playing?'Ⅱ':'▶';$('#play').setAttribute('aria-label',state.playing?'Pause':'Play');
  $('#elapsed').textContent=time(state.elapsed);$('#duration').textContent=time(state.duration);
  if(document.activeElement!==$('#seek'))$('#seek').value=state.duration?state.elapsed/state.duration*1000:0;
  if(typeof state.volume==='number'){if(document.activeElement!==$('#volume'))$('#volume').value=state.volume*100;$('#level').textContent=Math.round(state.volume*100)+'%';}
  for(const [cmd,key] of [['like','liked'],['shuffle','shuffle'],['repeat','repeat'],['mute','muted']])$('[data-command="'+cmd+'"]').setAttribute('aria-pressed',!!state[key]);
  const art=/^https:\/\/[^/]*\.sndcdn\.com\//.test(state.artwork||'')?state.artwork:'';
  if(art){if($('#art').getAttribute('src')!==art)$('#art').src=art;$('#art').hidden=false;}else $('#art').hidden=true;
  enable(true);
 }catch(e){tabId=null;$('#connection').textContent='SoundCloud disconnected';enable(false);}
 finally{polling=false;}
}
async function send(type,value){
 if(busy)return;busy=true;enable(true);
 try{const result=await chrome.tabs.sendMessage(await target(),{action:'command',command:{type,...(value===undefined?{}:{value})}});if(!result?.ok)throw Error(result?.error||'No response from SoundCloud');$('#status').textContent='Command sent to SoundCloud.';}
 catch(e){$('#status').textContent=e.message;}
 finally{busy=false;await refresh();}
}
$('[data-command="toggle"]').onclick=()=>send('toggle');
for(const b of document.querySelectorAll('[data-command]'))b.onclick=()=>send(b.dataset.command,b.dataset.value===undefined?undefined:Number(b.dataset.value));
$('#seek').onchange=e=>send('seekTo',Number(e.target.value)/1000);
$('#volume').onchange=e=>send('volume',Number(e.target.value)/100);
$('#connect').onclick=async()=>{
 $('#connect').disabled=true;
 try{await target(true);const r=await chrome.runtime.sendMessage({action:'connect'});$('#status').textContent=r.ok?'PC helper connected. Your phone can control this tab.':r.error+' Local popup controls still work.';}
 catch(e){$('#status').textContent=e.message;}
 finally{$('#connect').disabled=false;refresh();}
};
$('#art').onerror=()=>$('#art').hidden=true;
enable(false);refresh();setInterval(refresh,1000);
