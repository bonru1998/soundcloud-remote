const {chromium}=require('playwright');const fs=require('fs');const path=require('path');const assert=require('assert/strict');const root=path.resolve(__dirname,'..');
(async()=>{
const browser=await chromium.launch({executablePath:process.env.CHROME_BIN,headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:350,height:610}});let errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('http://localhost/**',r=>{const name=new URL(r.request().url()).pathname.slice(1)||'popup.html';r.fulfill({body:fs.readFileSync(path.join(root,'extension',name)),contentType:name.endsWith('js')?'text/javascript':name.endsWith('css')?'text/css':'text/html'});});
await page.addInitScript(()=>{
window.sent=[];window.online=true;window.mockState={title:'Night Drive',artist:'Late Signal',playing:true,elapsed:102,duration:258,volume:.68,shuffle:false,repeat:false,liked:false,seekAvailable:true,volumeAvailable:true,available:{}};
window.chrome={storage:{local:{get:async()=>({tabId:5})}},tabs:{query:async()=>window.online?[{id:5,active:true}]:[],sendMessage:async(id,msg)=>{if(!window.online)throw Error('closed');if(msg.action==='state')return window.mockState;window.sent.push(msg.command);if(msg.command.type==='toggle')window.mockState.playing=!window.mockState.playing;return {ok:true};}},runtime:{sendMessage:async()=>({ok:true})}};
});
await page.goto('http://localhost/popup.html');await page.waitForFunction(()=>document.querySelector('#title').textContent==='Night Drive');
await page.screenshot({path:path.join(root,'Extension-Preview.png')});
for(const command of ['next','previous','toggle']){await page.click('[data-command="'+command+'"]');await page.waitForFunction(()=>!document.querySelector('#play').disabled);assert.equal(await page.evaluate(()=>window.sent.at(-1).type),command);}
assert.equal(await page.locator('#play').getAttribute('aria-label'),'Play');
await page.locator('#volume').evaluate(el=>{el.value=35;el.dispatchEvent(new Event('change'));});await page.waitForFunction(()=>!document.querySelector('#play').disabled);assert.equal(await page.evaluate(()=>window.sent.at(-1).value),.35);
await page.evaluate(()=>window.online=false);await page.waitForFunction(()=>document.querySelector('#play').disabled);assert(await page.locator('#volume').isDisabled());
assert.deepEqual(errors,[]);await browser.close();console.log('PASS: extension popup track state, next/previous/play, volume and disconnected controls.');
})().catch(e=>{console.error(e);process.exit(1)});
