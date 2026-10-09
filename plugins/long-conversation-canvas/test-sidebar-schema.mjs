import {z} from 'zod'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
// Equivalent to the inspected client's Pu strict object for the global entry.
// This test deliberately does not claim the whole desktop module was executed.
const entry=z.object({type:z.literal('global'),quickAction:z.unknown().optional()}).strict()
assert.equal(entry.safeParse({type:'global',title:'长任务'}).success,false)
const client=new Client({name:'sidebar-schema-probe',version:'0.3.0'})
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/server.mjs'],stderr:'pipe'}))
 const {tools}=await client.listTools();const tool=tools.find(t=>t.name==='canvas_render')
 assert.equal(tool.title,'长任务');assert.equal(tool._meta.ui.resourceUri,'ui://long-conversation-canvas/workspace.html')
 const global=tool._meta['openai/ui'].entrypoints.find(e=>e.type==='global')
 assert(entry.safeParse(global).success);assert.deepEqual(global,{type:'global'})
 const report={status:'PASS',previous_extra_title_rejected:true,fixed_entry_compatible:true,title_on_tool:true,
  test_scope:'Equivalent strict global entry schema + real MCP metadata; not actual desktop navigation',desktop_sidebar_verified:false,model_calls:0}
 await writeFile('../../evidence/sidebar-schema-test.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{await client.close()}
