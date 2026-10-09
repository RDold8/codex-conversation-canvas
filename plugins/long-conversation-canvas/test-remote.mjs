import {build} from 'esbuild'
import {mkdtemp,mkdir,rm,realpath,readFile,writeFile} from 'node:fs/promises'
import {resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
await mkdir('../../runtime',{recursive:true});const root=await realpath('../../runtime'),dir=await mkdtemp(resolve(root,'remote-test-'))
const modulePath=resolve(dir,'remote.mjs')
await build({entryPoints:['src/remote.ts','src/connection.ts','src/store.ts'],bundle:true,splitting:true,platform:'node',format:'esm',target:'node24',outdir:dir,outExtension:{'.js':'.mjs'}})
const {RemoteManager}=await import(pathToFileURL(modulePath).href)
const {CodexConnection}=await import(pathToFileURL(resolve(dir,'connection.mjs')).href)
const {Store}=await import(pathToFileURL(resolve(dir,'store.mjs')).href)
const parentId='11111111-1111-4111-8111-111111111111'
const parent={id:parentId,status:{type:'idle'},turns:[1,2,3].map(i=>({id:'turn-'+i,status:'completed',items:[{id:'user-'+i,type:'userMessage',content:[{type:'text',text:`原文第${i}轮🧭\n保留空格  与标点。`}]},{id:'answer-'+i,type:'agentMessage',text:'助手候选'+i}]}))}
const cases=[],resources=[]
async function scenario(mode,{enabled=true,late=false,sessionScoped=false}={}){
 const id=randomUUID(),stateFile=resolve(dir,id+'.json');await writeFile(stateFile,JSON.stringify({mode,threads:{[parentId]:parent},calls:[],responses:[]}))
 const store=new Store(resolve(dir,id+'.sqlite'));store.importThread(parent,parentId)
 const anchor=store.anchors(parentId).find(a=>a.role==='user'),assistant=store.anchors(parentId).find(a=>a.role==='assistant')
 let p=store.create({commandId:randomUUID(),title:'远端协议测试',primaryThreadId:parentId,statements:[{text:'维持主干与原文',authority:'user',hard:true,anchorIds:[anchor.id]}]})
 function command(operation,payload){p=store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation,payload});return p}
 command('checkpoint',{nodeId:'main',anchorIds:[anchor.id],completedTurnIds:[anchor.turnId],decisions:[],unresolved:[],nextAction:'下一步'})
 command('build_context',{nodeId:'main',anchorIds:[anchor.id],packageIds:[],excluded:[],budget:20000});const contextId=p.contexts[0].id
 const connection=new CodexConnection(process.execPath,[resolve('tests/fake-app-server.mjs')],{...process.env,FAKE_APP_STATE:stateFile})
 if(late){const request=connection.request.bind(connection);connection.request=(method,params,opts={})=>request(method,params,{...opts,timeoutMs:method==='thread/fork'?40:3000})}
 const manager=new RemoteManager(store,connection,enabled,sessionScoped?{createConnection:()=>new CodexConnection(process.execPath,[resolve('tests/fake-app-server.mjs')],{...process.env,FAKE_APP_STATE:stateFile})}:{});resources.push({manager,store})
 return {store,manager,connection,stateFile,get project(){return store.get(p.id)},fork:()=>({commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,operation:'fork',nodeId:'main',lastTurnId:'turn-2',title:'真实接口形状的分支',scope:'检查代码'}),turn:()=>({commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,operation:'turn',nodeId:'main',contextId,message:'继续检查接口'}),command,assistant,contextId}
}
async function poll(check){for(let i=0;i<80;i++){if(check())return;await new Promise(r=>setTimeout(r,25))}throw Error('Fixture did not reach expected state')}
const state=async s=>JSON.parse(await readFile(s.stateFile,'utf8'))
function ok(name,fn){fn();cases.push({name,status:'PASS'})}
try{
 const gated=await scenario('forkGood',{enabled:false});await assert.rejects(gated.manager.submit(gated.fork()),e=>e.code==='HOST_GATE_PENDING');ok('原生门槛未验收时拒绝实际写动作',()=>assert.equal(gated.store.runs().length,0))
 const rejected=await scenario('turnStartReject',{sessionScoped:true}),rejectedRun=await rejected.manager.submit(rejected.turn())
 assert.equal(rejectedRun.state,'failed');assert.equal(rejectedRun.turnId,null)
 await rejected.manager.cancel(rejectedRun.id);await rejected.manager.recover(rejectedRun.id)
 ok('明确拒绝且未建轮次的请求不能被取消或核查降为未知',()=>{assert.equal(rejected.store.run(rejectedRun.id).state,'failed');assert.equal(rejected.store.run(rejectedRun.id).turnId,null)})
 const scoped=await scenario('turnHold',{sessionScoped:true});await scoped.manager.submit(scoped.fork())
 const scopedChild=scoped.project.nodes.find(n=>n.relation==='forked'),scopedTurn=await scoped.manager.submit(scoped.turn()),scopedFork=await scoped.manager.submit({...scoped.fork(),nodeId:scopedChild.id})
 ok('独立分叉连接退出不影响另一个活动轮次',()=>{assert.equal(scopedFork.state,'completed');assert.equal(scoped.store.run(scopedTurn.id).state,'running');assert(scoped.store.db.prepare("SELECT 1 FROM remote_events WHERE run_id=? AND method='connection/ownedSessionClosed'").get(scopedFork.id))})
 await scoped.manager.cancel(scopedTurn.id);await poll(()=>scoped.store.db.prepare("SELECT 1 FROM remote_events WHERE run_id=? AND method='connection/ownedSessionClosed'").get(scopedTurn.id))
 ok('独立续聊连接保持到取消终态且确认进程退出',()=>assert.equal(scoped.store.run(scopedTurn.id).state,'interrupted'))
 const fork=await scenario('forkGood');const input=fork.fork(),r=await fork.manager.submit(input)
 ok('分叉指定完成轮次并排除后续',()=>{assert.equal(r.state,'completed');const child=fork.project.nodes.find(n=>n.relation==='forked');assert(child);assert.equal(child.forkTurnId,'turn-2');assert.deepEqual(fork.store.anchors(child.threadId).map(a=>a.turnId),['turn-1','turn-1','turn-2','turn-2'])})
 const defaultChild=fork.project.nodes.find(n=>n.relation==='forked'),preparedFork=fork.store.apply({commandId:randomUUID(),projectId:fork.project.id,expectedRevision:fork.project.revision,operation:'prepare_context',payload:{nodeId:defaultChild.id,budget:20000}}),forkContext=preparedFork.contexts.at(-1)
 ok('新分叉可默认续聊且不会引用截止点之后原文',()=>{assert.equal(forkContext.nodeId,defaultChild.id);assert(forkContext.anchorIds.some(id=>fork.store.anchor(id).threadId===defaultChild.threadId&&fork.store.anchor(id).turnId==='turn-2'));assert(forkContext.anchorIds.every(id=>fork.store.anchor(id).turnId!=='turn-3'));assert.equal(forkContext.trunkRevisionId,defaultChild.trunkRevisionId)})
 const repeated=await fork.manager.submit(input);const forkState=await state(fork)
 ok('已核对的新分叉释放自己的写入连接且不触碰来源',()=>{const calls=forkState.calls.filter(c=>c.method==='thread/unsubscribe');assert.equal(calls.length,1);assert.equal(calls[0].params.threadId,r.threadId);assert.notEqual(calls[0].params.threadId,parentId)})
 const releaseFailure=await scenario('forkReleaseFail');const releaseFailureRun=await releaseFailure.manager.submit(releaseFailure.fork())
 ok('释放失败保留已建立分支和显式故障记录',()=>{assert.equal(releaseFailureRun.state,'completed');assert(releaseFailure.store.db.prepare("SELECT 1 FROM remote_events WHERE run_id=? AND method='thread/ownershipReleaseFailed'").get(releaseFailureRun.id))})
 ok('远端重复命令不重复建聊天',()=>{assert.equal(repeated.id,r.id);assert.equal(forkState.calls.filter(c=>c.method==='thread/fork').length,1);assert.equal(forkState.calls.find(c=>c.method==='thread/fork').params.deferGoalContinuation,true)})
 await assert.rejects(fork.manager.submit({...input,title:'其他请求'}),e=>e.code==='COMMAND_REUSED');cases.push({name:'远端命令ID碰撞拒绝',status:'PASS'})
 const bad=await scenario('forkBad');const badInput=bad.fork(),badResult=await bad.manager.submit(badInput)
 ok('混入分叉点之后的记录拒绝绑定',()=>{assert.equal(badResult.state,'unknown');assert.equal(bad.project.nodes.length,1);assert(badResult.threadId)})
 await bad.manager.submit(badInput);ok('未知分叉不自动重发',()=>assert.equal(bad.store.runs().length,1))
 const late=await scenario('forkLate',{late:true});const lateResult=await late.manager.submit(late.fork());assert.equal(lateResult.state,'unknown')
 await poll(()=>late.store.run(lateResult.id).state==='completed');ok('迟到响应可核实且只绑定一次',()=>assert.equal(late.project.nodes.length,2))
 const lost=await scenario('forkDropKnown');const lostInput=lost.fork(),lostRun=await lost.manager.submit(lostInput);assert.equal(lostRun.state,'unknown');assert(lostRun.threadId)
 const recovered=await lost.manager.recover(lostRun.id);ok('响应丢失通过已记录新聊天ID恢复',()=>assert.equal(recovered.state,'completed'))
 const noId=await scenario('forkDropNoId');const noIdRun=await noId.manager.submit(noId.fork());assert.equal(noIdRun.state,'unknown')
 await assert.rejects(noId.manager.recover(noIdRun.id),e=>e.code==='FORK_RECOVERY_REQUIRED');cases.push({name:'分叉ID丢失不猜测或重复创建',status:'PASS'})
 const fast=await scenario('turnBeforeReply');const turnRequest={...fast.turn(),model:'fixture-model',effort:'high',skills:[{name:'fixture-skill',path:'D:/isolated/skill/SKILL.md'}]},fastRun=await fast.manager.submit(turnRequest)
 await poll(()=>fast.store.run(fastRun.id).terminalEvent)
 ok('完成事件先到不会被开始响应降级',()=>assert.equal(fast.store.run(fastRun.id).state,'completed'))
 const wire=(await state(fast)).calls.find(c=>c.method==='turn/start').params
 ok('选择模型推理和技能传至指定轮次',()=>{assert.equal(wire.model,'fixture-model');assert.equal(wire.effort,'high');assert.deepEqual(wire.input[1],{type:'skill',name:'fixture-skill',path:'D:/isolated/skill/SKILL.md'})})
 ok('发送指定聊天与精确上下文并保存清单',()=>{assert.equal(wire.threadId,parentId);assert.equal(wire.clientUserMessageId,fastRun.id);assert.equal(wire.input[0].text,fast.store.run(fastRun.id).wireInput);assert(wire.input[0].text.includes(fast.project.contexts[0].text))})
 await fast.manager.submit(turnRequest);ok('重复续聊命令不重复启动',()=>assert.equal(fast.store.runs().length,1))
 const held=await scenario('turnHold');const heldRun=await held.manager.submit(held.turn());assert.equal(heldRun.state,'running')
 await assert.rejects(held.manager.submit(held.turn()),e=>e.code==='TARGET_BUSY');cases.push({name:'活动目标拒绝并发续聊',status:'PASS'})
 const cancelled=await held.manager.cancel(heldRun.id);ok('取消应答不冒充轮次结束',()=>{assert.equal(cancelled.cancelRequested,true);assert.equal(cancelled.terminalEvent,false)})
 await poll(()=>held.store.run(heldRun.id).terminalEvent);ok('收到中断结束事件后标记中断',()=>assert.equal(held.store.run(heldRun.id).state,'interrupted'))
 await poll(()=>held.store.db.prepare("SELECT 1 FROM remote_events WHERE run_id=? AND method='thread/subscriptionReleased'").get(heldRun.id))
 ok('活动轮次保留连接直到中断终态再释放',()=>{const methods=held.store.db.prepare('SELECT method FROM remote_events WHERE run_id=? ORDER BY rowid').all(heldRun.id).map(x=>x.method);assert(methods.indexOf('thread/subscriptionReleased')>methods.indexOf('turn/completed'))})
 const approval=await scenario('turnApproval');const approvalRun=await approval.manager.submit(approval.turn())
 await poll(()=>approval.store.runViews()[0].pendingRequests.length===1)
 ok('审批请求保留且不会自动接受',()=>assert.equal(approval.store.run(approvalRun.id).state,'awaiting_user'))
 approval.manager.respond(approvalRun.id,900,{decision:'accept'});await poll(()=>approval.store.run(approvalRun.id).terminalEvent)
 ok('显式用户回应走原连接',()=>assert.equal(approval.store.run(approvalRun.id).state,'completed'))
 const earlyApproval=await scenario('turnApprovalBeforeReply');const earlyRun=await earlyApproval.manager.submit(earlyApproval.turn())
 ok('审批事件先到时启动响应保留等待状态',()=>assert.equal(earlyRun.state,'awaiting_user'))
 assert.throws(()=>earlyApproval.manager.respond(earlyRun.id,900,{decision:'acceptForSession'}));cases.push({name:'拒绝扩大为整会话批准',status:'PASS'})
 earlyApproval.manager.respond(earlyRun.id,900,{decision:'decline'});await poll(()=>earlyApproval.store.run(earlyRun.id).terminalEvent)
 const inputCase=await scenario('turnUserInput');const inputRun=await inputCase.manager.submit(inputCase.turn());await poll(()=>inputCase.store.runViews()[0].pendingRequests.length===1)
 assert.throws(()=>inputCase.manager.respond(inputRun.id,901,{answers:{other:{answers:['检查']}}}),e=>e.code==='INPUT_MISSING');cases.push({name:'输入必须对应原问题ID',status:'PASS'})
 inputCase.manager.respond(inputRun.id,901,{answers:{direction:{answers:['检查']}}});await poll(()=>inputCase.store.run(inputRun.id).terminalEvent)
 ok('问题回答回到原请求连接',()=>assert.equal(inputCase.store.run(inputRun.id).state,'completed'))
 // Use a live fixture record to prove resolving one request cannot hide another.
 const pendingRun=await scenario('turnHold');const pending=await pendingRun.manager.submit(pendingRun.turn())
 pendingRun.store.pendingRequest(pending.id,902,'fixture/pending',{});pendingRun.store.pendingRequest(pending.id,903,'fixture/pending',{});pendingRun.store.resolveRequest(pending.id,902)
 ok('多项待处理请求保留等待状态',()=>assert.equal(pendingRun.store.run(pending.id).state,'awaiting_user'))
 const comp=await scenario('turnCompaction');const cp=comp.project.checkpoints[0]
 comp.command('rebuild_segment',{nodeId:'main',contextId:comp.contextId,checkpointId:cp.id})
 const compRun=await comp.manager.submit(comp.turn());await poll(()=>comp.store.run(compRun.id).terminalEvent)
 ok('宿主压缩观察去重并冻结主动压缩',()=>{assert.equal(comp.store.runViews()[0].observedCompactions,1);assert.equal(comp.project.segments[0].history,'unknown');assert(comp.project.segments[0].cooling)})
 const drop=await scenario('turnDrop');const dropRequest=drop.turn(),dropped=await drop.manager.submit(dropRequest);assert.equal(dropped.state,'unknown')
 const recoveredTurn=await drop.manager.recover(dropped.id)
 ok('断线恢复凭精确已发送消息定位且不重发',()=>{assert(recoveredTurn.turnId);assert.equal(recoveredTurn.state,'unknown');assert.equal(drop.store.runs().length,1)})
 const afterDrop=await state(drop);ok('恢复操作未再次调用turn/start',()=>assert.equal(afterDrop.calls.filter(c=>c.method==='turn/start').length,1))
 const lineage=await scenario('forkGood');const cp2=lineage.project.checkpoints[0]
 lineage.command('rebuild_segment',{nodeId:'main',contextId:lineage.contextId,checkpointId:cp2.id})
 lineage.command('compress_context',{segmentId:lineage.project.segments[0].id,contextId:lineage.contextId,checkpointId:cp2.id,summary:'依据原文整理',status:'completed'})
 await lineage.manager.submit(lineage.fork());const original=lineage.project.segments[0],inherited=lineage.project.segments[1]
 ok('分叉继承压缩谱系与冷却不清零',()=>{assert.equal(inherited.lineageId,original.lineageId);assert.equal(inherited.compressions,1);assert.equal(inherited.cooling,true)})
 const goalFork=await scenario('forkGoal'),goalRun=await goalFork.manager.submit(goalFork.fork()),goalState=await state(goalFork)
 ok('分叉清除复制的自动目标并保留主对话目标',()=>{assert.equal(goalRun.state,'completed');assert.equal(goalState.goals[goalRun.threadId],null);assert.equal(goalState.goals[parentId].status,'active');assert.deepEqual(goalState.calls.filter(c=>c.method==='thread/goal/clear').map(c=>c.params.threadId),[goalRun.threadId]);assert.equal(goalState.calls.find(c=>c.method==='thread/fork').params.deferGoalContinuation,true)})
 const goalFail=await scenario('forkGoalClearFail'),failedGoalRun=await goalFail.manager.submit(goalFail.fork())
 ok('分支自动目标清除失败不附加节点且保留远端ID',()=>{assert.equal(failedGoalRun.state,'unknown');assert(failedGoalRun.threadId);assert.equal(goalFail.project.nodes.length,1)})
 goalFail.manager.enabled=false
 await assert.rejects(goalFail.manager.recover(failedGoalRun.id),e=>e.code==='HOST_GATE_PENDING')
 ok('写动作关闭时恢复不会清除分支目标',()=>assert.equal(goalFail.project.nodes.length,1))
 goalFail.manager.enabled=true
 const recoveredGoal=await goalFail.manager.recover(failedGoalRun.id),recoveredState=await state(goalFail)
 ok('目标隔离恢复只核查原分叉不再新建聊天',()=>{assert.equal(recoveredGoal.state,'completed');assert.equal(goalFail.project.nodes.length,2);assert.equal(recoveredState.calls.filter(c=>c.method==='thread/fork').length,1);assert.equal(recoveredState.goals[parentId].status,'active')})
 const code=await scenario('turnBeforeReply'),repo=resolve(dir,'code-repo');await mkdir(repo);await writeFile(resolve(repo,'source.txt'),'code fixture\n')
 const git=(...args)=>execFileSync('git',['-c','user.name=Isolated remote fixture','-c','user.email=fixture@localhost','-c','core.autocrlf=false','-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim()
 git('init','-q');git('add','.');git('commit','-qm','isolated code baseline')
 code.command('set_engineering',{repoPath:repo,baseCommit:git('rev-parse','HEAD'),contractVersion:'2',assignments:[{nodeId:'main',allowedPaths:['source.txt'],acceptance:['核对代码范围']}],verifications:[]})
 const codeRun=await code.manager.submit(code.turn());await poll(()=>Boolean(code.store.db.prepare("SELECT id FROM remote_events WHERE run_id=? AND method='engineering/after'").get(codeRun.id)))
 const codeWire=(await state(code)).calls.find(c=>c.method==='turn/start')
 ok('代码续聊实际核对工程并使用所绑定仓库',()=>{assert.equal(codeWire.params.cwd,repo);assert(codeWire.params.input[0].text.includes('允许修改：source.txt'));assert.equal(code.store.run(codeRun.id).state,'completed')})
 await writeFile(resolve(repo,'outside.txt'),'scope violation');const outOfScope=await code.manager.submit(code.turn())
 ok('越界工程在远端续聊发出前拒绝',()=>{assert.equal(outOfScope.state,'failed');assert(outOfScope.error.includes('超出'));assert.equal(code.store.run(outOfScope.id).wireInput,null)})
 const report={status:'PASS',case_count:cases.length,cases,source:'isolated subprocess App Server protocol fixture; no actual forks or generations',model_calls:0,codex_chat_writes:0,live_native_actions_verified:false}
 await writeFile('../../evidence/remote-protocol-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'PASS',case_count:cases.length,model_calls:0,codex_chat_writes:0}))
}finally{
 for(const r of resources)r.manager.close()
 // Allow rejected transport promises to settle before closing their SQLite stores.
 await new Promise(r=>setTimeout(r,50));for(const r of resources)r.store.close()
 const target=await realpath(dir);assert(!relative(root,target).startsWith('..'));await rm(target,{recursive:true,force:true})
}
