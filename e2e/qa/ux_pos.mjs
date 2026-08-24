// Area B: D2 unlock overflow + accessibility (contrast, tap targets, focus, aria) on POS + public screens.
import { chromium } from 'playwright'
import { installBridge } from '../cloud-bridge.mjs'
import fs from 'fs'

const BASE = 'https://cloudchaserz.frappe.cloud'
const HOST = 'cloudchaserz.frappe.cloud'
const SID = fs.readFileSync('/tmp/ccsid', 'utf8').trim()
const SHOTS = '/home/claude/awanz/e2e/qa/shots-secux'
const ASSOC = { usr: 'ok.mingo.a1@cloudchaserz.example', pwd: 'cloud123', pin: '2580' }
const STORE = 'OK-MINGO'

const browser = await chromium.launch({ headless: true })
function adminState(){return {cookies:[{name:'sid',value:SID,domain:HOST,path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]}}
async function newCtx(opts={}){const c=await browser.newContext({baseURL:BASE,...opts});await installBridge(c);return c}
async function loggedCtx(u,opts={}){const c=await newCtx(opts);const r=await c.request.post('/api/method/login',{data:{usr:u.usr,pwd:u.pwd}});if(!r.ok())throw new Error('login '+r.status());return c}

// WCAG contrast utilities injected into pages
const A11Y_FN = `
window.__a11y = (function(){
  function parse(c){ const m=(c||'').match(/rgba?\\(([^)]+)\\)/); if(!m) return null; const p=m[1].split(',').map(x=>parseFloat(x)); return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}; }
  function lum({r,g,b}){ const f=v=>{v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4)}; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); }
  function ratio(fg,bg){ const L1=lum(fg),L2=lum(bg); const a=Math.max(L1,L2),b=Math.min(L1,L2); return (a+0.05)/(b+0.05); }
  function effectiveBg(el){ let n=el; while(n){ const bg=parse(getComputedStyle(n).backgroundColor); if(bg&&bg.a>0.5) return bg; n=n.parentElement; } return {r:0,g:0,b:0,a:1}; }
  function audit(selectors){
    const out=[];
    for(const sel of selectors){
      const els=[...document.querySelectorAll(sel)].slice(0,3);
      for(const el of els){
        const cs=getComputedStyle(el);
        const fg=parse(cs.color); if(!fg) continue;
        const bg=effectiveBg(el);
        const fsize=parseFloat(cs.fontSize), fw=parseInt(cs.fontWeight)||400;
        const large = fsize>=24 || (fsize>=18.66 && fw>=700);
        const r=ratio(fg,bg);
        const need = large?3.0:4.5;
        const txt=(el.textContent||'').trim().slice(0,24);
        out.push({sel, text:txt, fg:cs.color, bg:'rgb('+bg.r+','+bg.g+','+bg.b+')', size:fsize, weight:fw, large, ratio:Math.round(r*100)/100, need, pass:r>=need});
      }
    }
    return out;
  }
  function tapTargets(selectors){
    const out=[];
    for(const sel of selectors){
      for(const el of [...document.querySelectorAll(sel)].slice(0,4)){
        const rc=el.getBoundingClientRect();
        out.push({sel, w:Math.round(rc.width), h:Math.round(rc.height), ok: rc.width>=44 && rc.height>=44});
      }
    }
    return out;
  }
  function ariaGaps(){
    const gaps=[];
    const btns=[...document.querySelectorAll('button')];
    let noName=0; for(const b of btns){ const n=(b.getAttribute('aria-label')||b.textContent||b.title||'').trim(); if(!n) noName++; }
    const inputs=[...document.querySelectorAll('input,select,textarea')];
    let noLabel=0; for(const i of inputs){ const id=i.id; const lbl=id&&document.querySelector('label[for="'+id+'"]'); const al=i.getAttribute('aria-label')||i.getAttribute('placeholder')||i.getAttribute('title'); if(!lbl&&!al) noLabel++; }
    return {buttons:btns.length, buttons_no_name:noName, inputs:inputs.length, inputs_no_label:noLabel, lang: document.documentElement.lang||'(none)'};
  }
  return {audit, tapTargets, ariaGaps, ratio, parse};
})();
`

const report = {}

// ---- D2 unlock overflow at 1366x1024 ----
{
  const c = await loggedCtx(ASSOC, { viewport: { width: 1366, height: 1024 } })
  const page = await c.newPage()
  try {
    await page.goto('/pos/unlock', { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => localStorage.setItem('awanzE2E', '1'))
    await page.goto('/pos', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.unlock select.input', { timeout: 45000 })
    await page.waitForTimeout(1200)
    const ov = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))
    const wm = await page.locator('.unlock .wordmark, .brand .wordmark').first().textContent().catch(()=>'')
    report.d2_unlock_overflow_1366 = ov
    console.log(`D2 unlock overflow @1366x1024 = ${ov}px  wordmark="${(wm||'').trim()}"`)
    await page.screenshot({ path: `${SHOTS}/a11y-unlock-1366.png` })
    // also 1920 to compare
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.waitForTimeout(600)
    report.d2_unlock_overflow_1920 = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth))
    console.log(`   unlock overflow @1920x1080 = ${report.d2_unlock_overflow_1920}px`)
  } catch (e) { console.log('D2 err', String(e).slice(0,140)); report.d2_err = String(e).slice(0,140) }
  await c.close()
}

// ---- POS sell accessibility ----
{
  const c = await loggedCtx(ASSOC, { viewport: { width: 1366, height: 1024 } })
  const page = await c.newPage()
  try {
    await page.goto('/pos/unlock', { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => localStorage.setItem('awanzE2E', '1'))
    await page.goto('/pos', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.unlock select.input', { timeout: 45000 })
    await page.selectOption('.unlock select.input >> nth=0', STORE)
    const load = page.locator('.unlock button:has-text("Load")')
    if (await load.count()) await load.click()
    await page.waitForSelector('.keypad', { timeout: 60000 })
    await page.selectOption('.unlock select.input >> nth=1', ASSOC.usr)
    for (let i=0;i<8;i++){ await page.waitForTimeout(200); if((await page.inputValue('.unlock select.input >> nth=1'))===ASSOC.usr) break; await page.selectOption('.unlock select.input >> nth=1', ASSOC.usr) }
    for (const d of ASSOC.pin) await page.click(`.keypad button:text-is("${d}")`)
    await page.waitForSelector('.topbar', { timeout: 45000 })
    await page.waitForSelector('.tile', { timeout: 45000 })
    await page.waitForTimeout(1000)
    await page.addScriptTag({ content: A11Y_FN })
    const contrast = await page.evaluate(() => window.__a11y.audit(['.topbar .wordmark','.topbar','.tile .name','.tile .price','.basket .total-amt','.pay button','.search input','button.gold, .btn-gold, .primary','.muted','.sub']))
    const taps = await page.evaluate(() => window.__a11y.tapTargets(['.keypad button','.tile','.pay button','.topbar button','.search input']))
    const aria = await page.evaluate(() => window.__a11y.ariaGaps())
    // focus visibility: focus the search input and first keypad and read outline
    const focusInfo = await page.evaluate(() => {
      const res=[]
      for(const sel of ['.search input','.tile','.pay button']){ const el=document.querySelector(sel); if(!el) continue; el.focus(); const cs=getComputedStyle(el); res.push({sel, outlineWidth:cs.outlineWidth, outlineStyle:cs.outlineStyle, boxShadow:(cs.boxShadow||'').slice(0,40)}) }
      return res
    })
    report.pos = { contrast, taps, aria, focus: focusInfo }
    console.log('\n=== POS SELL contrast (fail = below WCAG AA) ===')
    for (const x of contrast) console.log(`  ${x.pass?'ok ':'FAIL'} ${x.ratio}:1 (need ${x.need}) ${x.sel} "${x.text}" fg=${x.fg} bg=${x.bg} ${x.size}px/${x.weight}`)
    console.log('=== POS tap targets (<44px = fail) ===')
    for (const t of taps) console.log(`  ${t.ok?'ok ':'FAIL'} ${t.w}x${t.h} ${t.sel}`)
    console.log('=== POS aria ===', JSON.stringify(aria))
    console.log('=== POS focus outline ===', JSON.stringify(focusInfo))
    await page.screenshot({ path: `${SHOTS}/a11y-pos-sell-1366.png` })
  } catch (e) { console.log('POS a11y err', String(e).slice(0,160)); report.pos_err=String(e).slice(0,160) }
  await c.close()
}

// ---- public screens: rewards, shop, dashboard ----
for (const [name, path, admin, vw] of [['rewards','/rewards',false,[1440,900]],['shop','/shop',false,[1440,900]],['dashboard','/awanz-dashboard',true,[1920,1080]]]) {
  const c = admin ? await newCtx({ storageState: adminState(), viewport:{width:vw[0],height:vw[1]} }) : await newCtx({ viewport:{width:vw[0],height:vw[1]} })
  const page = await c.newPage()
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(3000)
    await page.addScriptTag({ content: A11Y_FN })
    const sels = name==='dashboard'
      ? ['.wordmark','.kpi .value, .stat .num','.muted','.tab, .nav a','.card .name','h1,h2,h3','button']
      : ['h1','h2','h3','p','a','button','.muted','.btn, button.gold, .primary','.price, .amount']
    const contrast = await page.evaluate((s) => window.__a11y.audit(s), sels)
    const taps = await page.evaluate(() => window.__a11y.tapTargets(['button','a.btn, .btn','input']))
    const aria = await page.evaluate(() => window.__a11y.ariaGaps())
    report[name] = { contrast, taps, aria }
    console.log(`\n=== ${name.toUpperCase()} contrast ===`)
    for (const x of contrast.filter(x=>!x.pass)) console.log(`  FAIL ${x.ratio}:1 (need ${x.need}) ${x.sel} "${x.text}" fg=${x.fg} bg=${x.bg} ${x.size}px/${x.weight}`)
    const passN = contrast.filter(x=>x.pass).length
    console.log(`  (${passN}/${contrast.length} sampled elements pass)`)
    console.log(`  aria:`, JSON.stringify(aria), ' tapFails:', taps.filter(t=>!t.ok).length)
    await page.screenshot({ path: `${SHOTS}/a11y-${name}.png` })
  } catch (e) { console.log(name,'a11y err', String(e).slice(0,140)) }
  await c.close()
}

fs.writeFileSync('/tmp/qa_a11y.json', JSON.stringify(report, null, 2))
await browser.close()
console.log('\nsaved /tmp/qa_a11y.json')
