import {createRequire} from 'node:module'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {resolve} from 'node:path'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const root=resolve(fileURLToPath(new URL('..',import.meta.url)))
const cwd=resolve(root,'plugins/long-conversation-canvas')
const require=createRequire(resolve(cwd,'package.json'))
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href)
const version=JSON.parse(await readFile(resolve(cwd,'package.json'),'utf8')).version
const launch=JSON.parse(await readFile(resolve(cwd,'.mcp.json'),'utf8')).mcpServers.long_conversation_canvas
assert.equal(launch.command,'node');assert.deepEqual(launch.args,['dist/server.mjs'])
assert.equal(launch.env?.CANVAS_ENABLE_REMOTE_WRITES,'1')
const data=await mkdtemp(resolve(tmpdir(),'canvas-release-'))
const client=new Client({name:'release-candidate-check',version})
try {
 await client.connect(new StdioClientTransport({command:process.execPath,args:launch.args,cwd:resolve(cwd,launch.cwd??'.'),env:{...process.env,...launch.env,CANVAS_DATA_DIR:data},stderr:'pipe'}))
 assert.equal(client.getServerVersion().version,version)
 const {tools}=await client.listTools()
 assert.equal(tools.length,25)
 assert.equal(tools.filter(t=>t._meta?.ui?.visibility?.includes('app')&&!t._meta?.ui?.visibility?.includes('model')).length,20)
 const render=tools.find(t=>t.name==='canvas_render')
 assert.equal(render._meta['openai/ui'].entrypoints[0].type,'global')
 const resource=await client.readResource({uri:render._meta.ui.resourceUri})
 assert.equal(resource.contents[0].mimeType,'text/html;profile=mcp-app')
 assert(resource.contents[0].text.includes('Codex 长对话画布'))
 const workspace=await client.callTool({name:'workspace_read',arguments:{}})
 assert.equal(workspace.structuredContent.remoteEnabled,true)
 assert.equal(workspace.structuredContent.projects.length,0)
 const report={status:'PASS',version,tool_count:tools.length,app_only_tools:20,global_entry:true,remote_enabled:true,isolated_storage:true,html_bytes:Buffer.byteLength(resource.contents[0].text),model_calls:0,chat_writes:0,manifest_not_published_yet:true}
 await writeFile(resolve(root,'runtime/release-candidate-check.json'),JSON.stringify(report,null,2)+'\n')
 console.log(JSON.stringify(report))
} finally {
 await client.close()
 await rm(data,{recursive:true,force:true})
}
