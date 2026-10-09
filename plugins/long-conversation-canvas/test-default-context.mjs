import {build} from 'esbuild'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true});const dir=await mkdtemp(resolve('../../runtime/context-default-test-')),file=resolve(dir,'store.mjs');let store
try{
 await build({entryPoints:['src/store.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:file});const {Store}=await import(pathToFileURL(file).href);store=new Store(resolve(dir,'tasks.sqlite'))
 const ids=[1,2,3,4].map(i=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`)
 const thread=(id,count,big=false)=>({id,turns:Array.from({length:count},(_,i)=>({id:'t'+(i+1),status:i===4?'inProgress':'completed',items:[{id:'u'+i,type:'userMessage',content:[{type:'text',text:big?'长'.repeat(30000):'用户原文 '+i}]},{id:'a'+i,type:'agentMessage',text:'回复 '+i}]}))})
 ids.forEach((id,index)=>store.importThread(thread(id,index===3?0:index===2?1:5,index===2),id))
 const primary=store.anchors(ids[0]).find(a=>a.role==='user');let p=store.create({commandId:randomUUID(),title:'默认上下文边界',primaryThreadId:ids[0],statements:[{text:'固定主干',authority:'user',hard:true,anchorIds:[primary.id]}]})
 const apply=(operation,payload)=>p=store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation,payload})
 const cases=[],test=(name,fn)=>{fn();cases.push({name,status:'PASS'})}
 apply('attach_branch',{parentId:'main',threadId:ids[1],title:'分支',scope:'前端'});const branch=p.nodes.at(-1)
 apply('prepare_context',{nodeId:branch.id,budget:20000});const context=p.contexts.at(-1),local=context.anchorIds.map(id=>store.anchor(id)).filter(a=>a.threadId===branch.threadId)
 test('只选最近两轮已完成原文，不选运行中轮次',()=>assert.deepEqual([...new Set(local.map(a=>a.turnId))],['t3','t4']))
 test('默认不压缩也不自动引入兄弟成果',()=>{assert.equal(p.compressions.length,0);assert.equal(context.packageIds.length,0);assert(context.anchorIds.includes(primary.id));assert(context.excluded.some(a=>store.anchor(a.id).turnId==='t5'))})
 const id=context.id;apply('prepare_context',{nodeId:branch.id,budget:1});test('已有有效快照保持预算原文及ID',()=>{assert.equal(p.contexts.at(-1).id,id);assert.equal(p.contexts.at(-1).budget,20000)})
 apply('attach_branch',{parentId:'main',threadId:ids[2],title:'超长原文',scope:'调研'});const huge=p.nodes.at(-1),revision=p.revision,count=p.contexts.length
 test('超预算拒绝且不会生成截断上下文',()=>{assert.throws(()=>apply('prepare_context',{nodeId:huge.id,budget:20000}),e=>e.code==='CONTEXT_BUDGET');assert.equal(store.get(p.id).revision,revision);assert.equal(store.get(p.id).contexts.length,count)})
 apply('attach_branch',{parentId:'main',threadId:ids[3],title:'空对话',scope:'调研'});const empty=p.nodes.at(-1)
 test('缺原文时拒绝凭空建立记忆',()=>assert.throws(()=>apply('prepare_context',{nodeId:empty.id,budget:20000}),e=>e.code==='CONTEXT_SOURCE_EMPTY'))
 const latestSnapshot={id:ids[1],turns:[6,7].map(i=>({id:'t'+i,status:'completed',items:[{id:'u'+i,type:'userMessage',content:[{type:'text',text:'当前实际轮次 '+i}]}]}))};store.importThread(latestSnapshot,ids[1])
 let fresh=store.create({commandId:randomUUID(),title:'宿主历史变化后的任务',primaryThreadId:ids[0],statements:[{text:'固定主干',authority:'user',hard:true,anchorIds:[primary.id]}]})
 fresh=store.apply({commandId:randomUUID(),projectId:fresh.id,expectedRevision:fresh.revision,operation:'attach_branch',payload:{parentId:'main',threadId:ids[1],title:'历史变化分支',scope:'前端'}});const freshBranch=fresh.nodes.at(-1)
 fresh=store.apply({commandId:randomUUID(),projectId:fresh.id,expectedRevision:fresh.revision,operation:'prepare_context',payload:{nodeId:freshBranch.id,budget:20000}})
 test('默认窗口使用最新读取顺序而非历史归档序号',()=>assert.deepEqual([...new Set(fresh.contexts.at(-1).anchorIds.map(id=>store.anchor(id)).filter(a=>a.threadId===ids[1]).map(a=>a.turnId))],['t6','t7']))
 const report={status:'PASS',case_count:cases.length,cases,model_calls:0,chat_writes:0};await writeFile('../../evidence/default-context-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{store?.close();await rm(dir,{recursive:true,force:true})}
