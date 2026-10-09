import {build} from 'esbuild'
import {mkdtemp,readFile,rm,writeFile,mkdir,realpath} from 'node:fs/promises'
import {resolve,relative} from 'node:path'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true})
const root=await realpath('../../runtime'),dir=await mkdtemp(resolve(root,'store-test-'))
const modulePath=resolve(dir,'store.mjs')
await build({entryPoints:['src/store.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:modulePath})
const {Store,PolicyError}=await import('file:///'+modulePath.replaceAll('\\','/'))
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',d='33333333-3333-4333-8333-333333333333'
const fixture=(id,turn='t1',content='用户原文\nemoji🧭\n空格  与标点。')=>({id,turns:[{id:turn,status:'completed',items:[{id:turn+'u',type:'userMessage',content:[{type:'text',text:content}]},{id:turn+'a',type:'agentMessage',text:'助手建议，不自动视为用户决定'},{id:turn+'tool',type:'commandExecution',command:'echo test',aggregatedOutput:'raw log\n'}]}]})
const cases=[];let store=new Store(resolve(dir,'tasks.sqlite')),p
function pass(name,fn){fn();cases.push({name,status:'PASS'})}
function rejected(code,fn){assert.throws(fn,e=>e instanceof PolicyError&&e.code===code);cases.push({name:code,status:'PASS'})}
function op(operation,payload,extra={}){const cmd={commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation,payload,...extra};const updated=store.apply(cmd);p=updated;return cmd}
try{
 rejected('PRIMARY_UNBOUND',()=>store.create({commandId:randomUUID(),title:'未读取任务',primaryThreadId:a,statements:[{text:'要求',authority:'user',hard:true,anchorIds:['missing']}]}))
 store.importThread(fixture(a),a);store.importThread(fixture(b),b);store.importThread(fixture(d),d)
 const pending=fixture(a,'pending');pending.turns[0].status='inProgress';store.importThread(pending,a)
 const unfinished=store.anchors(a).find(x=>x.turnId==='pending'&&x.role==='user');const unfinishedRaw=unfinished.raw
 store.importThread(fixture(a,'pending'),a)
 pass('进行中转完成的观察不覆盖原文',()=>{assert.equal(store.anchor(unfinished.id).turnStatus,'completed');assert.equal(store.anchor(unfinished.id).raw,unfinishedRaw)})
 const source=store.anchors(a).find(x=>x.role==='user'),assistant=store.anchors(a).find(x=>x.role==='assistant')
 pass('原文Unicode与工具结果无损',()=>{assert.equal(source.text,fixture(a).turns[0].items[0].content[0].text);assert.equal(store.anchors(a).find(x=>x.role==='commandExecution').raw,JSON.stringify(fixture(a).turns[0].items[2]))})
 const rawBefore=store.db.prepare('SELECT count(*) n FROM raw_reads').get().n
 rejected('THREAD_MISMATCH',()=>store.importThread(fixture(b),a));assert.equal(store.db.prepare('SELECT count(*) n FROM raw_reads').get().n,rawBefore)
 const statement={text:'保留原文，禁止连续压缩',authority:'user',hard:true,anchorIds:[source.id]}
 const request={commandId:randomUUID(),title:'测试长任务',primaryThreadId:a,statements:[statement]};p=store.create(request)
 pass('创建幂等',()=>assert.equal(store.create(request).id,p.id))
 rejected('COMMAND_REUSED',()=>store.create({...request,title:'不同请求'}))
 rejected('AUTHORITY_MISMATCH',()=>op('revise_trunk',{statements:[{...statement,anchorIds:[assistant.id]}]}))
 rejected('CONFIRMATION_MISSING',()=>op('revise_trunk',{statements:[{...statement,authority:'confirmed',anchorIds:[assistant.id]}]}))
 rejected('SUGGESTION_NOT_CONSTRAINT',()=>op('revise_trunk',{statements:[{...statement,authority:'suggestion'}]}))
 op('attach_branch',{parentId:'main',threadId:b,title:'分支B',scope:'代码审查'});const branch=p.nodes.at(-1)
 op('attach_branch',{parentId:'main',threadId:d,title:'分支C',scope:'接口检查'});const other=p.nodes.at(-1)
 op('prepare_context',{nodeId:branch.id,budget:20000});const defaultBranchContext=p.contexts.at(-1)
 pass('默认分支上下文保留固定主干与所属原文',()=>{assert.equal(defaultBranchContext.nodeId,branch.id);assert(defaultBranchContext.anchorIds.includes(source.id));assert(defaultBranchContext.anchorIds.some(id=>store.anchor(id).threadId===b));assert.deepEqual(defaultBranchContext.packageIds,[])})
 const contextCount=p.contexts.length;op('prepare_context',{nodeId:branch.id,budget:20000});pass('已有有效上下文不被默认准备替换',()=>assert.equal(p.contexts.length,contextCount))
 op('build_context',{nodeId:branch.id,anchorIds:defaultBranchContext.anchorIds,packageIds:[],excluded:[],budget:20000});pass('分支继承主干硬约束后可再次更新快照',()=>assert.equal(p.contexts.at(-1).trunkRevisionId,branch.trunkRevisionId))
 rejected('SCOPE_VIOLATION',()=>op('build_context',{nodeId:branch.id,anchorIds:[store.anchors(d)[0].id],packageIds:[],excluded:[],budget:20000}))
 const originalTrunk=branch.trunkRevisionId
 op('revise_trunk',{statements:[{...statement,text:'新的主干要求'}]})
 rejected('SCOPE_VIOLATION',()=>op('build_context',{nodeId:branch.id,anchorIds:[assistant.id],packageIds:[],excluded:[],budget:20000}))
 pass('分支版本不静默漂移',()=>assert.equal(p.nodes.find(n=>n.id===branch.id).trunkRevisionId,originalTrunk))
 rejected('REVISION_CONFLICT',()=>op('save_view',{positions:[],viewport:{x:0,y:0,zoom:1}},{expectedRevision:0}))
 rejected('CONTEXT_CYCLE',()=>op('add_reference',{source:branch.id,target:'main',kind:'context_from'}))
 const view=op('save_view',{positions:[{nodeId:branch.id,x:123,y:456}],viewport:{x:30,y:40,zoom:.7}})
 pass('写命令幂等',()=>assert.equal(store.apply(view).revision,p.revision))
 const ba=store.anchors(b).find(x=>x.role==='user'),da=store.anchors(d).find(x=>x.role==='user')
 rejected('SCOPE_VIOLATION',()=>op('result_package',{nodeId:branch.id,items:[{key:'结论',kind:'fact',text:'结果',scope:branch.scope,anchorIds:[da.id]}]}))
 rejected('RESULT_BUDGET',()=>op('result_package',{nodeId:branch.id,items:[{key:'结论',kind:'fact',text:'🧭'.repeat(4001),scope:branch.scope,anchorIds:[ba.id]}]}))
 op('result_package',{nodeId:branch.id,items:[{key:'接口',kind:'fact',text:'接口通过',scope:branch.scope,anchorIds:[ba.id]}]});const pack1=p.packages.at(-1)
 op('result_package',{nodeId:other.id,items:[{key:'接口',kind:'fact',text:'接口失败',scope:other.scope,anchorIds:[da.id]}]});const pack2=p.packages.at(-1)
 rejected('CONTEXT_CONFLICT',()=>op('build_context',{nodeId:'main',anchorIds:[source.id],packageIds:[pack1.id,pack2.id],excluded:[],budget:50000}))
 op('merge_preview',{packageIds:[pack1.id,pack2.id],resolutions:{}})
 rejected('UNRESOLVED_CONFLICT',()=>op('merge_adopt',{mergeId:p.merges.at(-1).id,statements:[statement]}))
 rejected('CONTEXT_BUDGET',()=>op('build_context',{nodeId:'main',anchorIds:[source.id],packageIds:[],excluded:[],budget:1}))
 rejected('COMPRESSION_UNKNOWN',()=>op('compress_context',{segmentId:'unknown',contextId:'missing',checkpointId:'missing',summary:'摘要',status:'completed'}))
 const checkpoint=(anchor,turn)=>{op('checkpoint',{nodeId:'main',anchorIds:[anchor.id],completedTurnIds:[turn],decisions:[],unresolved:[],nextAction:'核查代码'});return p.checkpoints.at(-1)}
 let cp=checkpoint(source,'t1')
 const context=anchors=>{op('build_context',{nodeId:'main',anchorIds:anchors,packageIds:[],excluded:[],budget:50000});return p.contexts.at(-1)}
 let ctx=context([source.id]);op('rebuild_segment',{nodeId:'main',contextId:ctx.id,checkpointId:cp.id});const segment=p.segments.at(-1)
 for(let i=0;i<3;i++)op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'失败尝试',status:'failed'})
 rejected('COMPRESSION_RETRY_LIMIT',()=>op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'第四次重复尝试',status:'failed'}))
 ctx=context([source.id])
 rejected('COMPRESSION_RETRY_LIMIT',()=>op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'换快照ID仍是相同输入',status:'failed'}))
 op('checkpoint',{nodeId:'main',anchorIds:[source.id,assistant.id],completedTurnIds:['t1'],decisions:[],unresolved:['核对失败输入'],nextAction:'加入原文里的相关助手说明'});cp=p.checkpoints.at(-1)
 ctx=context([source.id,assistant.id]) // Changed original input after checking the failed attempts.
 op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'第一次从原文整理',status:'completed'})
 rejected('COMPRESSION_COOLDOWN',()=>op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'连续第二次',status:'completed'}))
 rejected('COMPRESSION_COOLDOWN',()=>op('rebuild_segment',{nodeId:'main',contextId:ctx.id,checkpointId:cp.id}))
 store.importThread(fixture(a,'t2','新的实质任务：核对接口变化'),a);const next=store.anchors(a).find(x=>x.turnId==='t2'&&x.role==='user')
 cp=checkpoint(next,'t2');ctx=context([source.id,next.id])
 op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'第二次直接从两轮原文整理',status:'completed'})
 rejected('COMPRESSION_LIMIT',()=>op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'第三次',status:'completed'}))
 const eng={repoPath:resolve(dir),baseCommit:'a'.repeat(40),contractVersion:'2',assignments:[{nodeId:branch.id,allowedPaths:['src/a.ts'],acceptance:['验证接口']}],verifications:[]}
 rejected('ENGINEERING_OVERLAP',()=>op('set_engineering',{...eng,assignments:[...eng.assignments,{nodeId:other.id,allowedPaths:['src'],acceptance:['检查']}] }))
 rejected('PATH_ESCAPE',()=>op('set_engineering',{...eng,assignments:[{...eng.assignments[0],allowedPaths:['../outside']}]}))
 rejected('BASELINE_DRIFT',()=>op('set_engineering',{...eng,verifications:[{nodeId:branch.id,testedCommit:'b'.repeat(40),commands:['npm test'],evidence:'报告'}]}))
 rejected('ACCEPTANCE_REQUIRED',()=>op('node_status',{nodeId:branch.id,status:'done'}))
 const beforeFold={anchors:store.anchors(a).length,trunk:p.activeTrunkId,children:p.nodes.filter(n=>n.parentId==='main').map(n=>n.id)};op('collapse_node',{nodeId:'main',collapsed:true});
 pass('折叠只保存视图不改原文主干和后续分支',()=>{assert.equal(p.nodes.find(n=>n.id==='main').collapsed,true);assert.equal(store.anchors(a).length,beforeFold.anchors);assert.equal(p.activeTrunkId,beforeFold.trunk);assert.deepEqual(p.nodes.filter(n=>n.parentId==='main').map(n=>n.id),beforeFold.children);assert(p.nodes.filter(n=>n.parentId==='main').every(n=>!n.collapsed))});
 const revision=p.revision,id=p.id;store.close();store=new Store(resolve(dir,'tasks.sqlite'));p=store.get(id)
 pass('重启恢复坐标上下文与原文',()=>{assert.equal(p.revision,revision);assert.equal(p.nodes.find(n=>n.id==='main').collapsed,true);assert.equal(p.viewport.zoom,.7);assert.equal(p.nodes.find(n=>n.id===branch.id).x,123);assert.equal(p.compressions.filter(c=>c.status==='completed').length,2);assert.equal(p.compressions.filter(c=>c.status==='failed').length,3);assert.equal(store.anchor(source.id).text,source.text)})
 rejected('COMPRESSION_LIMIT',()=>op('compress_context',{segmentId:segment.id,contextId:ctx.id,checkpointId:cp.id,summary:'重启绕过',status:'completed'}))
 op('collapse_node',{nodeId:'main',collapsed:false});pass('老对话可重新展开',()=>assert.equal(p.nodes.find(n=>n.id==='main').collapsed,false));
 const report={status:'PASS',cases,case_count:cases.length,storage:'Node SQLite transactions',model_calls:0,real_chat_writes:0,ui_accepted:false}
 await writeFile('../../evidence/store-policy-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,case_count:cases.length,model_calls:0,real_chat_writes:0}))
}finally{store.close();const final=await realpath(dir);assert(!relative(root,final).startsWith('..'));await rm(final,{recursive:true,force:true})}
