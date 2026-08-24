import { chromium } from 'playwright'
import { installBridge } from './cloud-bridge.mjs'
const BASE='https://cloudchaserz.frappe.cloud'
const b=await chromium.launch()
const ctx=await b.newContext({viewport:{width:1600,height:1000}})
await installBridge(ctx,{baseURL:BASE})
const p=await ctx.newPage()
await p.goto(BASE+'/login',{waitUntil:'domcontentloaded'})
await p.fill('#login_email','ok.sap.a1@cloudchaserz.example'); await p.fill('#login_password','cloud123')
await Promise.all([p.waitForNavigation({timeout:45000}).catch(()=>{}), p.click('.btn-login')])
await p.goto(BASE+'/pos',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(4000)
const load=p.locator('button:has-text("Load")').first()
if(await load.count()){ await load.click(); await p.waitForTimeout(7000) }
const t=(await p.locator('body').innerText()).replace(/\s+/g,' ')
console.log('TEXT:', t.slice(0,240))
console.log('has MAISON:', /maison/i.test(t), '| has AWANZ:', /awanz/i.test(t), '| has Futonix:', /futonix/i.test(t))
await p.screenshot({path:'/tmp/pos-brand.png'})
await b.close()
