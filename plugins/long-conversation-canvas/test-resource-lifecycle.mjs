import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {mkdtemp,copyFile,readFile,writeFile,unlink,rm,realpath,mkdir} from 'node:fs/promises'
import {resolve,join,sep} from 'node:path'
import assert from 'node:assert/strict'

const runtime=resolve('../../runtime')
await mkdir(runtime,{recursive:true})
const directory=await mkdtemp(join(runtime,'ui-lifecycle-'))
const client=new Client({name:'resource-lifecycle-check',version:'1'})
try{
 await copyFile('dist/server.mjs',join(directory,'server.mjs'))
 await copyFile('dist/workspace.html',join(directory,'workspace.html'))
 const transport=new StdioClientTransport({command:process.execPath,args:[join(directory,'server.mjs')],stderr:'pipe'})
 await client.connect(transport)
 const before=await client.readResource({uri:'ui://long-conversation-canvas/workspace.html'})
 await unlink(join(directory,'workspace.html'))
 const after=await client.readResource({uri:'ui://long-conversation-canvas/workspace.html'})
 assert.equal(after.contents[0].text,before.contents[0].text)
 assert.equal(after.contents[0].mimeType,'text/html;profile=mcp-app')
 await writeFile('../../evidence/resource-lifecycle-probe.json',JSON.stringify({status:'PASS',model_calls:0,scenario:'UI file removed after service start',resource_still_readable:true,bytes:Buffer.byteLength(after.contents[0].text)},null,2))
 console.log('RESOURCE_LIFECYCLE_PASS')
}finally{
 await client.close()
 const absolute=await realpath(directory),allowed=await realpath(runtime)
 assert(absolute.startsWith(allowed+sep))
 await rm(absolute,{recursive:true,force:true})
}
