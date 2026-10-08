import fs from 'node:fs'
import path from 'node:path'

const d = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'))
const client = fs.readFileSync(path.join(d, 'lib', 'client.js'), 'utf8')
const host = fs.readFileSync(path.join(d, 'lib', 'index.js'), 'utf8')

console.log('版本               :', pkg.version)
console.log('exports[./client]  :', pkg.exports?.['./client'])
console.log('client.js 存在     :', fs.existsSync(path.join(d, 'lib', 'client.js')))
console.log('注册 detail.section:', client.includes("'plugins.detail.section'"))
console.log('按 subject.pkg 过滤:', client.includes('subject.pkg'))
console.log('保留旧插槽（兼容） :', client.includes("'settings.plugin.item'"))
console.log('宿主挂状态路由     :', host.includes('/plugins/dsh-tuanjie-connect/status'))
console.log('宿主注入 webServer :', host.includes("ctx.inject(['webServer']"))
console.log('package.json BOM   :', fs.readFileSync(path.join(d, 'package.json'))[0] === 0xef ? '有!' : '无')
