import { chromium } from 'playwright'
import { installBridge } from './cloud-bridge.mjs'
const BASE='https://cloudchaserz.frappe.cloud'
const b=await chromium.launch()
for (const [u,tag] of [['hou.mtr.a1@cloudchaserz.example','associate'],['warehouse@cloudchaserz.example','warehouse']]){
  const ctx=await b.newContext({viewport:{width:1366,height:1024}})
  await installBridge(ctx,{baseURL:BASE})
  const p=await ctx.newPage()
  await p.goto(BASE+'/login',{waitUntil:'domcontentloaded'})
  await p.fill('#login_email',u); await p.fill('#login_password','cloud123')
  await Promise.all([p.waitForNavigation({timeout:45000}).catch(()=>{}), p.click('.btn-login')])
  await p.waitForTimeout(3500)
  await p.screenshot({path:`/tmp/start-${tag}.png`,fullPage:true})
  console.log(tag, p.url(), '|', (await p.locator('body').innerText()).replace(/\s+/g,' ').slice(0,200))
  await ctx.close()
}
await b.close()
