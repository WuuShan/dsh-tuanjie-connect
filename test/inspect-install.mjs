import fs from 'node:fs'
import path from 'node:path'

const d = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'))
console.log('版本:', pkg.version)
console.log('dsh :', JSON.stringify(pkg.dsh))
const b = fs.readFileSync(path.join(d, 'package.json'))
console.log('BOM :', b[0] === 0xef ? '有!' : '无')

const c = fs.readFileSync(path.join(d, 'lib', 'client.js'), 'utf8')
console.log('client.js 含 ModuleLoader :', c.includes('__ModuleLoader__.load('))
console.log('client.js 含 settings 插槽:', c.includes('settings.plugin.item'))
console.log('client.js 卡片 key        :', /CARD_KEY = '([^']+)'/.exec(c)?.[1])

const i = fs.readFileSync(path.join(d, 'lib', 'index.js'), 'utf8')
console.log('index.js 挂状态路由  :', i.includes('/plugins/dsh-tuanjie-connect/status'))
console.log('index.js 注入 webServer:', i.includes("ctx.inject(['webServer']"))
