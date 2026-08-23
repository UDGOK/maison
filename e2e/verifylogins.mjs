import { chromium } from 'playwright'
import { installBridge } from './cloud-bridge.mjs'
const BASE='https://cloudchaserz.frappe.cloud'
const users=[
 {u:'hou.mtr.a1@cloudchaserz.example', who:'Dante Ruiz', pin:'2580', go:'/pos'},
 {u:'hou.mtr.manager@cloudchaserz.example', who:'Marisol Vega', pin:'1101', go:'/pos'},
 {u:'warehouse@cloudchaserz.example', who:null, pin:null, go:'/pos'},
 {u:'hq@cloudchaserz.example', who:null, pin:null, go:'/maison-dashboard'},
]
const b=await chromium.launch()
for(const t of users){
  const ctx=await b.newContext({viewport:{width:1366,height:1024}})
  await installBridge(ctx,{baseURL:BASE})
  const p=await ctx.newPage()
  await p.goto(BASE+'/login',{waitUntil:'domcontentloaded'})
  await p.fill('#login_email',t.u); await p.fill('#login_password','cloud123')
  await Promise.all([p.waitForNavigation({timeout:45000}).catch(()=>{}), p.click('.btn-login')])
  const landed=p.url()
  await p.goto(BASE+t.go,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(5000)
  let note=''
  if(t.go==='/pos'){
    const load=p.locator('button:has-text("Load")').first()
    if(await load.count()){ await load.click(); await p.waitForTimeout(7000) }
    const txt=(await p.locator('body').innerText()).replace(/\s+/g,' ')
    if(t.pin){
      // pick the right associate
      const sels=p.locator('select'); const n=await sels.count()
      if(n>1){ const opts=await sels.nth(1).locator('option').allTextContents()
        const idx=opts.findIndex(o=>o.includes(t.who)); if(idx>=0) await sels.nth(1).selectOption({index:idx}) }
      await p.waitForTimeout(400)
      for(const d of t.pin){ const k=p.locator(`button:has-text("${d}")`).first()
        if(await k.count()) await k.click(); else await p.keyboard.type(d); await p.waitForTimeout(220) }
      await p.waitForTimeout(4500)
      note = p.url().includes('/sell') ? 'UNLOCKED -> /pos/sell' : 'STUCK: '+p.url()
    } else {
      note = /No store to open|No .* to open/i.test(txt) ? 'empty-state OK (warehouse user)' : 'text: '+txt.slice(0,110)
    }
  } else {
    const txt=(await p.locator('body').innerText()).replace(/\s+/g,' ')
    note = txt.slice(0,90)
  }
  console.log(`${t.u.padEnd(38)} login->${landed.replace(BASE,'')} | ${t.go} | ${note}`)
  await ctx.close()
}
await b.close()
