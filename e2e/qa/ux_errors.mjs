// Area B: keyboard focus confirmation + error-handling UX (route 9).
import { chromium } from 'playwright'
import { installBridge } from '../cloud-bridge.mjs'
import fs from 'fs'

const BASE='https://cloudchaserz.frappe.cloud', HOST='cloudchaserz.frappe.cloud'
const SID=fs.readFileSync('/tmp/ccsid','utf8').trim()
const SHOTS='/home/claude/maison/e2e/qa/shots-secux'
const ASSOC={usr:'ok.mingo.a1@cloudchaserz.example',pwd:'cloud123',pin:'2580'}

const browser=await chromium.launch({headless:true})
async function newCtx(opts={}){const c=await browser.newContext({baseURL:BASE,...opts});await installBridge(c);return c}
async function loggedCtx(u,opts={}){const c=await newCtx(opts);await c.request.post('/api/method/login',{data:{usr:u.usr,pwd:u.pwd}});return c}
function state(sid){return {cookies:[{name:'sid',value:sid,domain:HOST,path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]}}

// 1) POS keyboard focus (real Tab) — is there a visible focus ring?
{
  const c=await loggedCtx(ASSOC,{viewport:{width:1366,height:1024}})
  const page=await c.newPage()
  try{
    await page.goto('/pos/unlock',{waitUntil:'domcontentloaded'})
    await page.evaluate(()=>localStorage.setItem('maisonE2E','1'))
    await page.goto('/pos',{waitUntil:'domcontentloaded'})
    await page.waitForSelector('.unlock select.input',{timeout:45000})
    await page.selectOption('.unlock select.input >> nth=0','OK-MINGO')
    const load=page.locator('.unlock button:has-text("Load")'); if(await load.count()) await load.click()
    await page.waitForSelector('.keypad',{timeout:60000})
    await page.selectOption('.unlock select.input >> nth=1',ASSOC.usr)
    for(let i=0;i<8;i++){await page.waitForTimeout(200); if((await page.inputValue('.unlock select.input >> nth=1'))===ASSOC.usr)break; await page.selectOption('.unlock select.input >> nth=1',ASSOC.usr)}
    for(const d of ASSOC.pin) await page.click(`.keypad button:text-is("${d}")`)
    await page.waitForSelector('.tile',{timeout:45000})
    await page.waitForTimeout(800)
    // Tab several times and record the focused element's visible ring
    const focusTrail=[]
    for(let i=0;i<6;i++){
      await page.keyboard.press('Tab')
      const info=await page.evaluate(()=>{const el=document.activeElement; if(!el)return null; const cs=getComputedStyle(el); return {tag:el.tagName, cls:(el.className||'').toString().slice(0,30), outline:cs.outlineStyle+' '+cs.outlineWidth+' '+cs.outlineColor, boxShadow:(cs.boxShadow||'none').slice(0,50)}})
      focusTrail.push(info)
    }
    const anyRing=focusTrail.some(f=>f && ((f.outline && !/none/.test(f.outline) && !/ 0px /.test(f.outline)) || (f.boxShadow && f.boxShadow!=='none')))
    console.log('=== POS keyboard Tab focus trail ===')
    for(const f of focusTrail) console.log('  ', JSON.stringify(f))
    console.log('  >>> ANY visible focus ring on keyboard Tab:', anyRing)
    fs.writeFileSync('/tmp/qa_focus.json', JSON.stringify({focusTrail, anyRing}))
    await page.screenshot({path:`${SHOTS}/a11y-pos-focus.png`})
  }catch(e){console.log('focus err',String(e).slice(0,140))}
  await c.close()
}

// 2) Error UX: expired/bogus session on /maison-dashboard
async function shotText(name, opts, path){
  const c=await newCtx(opts); const page=await c.newPage()
  let out={name}
  try{
    const resp=await page.goto(path,{waitUntil:'domcontentloaded',timeout:40000}).catch(e=>null)
    await page.waitForTimeout(2500)
    out.status=resp?resp.status():'(nav err)'
    out.url=page.url()
    out.text=(await page.evaluate(()=>document.body?document.body.innerText:'')).replace(/\s+/g,' ').trim().slice(0,300)
    // any raw framework error strings visible to the user?
    out.raw=/(frappe\.exceptions|PermissionError|CSRFTokenError|Traceback|DoesNotExistError|ValidationError|InternalServerError|500 Internal)/.test(out.text)
    await page.screenshot({path:`${SHOTS}/err-${name}.png`}).catch(()=>{})
  }catch(e){out.err=String(e).slice(0,120)}
  await c.close(); return out
}

console.log('\n=== ERROR-HANDLING UX (route 9) ===')
const cases=[]
cases.push(await shotText('expired-dashboard',{storageState:state('deadbeef00deadbeef00deadbeef00dead'),viewport:{width:1440,height:900}},'/maison-dashboard'))
// associate (logged in, not HQ) loads the HQ dashboard -> permission denial UX
{
  const c=await loggedCtx(ASSOC,{viewport:{width:1440,height:900}}); const page=await c.newPage()
  let out={name:'assoc-loads-dashboard'}
  try{ const r=await page.goto('/maison-dashboard',{waitUntil:'domcontentloaded',timeout:40000}); await page.waitForTimeout(2500); out.status=r?r.status():0; out.url=page.url(); out.text=(await page.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').trim().slice(0,300); out.raw=/(frappe\.exceptions|PermissionError|Traceback|500 Internal)/.test(out.text); await page.screenshot({path:`${SHOTS}/err-assoc-dashboard.png`}) }catch(e){out.err=String(e).slice(0,120)}
  await c.close(); cases.push(out)
}
// expired session on /warehouse
cases.push(await shotText('expired-warehouse',{storageState:state('deadbeef00deadbeef00deadbeef00dead'),viewport:{width:1440,height:900}},'/warehouse'))
// guest hits /start (needs login?)
cases.push(await shotText('guest-start',{viewport:{width:1440,height:900}},'/start'))

for(const x of cases) console.log(' ', JSON.stringify(x))

// 3) POS network loss UX
{
  const c=await loggedCtx(ASSOC,{viewport:{width:390,height:844}}); const page=await c.newPage()
  try{
    await page.goto('/pos/unlock',{waitUntil:'domcontentloaded'})
    await page.evaluate(()=>localStorage.setItem('maisonE2E','1'))
    await page.goto('/pos',{waitUntil:'domcontentloaded'})
    await page.waitForSelector('.unlock select.input',{timeout:45000})
    await page.selectOption('.unlock select.input >> nth=0','OK-MINGO')
    const load=page.locator('.unlock button:has-text("Load")'); if(await load.count()) await load.click()
    await page.waitForSelector('.keypad',{timeout:60000})
    await page.selectOption('.unlock select.input >> nth=1',ASSOC.usr)
    for(let i=0;i<8;i++){await page.waitForTimeout(200); if((await page.inputValue('.unlock select.input >> nth=1'))===ASSOC.usr)break; await page.selectOption('.unlock select.input >> nth=1',ASSOC.usr)}
    for(const d of ASSOC.pin) await page.click(`.keypad button:text-is("${d}")`)
    await page.waitForSelector('.tile',{timeout:45000}); await page.waitForTimeout(600)
    await c.setOffline(true)
    await page.waitForTimeout(2500)
    const offlineText=(await page.evaluate(()=>document.body.innerText)).replace(/\s+/g,' ').match(/(offline|no network|reconnect|queued)[^.]*/i)
    const topbar=(await page.locator('.topbar').innerText().catch(()=>'')).replace(/\s+/g,' ').slice(0,120)
    console.log('\n=== POS OFFLINE UX (390x844) ===')
    console.log('  offline indicator text:', offlineText?offlineText[0]:'(none found)')
    console.log('  topbar:', topbar)
    await page.screenshot({path:`${SHOTS}/err-pos-offline-390.png`})
    await c.setOffline(false)
  }catch(e){console.log('offline err',String(e).slice(0,140))}
  await c.close()
}
await browser.close()
console.log('\ndone')
