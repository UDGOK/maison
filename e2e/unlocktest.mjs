import { chromium } from 'playwright'
import { installBridge } from './cloud-bridge.mjs'
const BASE='https://cloudchaserz.frappe.cloud'
const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:1366,height:1024}})
if(process.env.BRIDGE==='1') await installBridge(ctx,{baseURL:BASE})
const p=await ctx.newPage()
const errs=[]; p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,160))})
await p.goto(BASE+'/login',{waitUntil:'domcontentloaded'})
await p.fill('#login_email','hou.mtr.a1@cloudchaserz.example'); await p.fill('#login_password','cloud123')
await Promise.all([p.waitForNavigation({timeout:45000}).catch(()=>{}), p.click('.btn-login')])
await p.goto(BASE+'/pos',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000)
console.log('STEP1 url', p.url())
console.log('STEP1 text', (await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,220))
// click LOAD
const load = p.locator('button:has-text("LOAD"), button:has-text("Load")').first()
if (await load.count()) { console.log('clicking LOAD'); await load.click(); }
for (let i=0;i<24;i++){ await p.waitForTimeout(2500)
  const t=(await p.locator('body').innerText()).replace(/\s+/g,' ')
  if(/PIN|ASSOCIATE|Enter/i.test(t) && !/Load the store catalog/i.test(t)) { console.log('LOADED after',(i+1)*2.5,'s'); break }
  if(i%4===0) console.log(' ...', t.slice(0,160))
}
await p.screenshot({path:'/tmp/unlock1.png'})
console.log('STEP2 text', (await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,300))
// choose associate if a select exists
const sel = p.locator('select').first()
if (await sel.count()) { const opts = await sel.locator('option').allTextContents(); console.log('associate options:', opts.slice(0,6)) }
// type PIN
for (const d of '2580') {
  const k = p.locator(`button:has-text("${d}")`).first()
  if (await k.count()) await k.click(); else await p.keyboard.type(d)
  await p.waitForTimeout(250)
}
await p.waitForTimeout(4000)
console.log('AFTER PIN url', p.url())
console.log('AFTER PIN text', (await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,300))
await p.screenshot({path:'/tmp/unlock2.png'})
console.log('errors', errs.slice(0,6))
await b.close()
