// Isolated SQLite and protocol fixture. No production threads or model calls.
import {build} from 'esbuild'
import {mkdtemp,mkdir,rm,readFile,writeFile,realpath} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true});const dir=await mkdtemp(resolve('../../runtime/governance-')),resources=[],cases=[]
await build({entryPoints:['src/reviews.ts','src/remote.ts','src/store.ts','src/connection.ts','src/governance.ts','src/archive.ts','src/schema.ts'],bundle:true,splitting:true,platform:'node',format:'esm',target:'node24',outdir:dir,outExtension:{'.js':'.mjs'}})
const mod=async name=>import(pathToFileURL(resolve(dir,name+'.mjs')).href)
const {Store}=await mod('store'),{RemoteManager}=await mod('remote'),{CodexConnection}=await mod('connection'),{ReviewManager}=await mod('reviews'),{policyFor,automaticDecision,activeAssignments}=await mod('governance'),{ReviewPolicySchema}=await mod('schema'),{exportProject,restoreProject}=await mod('archive')
const policy=(level,extra={})=>ReviewPolicySchema.parse({level,...extra})
const ok=(name,fn)=>{fn();cases.push({name,status:'PASS'})}
const poll=async fn=>{for(let i=0;i<120;i++){if(fn())return;await new Promise(r=>setTimeout(r,25))}throw Error('fixture timeout')}
async function scenario(mode='delegateGood'){
 const threadId=randomUUID(),thread={id:threadId,cwd:'D:/fixture',turns:[{id:'t1',status:'completed',items:[{id:'u1',type:'userMessage',content:[{type:'text',text:'保持主干与工程一致'}]},{id:'a1',type:'agentMessage',text:'原始回复'}]}]}
 const stateFile=resolve(dir,randomUUID()+'.json');await writeFile(stateFile,JSON.stringify({mode,threads:{[threadId]:thread},calls:[],responses:[]}))
 const store=new Store(resolve(dir,randomUUID()+'.sqlite'));store.importThread(thread,threadId);const anchor=store.anchors(threadId).find(a=>a.role==='user');let p=store.create({commandId:randomUUID(),title:'复核测试',primaryThreadId:threadId,statements:[{text:'保持主干与工程一致',authority:'user',hard:true,anchorIds:[anchor.id]}]})
 const connection=new CodexConnection(process.execPath,[resolve('tests/fake-app-server.mjs')],{...process.env,FAKE_APP_STATE:stateFile}),remote=new RemoteManager(store,connection,true),reviews=new ReviewManager(store,remote,true)
 resources.push({store,remote});return {store,remote,reviews,connection,stateFile,anchor,get p(){return store.get(p.id)},apply(operation,payload){return store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,operation,payload})},request(extra={}){if(extra.operation==='turn')return {commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,nodeId:'main',...extra};return {commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,operation:'delegate',nodeId:'main',parentId:'main',title:'检查交互',scope:'前端',task:'检查交互',mode:'discussion',anchorIds:[anchor.id],packageIds:[],...extra}}}
}
const state=async s=>JSON.parse(await readFile(s.stateFile,'utf8'))
const calls=async(s,method)=>(await state(s)).calls.filter(c=>c.method===method)
function botReview(s,request,extra={}){const e=policyFor(s.p,request.nodeId);return {id:request.commandId,nodeId:request.nodeId,origin:'bot',sourceRunId:null,request,status:'pending',humanApproved:false,policyHash:e.policyHash,grantNodeId:e.grantNodeId,...extra}}
try{
 const s=await scenario();ok('默认任务内放权，与树层级无关',()=>assert.equal(policyFor(s.p,'main').policy.level,1))
 const req=s.request();await s.reviews.submit(req,false);await s.reviews.tick();ok('未确认人工任务只入队，不创建聊天',()=>{assert.equal(s.p.reviews[0].status,'pending');assert.equal(s.p.nodes.length,1)})
 ok('同一复核 ID 幂等，正文不同拒绝',()=>{s.store.enqueueReview(s.p.id,'main',req,'human',null);assert.throws(()=>s.store.enqueueReview(s.p.id,'main',{...req,task:'另一任务'},'human',null),e=>e.code==='COMMAND_REUSED')})
 const pending=s.p.reviews[0];s.apply('decide_review',{reviewId:pending.id,decision:'approve',request:{...pending.request,task:'人工改过的任务'}});await s.reviews.tick();const child=s.p.nodes.at(-1),done=s.p.reviews[0]
 ok('一次批准后创建子聊天并发送已编辑首轮',()=>{assert.equal(done.status,'completed');assert.equal(child.task.brief,'人工改过的任务');assert.equal(done.firstRequest.commandId,child.task.initialTurnCommandId)})
 await poll(()=>s.store.run(done.runId).terminalEvent);await s.reviews.tick();await s.reviews.recover(s.p.id,done.id)
 ok('审批后不重复创建或重复发首轮',()=>{assert.equal(s.p.nodes.length,2);assert.equal(s.store.runs().filter(r=>r.operation==='turn').length,1)})
 assert.equal((await calls(s,'thread/start')).length,1);assert.equal((await calls(s,'turn/start')).length,1)
 cases.push({name:'协议核对仅一次 thread/start 和一次 turn/start',status:'PASS'})
 const reject=s.request();await s.reviews.submit(reject);s.apply('decide_review',{reviewId:reject.commandId,decision:'reject'});await s.reviews.tick();ok('拒绝任务不派发',()=>assert.equal(s.p.nodes.length,2))
 assert.throws(()=>s.store.enqueueReview(s.p.id,'main',{...s.request(),expectedRevision:0},'human',null),e=>e.code==='REVISION_CONFLICT');cases.push({name:'人工确认前版本变化要求重新复核',status:'PASS'})
 s.apply('set_review_policy',{nodeId:'main',policy:policy(2,{plan:[{id:'approved-plan',text:'检查交互'}]})});let r=s.request(),b=botReview(s,r,{planItemId:'approved-plan'})
 ok('分支档允许精确已批准条目',()=>assert.equal(automaticDecision(s.p,b,r),null))
 ok('借用计划编号改正文仍需人工',()=>assert.match(automaticDecision(s.p,b,{...r,task:'改写整个后端'}),/正文/))
 ok('分支档计划外不自动放行',()=>assert.match(automaticDecision(s.p,{...b,planItemId:'unknown'},r),/计划/))
 for(const level of [0,1]){s.apply('set_review_policy',{nodeId:'main',policy:policy(level)});r=s.request();ok(`第 ${level+1} 档模型新任务需人工`,()=>assert.match(automaticDecision(s.p,botReview(s,r),r),/人工/))}
 s.apply('set_review_policy',{nodeId:'main',policy:policy(3)});r=s.request();b=botReview(s,r)
 ok('自主档允许既定范围的讨论子任务',()=>assert.equal(automaticDecision(s.p,b,r),null))
 ok('全项目扩大仍转人工',()=>assert.match(automaticDecision(s.p,b,{...r,scopeAccess:'project'}),/整个项目/))
 ok('模型不能提取专题改变归属',()=>assert.match(automaticDecision(s.p,b,{...r,topic:true}),/归属/))
 s.apply('set_review_policy',{nodeId:'main',policy:policy(3,{maxDepth:0})});r=s.request();ok('深度额度有效',()=>assert.match(automaticDecision(s.p,botReview(s,r),r),/深度/))
 s.apply('set_review_policy',{nodeId:'main',policy:policy(3,{maxChildren:1})});r=s.request();ok('未完成子任务额度有效',()=>assert.match(automaticDecision(s.p,botReview(s,r),r),/子任务/))
 s.apply('set_review_policy',{nodeId:'main',policy:policy(3,{expiresAt:'2000-01-01T00:00:00.000Z'})});r=s.request();ok('到期授权不自动派发',()=>assert.match(automaticDecision(s.p,botReview(s,r),r),/到期/))
 s.apply('set_review_policy',{nodeId:'main',policy:policy(3)});r=s.request();b=botReview(s,r);s.apply('set_review_policy',{nodeId:'main',policy:policy(2)});ok('提案后授权变化需重新复核',()=>assert.match(automaticDecision(s.p,b,r),/变化/))
 s.apply('set_review_policy',{nodeId:child.id,policy:policy(0)});ok('子节点可人工覆盖父级',()=>assert.equal(policyFor(s.p,child.id).policy.level,0))
 s.apply('inherit_review_policy',{nodeId:child.id});ok('可撤回单独设置并恢复继承',()=>assert.equal(policyFor(s.p,child.id).policy.level,2))
 s.apply('set_review_policy',{nodeId:child.id,policy:policy(0)})
 s.apply('set_review_policy',{nodeId:'main',policy:policy(3),subtree:true});ok('明确统一后代继承才清除覆盖',()=>{assert.equal(policyFor(s.p,child.id).policy.level,3);assert.equal(s.p.nodes.at(-1).reviewPolicy,undefined)})
 const pausedReq=s.request();await s.reviews.submit(pausedReq);s.apply('decide_review',{reviewId:pausedReq.commandId,decision:'approve'});s.apply('pause_branch',{nodeId:'main',paused:true});await s.reviews.tick()
 ok('暂停拦住已批准但尚未执行任务及后代',()=>{assert.equal(s.p.nodes.length,2);assert(policyFor(s.p,child.id).paused)})
 assert.throws(()=>s.store.prepareRemote(s.request({nodeId:child.id,parentId:child.id})),e=>e.code==='BRANCH_PAUSED');cases.push({name:'直接派发也受暂停门禁约束',status:'PASS'})
 s.apply('pause_branch',{nodeId:'main',paused:false});await s.reviews.tick();await poll(()=>s.store.run(s.p.reviews.find(v=>v.id===pausedReq.commandId).runId).terminalEvent)
 ok('人工恢复后继续同一已批准动作',()=>assert.equal(s.p.nodes.length,3))
 const auth=await scenario();auth.apply('prepare_context',{nodeId:'main',budget:20000});const sourceRequest=auth.request({operation:'turn',contextId:auth.p.contexts.at(-1).id,message:'来源轮次'}),source=auth.store.prepareRemote(sourceRequest);auth.store.reserveRemote(source.id);const key=randomUUID();auth.store.setProposalKey(source.id,key)
 await assert.rejects(auth.reviews.propose(auth.p.id,'main',source.id,randomUUID(),auth.request()),e=>e.code==='PROPOSAL_UNAUTHORIZED');cases.push({name:'错误凭证不能提出任务',status:'PASS'})
 await assert.rejects(auth.reviews.propose(auth.p.id,'other-node',source.id,key,auth.request()),e=>e.code==='PROPOSAL_TARGET');cases.push({name:'凭证不能用于其他节点',status:'PASS'})
 const proposed=await auth.reviews.propose(auth.p.id,'main',source.id,key,auth.request());ok('来源轮次未结束只排队',()=>assert.match(proposed.reason,/等待来源/))
 await assert.rejects(exportProject(auth.store,auth.p.id),e=>e.code==='ARCHIVE_ACTIVE_PROPOSAL');cases.push({name:'活动提案凭证不随导出流出',status:'PASS'})
 auth.store.updateRun(source.id,v=>{v.state='completed';v.terminalEvent=true});await auth.reviews.tick();ok('任务档来源结束后仍等待人工',()=>assert.equal(auth.p.reviews[0].status,'pending'))
 await assert.rejects(auth.reviews.propose(auth.p.id,'main',source.id,key,auth.request()),e=>e.code==='PROPOSAL_UNAUTHORIZED');cases.push({name:'来源结束凭证立即失效',status:'PASS'})
 const issued=await scenario('turnHold');issued.apply('prepare_context',{nodeId:'main',budget:20000});const actual=await issued.remote.submit(issued.request({operation:'turn',contextId:issued.p.contexts.at(-1).id,message:'模拟实际提案凭证签发'})),issuedKey=issued.store.run(actual.id).wireInput.match(/authorization=([a-f0-9-]+)/)[1];const actualProposal=await issued.reviews.propose(issued.p.id,'main',actual.id,issuedKey,issued.request());ok('真实派发链签发的当轮凭证可用且提案等待结束',()=>assert.match(actualProposal.reason,/等待来源/));await issued.remote.cancel(actual.id);await poll(()=>issued.store.run(actual.id).terminalEvent)
 auth.apply('set_review_policy',{nodeId:'main',policy:policy(3,{maxActions:1})});const fresh=auth.request();auth.store.enqueueReview(auth.p.id,'main',fresh,'bot',source.id);await auth.reviews.tick();await poll(()=>auth.store.run(auth.p.reviews.find(v=>v.id===fresh.commandId).runId).terminalEvent)
 const over=auth.request();auth.store.enqueueReview(auth.p.id,'main',over,'bot',source.id);await auth.reviews.tick();ok('自动动作额度真实拦截下一任务',()=>assert.match(auth.p.reviews.find(v=>v.id===over.commandId).reason,/额度/))
 // Simulate a crash after persisting the first turn, before reserving/sending it.
 const crash=await scenario(),cr=crash.request();crash.store.enqueueReview(crash.p.id,'main',cr,'human',null,true);let cp=crash.store.changeReview(crash.p.id,cr.commandId,(v,p)=>{v.status='dispatching';v.executedRequest={...v.request,expectedRevision:p.revision+1,reviewId:v.id}});const creator=await crash.remote.submit(cp.reviews[0].executedRequest),cc=crash.p.nodes.at(-1)
 crash.store.changeReview(crash.p.id,cr.commandId,(v,p)=>{v.status='created';v.childNodeId=cc.id;v.runId=creator.id;v.firstRequest={commandId:cc.task.initialTurnCommandId,projectId:p.id,nodeId:cc.id,operation:'turn',contextId:p.contexts.at(-1).id,message:cc.task.brief,reviewId:v.id,expectedRevision:p.revision+1}})
 crash.apply('set_importance',{nodeId:cc.id,importance:'high'});await crash.reviews.tick();ok('首轮前状态改变不盲目发送',()=>assert.equal(crash.p.reviews[0].status,'unknown'))
 await crash.reviews.recover(crash.p.id,cr.commandId);await poll(()=>crash.store.run(cc.task.initialTurnCommandId).terminalEvent);ok('人工恢复仅重定位未发送首轮，不新建聊天',()=>{assert.equal(crash.p.nodes.length,2);assert.equal(crash.p.reviews[0].runId,cc.task.initialTurnCommandId);assert.equal(crash.p.reviews[0].status,'completed')})
 assert.equal((await calls(crash,'thread/start')).length,1);assert.equal((await calls(crash,'turn/start')).length,1)
 const archived=await scenario();const ar=archived.request();archived.store.enqueueReview(archived.p.id,'main',ar,'human',null,true);const exported=await exportProject(archived.store,archived.p.id),restoredStore=new Store(resolve(dir,'restored.sqlite'));resources.push({store:restoredStore,remote:{close:async()=>{}}});const restored=await restoreProject(restoredStore,exported.path)
 ok('归档恢复不会复播原来已批准动作',()=>{assert.equal(restored.project.reviews[0].status,'pending');assert.equal(restored.project.reviews[0].humanApproved,false);assert.equal(restored.remoteReplay,false)})
 const failed=await scenario('turnStartReject'),failure=await failed.reviews.submit(failed.request(),true);ok('首轮明确失败保留子聊天与原请求',()=>{assert.equal(failure.review.status,'failed');assert.equal(failed.p.nodes.length,2);assert(failure.review.firstRequest)})
 await failed.reviews.recover(failed.p.id,failure.review.id);assert.equal((await calls(failed,'thread/start')).length,1);assert.equal((await calls(failed,'turn/start')).length,1);cases.push({name:'失败首轮恢复不换 ID 也不重复创建',status:'PASS'})
 const repo=await realpath(await mkdir(resolve(dir,'repo'),{recursive:true}).then(()=>resolve(dir,'repo')));await mkdir(resolve(repo,'src'));await writeFile(resolve(repo,'src/a.txt'),'baseline');const git=(...args)=>execFileSync('git',['-C',repo,...args],{windowsHide:true,encoding:'utf8'}).trim();git('init');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','fixture')
 const code=await scenario();code.apply('set_engineering',{repoPath:repo,baseCommit:git('rev-parse','HEAD'),contractVersion:'2',assignments:[{nodeId:'main',allowedPaths:['src/a.txt'],acceptance:['检查文件']}],verifications:[]});const delegated=await code.remote.submit(code.request({mode:'code',allowedPaths:['src/a.txt'],acceptance:['检查文件']})),codeChild=code.p.nodes.at(-1)
 ok('借出范围保留父登记，仅子任务范围有效',()=>{assert.equal(delegated.state,'completed');assert(code.p.engineering.assignments.some(a=>a.nodeId==='main'));assert.deepEqual(activeAssignments(code.p.engineering).map(a=>a.nodeId),[codeChild.id])})
 code.apply('prepare_context',{nodeId:'main',budget:20000});const parentTurn=await code.remote.submit(code.request({operation:'turn',contextId:code.p.contexts.at(-1).id,message:'父任务尝试写入'}));ok('借出期间父任务不绕过工程所有权',()=>{assert.equal(parentTurn.state,'failed');assert.match(parentTurn.error,/借出|交还/)})
 const held=code.store.prepareRemote(code.request({operation:'turn',nodeId:codeChild.id,contextId:code.p.contexts.filter(c=>c.nodeId===codeChild.id).at(-1).id,message:'未发送的子任务'}));ok('未结束轮次阻止归还范围',()=>assert.throws(()=>code.apply('release_scope',{nodeId:codeChild.id}),e=>e.code==='SCOPE_BUSY'))
 code.store.updateRun(held.id,v=>{v.state='interrupted';v.terminalEvent=true});code.apply('release_scope',{nodeId:codeChild.id});ok('归还后父任务登记恢复有效，子任务退出写入',()=>assert.deepEqual(activeAssignments(code.p.engineering).map(a=>a.nodeId),['main']))
 const report={status:'PASS',case_count:cases.length,cases,model_calls:0,production_chat_writes:0};await writeFile('../../evidence/governance-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}catch(e){console.error('Last completed case:',cases.at(-1)?.name);throw e}finally{for(const {remote,store} of resources){await remote.close();store.close()}await rm(dir,{recursive:true,force:true})}
