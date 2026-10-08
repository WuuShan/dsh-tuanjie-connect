import fs from 'node:fs'
import path from 'node:path'

const d = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'))
const client = fs.readFileSync(path.join(d, 'lib', 'client.js'), 'utf8')
const host = fs.readFileSync(path.join(d, 'lib', 'index.js'), 'utf8')

const slots = [...client.matchAll(/name: '(plugins\.[a-z.]+)'/g)].map((m) => m[1])
const bundleName = /BUNDLE_NAME = '([^']+)'/.exec(client)?.[1]

console.log('版本                :', pkg.version)
console.log('exports[./client]   :', pkg.exports?.['./client'])
console.log('client.js 存在      :', fs.existsSync(path.join(d, 'lib', 'client.js')))
console.log('注册的插槽          :', slots.join(', '))
console.log('bundle.config 已注册:', client.includes("'plugins.bundle.config'"))
console.log('key 用 BUNDLE_NAME  :', client.includes('key: BUNDLE_NAME'))
console.log('BUNDLE_NAME 的值    :', bundleName)
console.log('与 package name 一致:', bundleName === pkg.name)
console.log('宿主挂状态路由      :', host.includes('/plugins/dsh-tuanjie-connect/status'))
console.log('宿主注入 webServer  :', host.includes("ctx.inject(['webServer']"))
console.log('package.json BOM    :', fs.readFileSync(path.join(d, 'package.json'))[0] === 0xef ? '有!' : '无')
