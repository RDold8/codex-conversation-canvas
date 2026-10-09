import {build} from 'esbuild'
import {mkdtemp,mkdir,rm,writeFile,readFile,realpath} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true});const dir=await mkdtemp(resolve('../../runtime/task-growth-')),resources=[],cases=[]
await build({entryPoints:['src/remote.ts','src/store.ts','src/connection.ts','src/engineering.ts','src/schema.ts','src/archive.ts','src/governance.ts'],bundle:true,splitting:true,platform:'node',format:'esm',target:'node24',outdir:dir,outExtension:{'.js':'.mjs'}})
const mod=async name=>import(pathToFileURL(resolve(dir,name+'.mjs')).href)
const {Store}=await mod('store'),{RemoteManager}=await mod('remote'),{CodexConnection}=await mod('connection'),{allowedTarget}=await mod('engineering'),{ProjectSchema}=await mod('schema')
const {exportProject,restoreProject}=await mod('archive')
const {activeAssignments}=await mod('governance')
const parentId=randomUUID(),parent={id:parentId,cwd:'D:/fixture',turns:[1,2,3].map(i=>({id:'t'+i,status:'completed',items:[{id:'u'+i,type:'userMessage',content:[{type:'text',text:'原文'+i}]},{id:'a'+i,type:'agentMessage',text:'回复'+i}]}))}
function ok(name,fn){fn();cases.push({name,status:'PASS'})}
async function scenario(mode='delegateGood',late=false){
 const stateFile=resolve(dir,randomUUID()+'.json');await writeFile(stateFile,JSON.stringify({mode,threads:{[parentId]:parent},calls:[],responses:[]}))
 const store=new Store(resolve(dir,randomUUID()+'.sqlite'));store.importThread(parent,parentId);const anchor=store.anchors(parentId).find(a=>a.role==='user');let p=store.create({commandId:randomUUID(),title:'子 Bot 测试',primaryThreadId:parentId,statements:[{text:'主干原要求',authority:'user',hard:true,anchorIds:[anchor.id]}]})
 const connection=new CodexConnection(process.execPath,[resolve('tests/fake-app-server.mjs')],{...process.env,FAKE_APP_STATE:stateFile})
 if(late){const request=connection.request.bind(connection);connection.request=(method,params,opts={})=>request(method,params,{...opts,timeoutMs:method==='thread/start'?40:3000})}
 const manager=new RemoteManager(store,connection,true);resources.push({store,manager})
 return {store,manager,stateFile,anchor,get p(){return store.get(p.id)},apply(operation,payload){p=store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,operation,payload});return p},request(overrides={}){return {commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,operation:'delegate',nodeId:'main',parentId:'main',title:'独立子任务',scope:'修正前端',task:'只解决当前交互问题并给出验证结果',mode:'discussion',anchorIds:[anchor.id],packageIds:[],...overrides}}}
}
const state=async s=>JSON.parse(await readFile(s.stateFile,'utf8'))
async function poll(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,25))}throw Error('fixture timeout')}
try{
 const s=await scenario(),request=s.request(),created=await s.manager.submit(request),child=s.p.nodes.at(-1)
 ok('新子 Bot 使用空独立聊天，来源历史保留',()=>{assert.equal(created.state,'completed');assert.equal(child.relation,'delegated');assert.notEqual(child.threadId,parentId);assert.equal(s.store.anchors(child.threadId).length,0);assert.equal(s.store.anchors(parentId).length,6);assert.equal(child.parentId,'main')})
 const calls=(await state(s)).calls
 ok('thread/start 只读持久聊天，无完整 fork 或隐式首轮',()=>{assert.equal(calls.filter(c=>c.method==='thread/start').length,1);assert.equal(calls.find(c=>c.method==='thread/start').params.sandbox,'read-only');assert.equal(calls.find(c=>c.method==='thread/start').params.ephemeral,false);assert(!calls.some(c=>c.method==='thread/fork'||c.method==='turn/start'));assert(calls.some(c=>c.method==='thread/name/set'))})
 ok('必要原文快照有固定主干、任务说明，未继承摘要压缩段',()=>{const c=s.p.contexts.at(-1);assert(c.text.includes('主干原要求'));assert(c.text.includes(request.task));assert(!c.text.includes('原文3'));assert.equal(s.p.segments.length,0);assert.equal(s.p.compressions.length,0)})
 await s.manager.submit(request);await s.manager.recover(created.id)
 ok('重复创建及终态恢复不再建聊天',()=>assert.equal(s.p.nodes.length,2))
 const turnRequest={commandId:child.task.initialTurnCommandId,projectId:s.p.id,expectedRevision:s.p.revision,operation:'turn',nodeId:child.id,contextId:s.p.contexts.at(-1).id,message:request.task},turn=await s.manager.submit(turnRequest);await poll(()=>s.store.run(turn.id).terminalEvent);await s.manager.submit(turnRequest)
 const wire=(await state(s)).calls.filter(c=>c.method==='turn/start')
 ok('首轮独立记录，精确子聊天只读且重复不重发',()=>{assert.equal(wire.length,1);assert.equal(wire[0].params.threadId,child.threadId);assert.equal(wire[0].params.sandboxPolicy.type,'readOnly');assert(wire[0].params.input[0].text.includes('成果接收父任务：main'));assert.equal(s.store.run(turn.id).state,'completed')})
 let source=child
 for(let i=0;i<5;i++){const run=await s.manager.submit(s.request({nodeId:source.id,parentId:source.id,anchorIds:[s.anchor.id],title:'深层'+i}));assert.equal(run.state,'completed');source=s.p.nodes.at(-1)}
 ok('至少六层任务可递归继承明确选定原文',()=>{let n=source,depth=0;while(n.parentId){depth++;n=s.p.nodes.find(v=>v.id===n.parentId)}assert.equal(depth,6)})
 const before=s.p,oldParent=source.parentId;s.apply('promote_topic',{nodeId:source.id,parentId:'main',title:'升级专题',reason:'需要独立追踪'})
 ok('深层提升保留同一聊天来源和主干版本，重要性独立',()=>{const n=s.p.nodes.find(n=>n.id===source.id);assert.equal(n.threadId,source.threadId);assert.equal(n.trunkRevisionId,source.trunkRevisionId);assert.equal(n.originParentId,oldParent);assert.equal(n.moves[0].from,oldParent);assert.equal(n.importance,'high');assert.equal(n.topic,true);assert(s.p.edges.some(e=>e.kind==='reference'&&e.source===oldParent&&e.target===n.id));assert.deepEqual(s.p.trunks,before.trunks)})
 s.apply('set_importance',{nodeId:child.id,importance:'critical'});ok('重点标记不改变层级',()=>assert.equal(s.p.nodes.find(n=>n.id===child.id).parentId,'main'))
 ok('拒绝移动主干和移动到自己后代',()=>{assert.throws(()=>s.apply('promote_topic',{nodeId:'main',parentId:child.id,title:'错误',reason:'错误'}));assert.throws(()=>s.apply('promote_topic',{nodeId:child.id,parentId:s.p.nodes.find(n=>n.parentId===child.id).id,title:'环',reason:'错误'}))})
 const childAnchor=s.store.anchors(child.threadId).find(a=>a.role==='assistant');s.apply('result_package',{nodeId:child.id,items:[{key:'交互',kind:'verification',text:'隔离验证结果',anchorIds:[childAnchor.id],scope:child.scope}]});const pack=s.p.packages.at(-1)
 ok('成果自动投递直接父任务，未自动引入任何上下文',()=>{assert.equal(pack.deliveryToId,'main');assert(!s.p.contexts.some(c=>c.packageIds.includes(pack.id)))})
 s.apply('prepare_context',{nodeId:'main',budget:20000});const trunkBefore=s.p.trunks;s.apply('accept_result',{nodeId:'main',packageId:pack.id,budget:20000})
 ok('父任务明确接收来源成果，主干约束不改写',()=>{assert(s.p.contexts.at(-1).packageIds.includes(pack.id));assert.deepEqual(s.p.trunks,trunkBefore)})
 ok('其他兄弟不能冒充成果接收父任务',()=>assert.throws(()=>s.apply('accept_result',{nodeId:source.id,packageId:pack.id,budget:20000}),e=>e.code==='RESULT_RECIPIENT'))
 const extracted=await s.manager.submit(s.request({nodeId:child.id,parentId:'main',anchorIds:[childAnchor.id],topic:true,title:'从原文提取'})),extract=s.p.nodes.at(-1)
 ok('选原文提取新专题，保留原任务并记录引用',()=>{assert.equal(extracted.state,'completed');assert.equal(extract.topic,true);assert.equal(extract.task.originNodeId,child.id);assert(s.p.nodes.some(n=>n.id===child.id));assert(s.p.edges.some(e=>e.kind==='reference'&&e.source===child.id&&e.target===extract.id))})
 const saved=await exportProject(s.store,s.p.id),restoredStore=new Store(resolve(dir,'restored.sqlite'));resources.push({store:restoredStore,manager:{close:async()=>{}}});const restored=await restoreProject(restoredStore,saved.path)
 ok('归档恢复保留子 Bot 来源、提升记录和成果接收方',()=>{assert.deepEqual(restored.project,s.p);assert.equal(ProjectSchema.parse(restored.project).nodes.at(-1).task.originNodeId,child.id);assert.equal(restored.remoteReplay,false)})
 const bad=await scenario('delegateBad'),badRequest=bad.request(),badRun=await bad.manager.submit(badRequest);await bad.manager.submit(badRequest)
 ok('非空返回历史拒绝绑定，保留 ID 且不自动重建',()=>{assert.equal(badRun.state,'unknown');assert(badRun.threadId);assert.equal(bad.p.nodes.length,1)})
 const dropped=await scenario('delegateDropKnown'),drop=await dropped.manager.submit(dropped.request());assert.equal(drop.state,'unknown');const recovered=await dropped.manager.recover(drop.id)
 ok('丢失响应仅通过已记录 ID 恢复原创建',()=>{assert.equal(recovered.state,'completed');assert.equal(dropped.p.nodes.length,2)})
 const noId=await scenario('delegateDropNoId'),missing=await noId.manager.submit(noId.request());await assert.rejects(noId.manager.recover(missing.id),e=>e.code==='DELEGATE_RECOVERY_REQUIRED');ok('缺少新聊天 ID 时拒绝猜测重建',()=>assert.equal(noId.p.nodes.length,1))
 const late=await scenario('delegateLate',true),lateRun=await late.manager.submit(late.request());assert.equal(lateRun.state,'unknown');await poll(()=>late.store.run(lateRun.id).state==='completed');ok('迟到响应仅绑定一次',()=>assert.equal(late.p.nodes.length,2))
 const repo=await realpath(await mkdir(resolve(dir,'repo'),{recursive:true}).then(()=>resolve(dir,'repo')));await mkdir(resolve(repo,'src'));await writeFile(resolve(repo,'src/a.txt'),'baseline');const git=(...args)=>execFileSync('git',['-C',repo,...args],{windowsHide:true,encoding:'utf8'}).trim();git('init');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture')
 const code=await scenario();code.apply('set_engineering',{repoPath:repo,baseCommit:git('rev-parse','HEAD'),contractVersion:'2',assignments:[{nodeId:'main',allowedPaths:['src/a.txt'],acceptance:['checks']}],verifications:[]})
 const expanded=await code.manager.submit(code.request({mode:'code',scopeAccess:'project',allowedPaths:['.'],acceptance:['checks']}))
 ok('显式全项目授权允许跨父任务路径扩大并交接范围',()=>{assert.equal(expanded.state,'completed');assert.deepEqual(activeAssignments(code.p.engineering)[0].allowedPaths,['.']);assert.notEqual(activeAssignments(code.p.engineering)[0].nodeId,'main');assert(code.p.engineering.assignments.some(a=>a.nodeId==='main'))})
 await assert.rejects(allowedTarget(repo,'../outside'),e=>e.code==='PATH_ESCAPE');await assert.rejects(allowedTarget(repo,'.git/config'),e=>e.code==='PATH_ESCAPE');cases.push({name:'全项目不开放仓库外或 Git 元数据',status:'PASS'})
 code.apply('set_engineering',{...code.p.engineering,assignments:[{nodeId:code.p.nodes.at(-1).id,allowedPaths:['.'],acceptance:['checks']}]});ok('全项目工程契约可保存，静态范围检查一致',()=>assert.deepEqual(code.p.engineering.assignments[0].allowedPaths,['.']))
 ok('全项目与任何兄弟写入范围重叠会拒绝',()=>assert.throws(()=>code.apply('set_engineering',{...code.p.engineering,leases:[],assignments:[...code.p.engineering.assignments,{nodeId:'main',allowedPaths:['src/a.txt'],acceptance:['checks']}]}),e=>e.code==='ENGINEERING_OVERLAP'))
 const bounded=await scenario();bounded.apply('set_engineering',{repoPath:repo,baseCommit:git('rev-parse','HEAD'),contractVersion:'2',assignments:[{nodeId:'main',allowedPaths:['src/a.txt'],acceptance:['checks']}],verifications:[]});const escaped=await bounded.manager.submit(bounded.request({mode:'code',allowedPaths:['src'],acceptance:['checks']}));ok('指定路径模式不得静默扩大父任务权限',()=>{assert.equal(escaped.state,'failed');assert.equal(bounded.p.nodes.length,1)})
 const huge=await scenario();await assert.rejects(huge.manager.submit(huge.request({task:'大'.repeat(12000),budget:1000})),e=>e.code==='CONTEXT_BUDGET');cases.push({name:'任务正文与来源合并超预算先拒绝且不建聊天',status:'PASS'})
 const report={status:'PASS',case_count:cases.length,cases,model_calls:0,production_chat_writes:0};await writeFile('../../evidence/task-growth-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{for(const {manager,store} of resources){await manager.close();store.close()}await rm(dir,{recursive:true,force:true})}
