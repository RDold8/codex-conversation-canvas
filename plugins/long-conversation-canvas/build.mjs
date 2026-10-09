import {build} from 'esbuild'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
await mkdir('dist',{recursive:true})
await build({entryPoints:['src/server.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:'dist/server.mjs',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}})
await build({entryPoints:['src/widget.tsx'],bundle:true,format:'iife',platform:'browser',target:'es2022',outfile:'dist/widget.js',minify:true,define:{'process.env.NODE_ENV':'"production"'}})
const script=await readFile('dist/widget.js','utf8'),css=await readFile('dist/widget.css','utf8')
await writeFile('dist/workspace.html',`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 长对话画布</title><style>${css}</style></head><body><div id="root"></div><script>${script.replaceAll('</script','<\\/script')}</script></body></html>`)
console.log('Plugin server and self-contained MCP UI resource built')
