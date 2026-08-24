import { chromium } from 'playwright'
import { installBridge } from '../cloud-bridge.mjs'
import fs from 'fs'
const BASE='https://cloudchaserz.frappe.cloud',HOST='cloudchaserz.frappe.cloud'
const SID=fs.readFileSync('/tmp/ccsid','utf8').trim()
const browser=await chromium.launch({headless:true})
const c=await browser.newContext({baseURL:BASE,storageState:{cookies:[{name:'sid',value:SID,domain:HOST,path:'/',expires:-1,httpOnly:true,secure:true,sameSite:'Lax'}],origins:[]},viewport:{width:1920,height:1080}})
await installBridge(c); const page=await c.newPage()
await page.goto('/maison-dashboard',{waitUntil:'domcontentloaded'})
await page.waitForTimeout(3500)
const ctx=await page.evaluate(()=>{
  function parse(x){const m=(x||'').match(/rgba?\(([^)]+)\)/);if(!m)return null;const p=m[1].split(',').map(Number);return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}}
  function lum({r,g,b}){const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)};return .2126*f(r)+.7152*f(g)+.0722*f(b)}
  function eff(el){let n=el;while(n){const b=parse(getComputedStyle(n).backgroundColor);if(b&&b.a>.5)return b;n=n.parentElement}return{r:0,g:0,b:0}}
  const out=[]
  for(const b of document.querySelectorAll('button')){const cs=getComputedStyle(b);const fg=parse(cs.color);if(!fg)continue;const bg=eff(b);const L1=lum(fg),L2=lum(bg);const r=(Math.max(L1,L2)+.05)/(Math.min(L1,L2)+.05);if(r<4.5){out.push({txt:(b.textContent||'').trim().slice(0,20)||'(icon)',aria:b.getAttribute('aria-label')||'',fg:cs.color,ratio:Math.round(r*100)/100,html:b.outerHTML.slice(0,90)})}}
  return out
})
console.log('dashboard buttons below 4.5:1:'); for(const x of ctx) console.log(' ', JSON.stringify(x))
await browser.close()
