import {DatabaseSync} from 'node:sqlite'
import {createHash,randomUUID} from 'node:crypto'
import {mkdirSync} from 'node:fs'
import {dirname,isAbsolute,normalize} from 'node:path'
import {z} from 'zod'
import {CommandSchema,CreateSchema,ProjectSchema,SCHEMA_VERSION,RunSchema,RemoteRequestSchema,VerificationSchema,ReviewSchema,type Review,type Verification,type Project,type StatementType,type Command,type Run,type RunView} from './schema'
import {policyFor,lineage,activeAssignments} from './governance'
const now=()=>new Date().toISOString()
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex')
export class PolicyError extends Error{constructor(public code:string,message:string){super(message)}}
function fail(code:string,message:string):never{throw new PolicyError(code,message)}
const ThreadSchema=z.object({id:z.string().uuid(),turns:z.array(z.object({id:z.string().min(1),status:z.string(),items:z.array(z.object({id:z.string().min(1),type:z.string()}).passthrough())}).passthrough()).default([])}).passthrough()
export type Anchor={id:string,threadId:string,turnId:string,itemId:string,role:string,order:number,text:string,sha256:string,turnStatus:string,raw:string}
export class Store{
 readonly db:DatabaseSync
 constructor(readonly path:string){
  mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path)
  if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()){
   const existing=this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')
   if(existing&&existing.value!==String(SCHEMA_VERSION)){this.db.close();fail('SCHEMA_MISMATCH','存储 schema 版本不兼容，禁止覆盖')}
  }
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,document TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS raw_reads(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,read_at TEXT NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS anchors(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,item_id TEXT NOT NULL,role TEXT NOT NULL,ordinal INTEGER NOT NULL,body TEXT NOT NULL,text TEXT NOT NULL,sha256 TEXT NOT NULL,turn_status TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS anchor_observations(id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL,read_id TEXT NOT NULL,turn_status TEXT NOT NULL,ordinal INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS anchor_observations_anchor ON anchor_observations(anchor_id);
   CREATE TABLE IF NOT EXISTS remote_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,document TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS remote_events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,method TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS remote_requests(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,rpc_id TEXT NOT NULL,method TEXT NOT NULL,params TEXT NOT NULL,resolved INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS verification_runs(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,document TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS verification_logs(id TEXT PRIMARY KEY,verification_id TEXT NOT NULL,step_index INTEGER NOT NULL,body_base64 TEXT NOT NULL,sha256 TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,revision INTEGER NOT NULL,command_id TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);`)
  const version=this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')
  if(version&&version.value!==String(SCHEMA_VERSION))fail('SCHEMA_MISMATCH','存储 schema 版本不兼容，禁止覆盖')
  this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run('schema_version',String(SCHEMA_VERSION))
 }
 close(){this.db.close()}
 private transaction<T>(work:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const value=work();this.db.exec('COMMIT');return value}catch(e){this.db.exec('ROLLBACK');throw e}}
 importThread(input:unknown,expectedId:string){
  const thread=ThreadSchema.parse(input);if(thread.id!==expectedId)fail('THREAD_MISMATCH','返回的聊天 ID 不匹配')
  return this.transaction(()=>{
   const raw=JSON.stringify(input),readId=randomUUID()
   this.db.prepare('INSERT INTO raw_reads VALUES(?,?,?,?,?)').run(readId,thread.id,now(),raw,hash(raw))
   let order=0
   for(const turn of thread.turns){for(const item of turn.items){
    const body=JSON.stringify(item),digest=hash(body),anchorId=`${thread.id}:${turn.id}:${item.id}:${digest}`
    let text='',role=item.type
    if(item.type==='userMessage'){
     const content=z.array(z.object({type:z.string(),text:z.string().optional()}).passthrough()).parse(item.content)
     text=content.filter(c=>c.type==='text').map(c=>c.text??'').join('\n');role='user'
    }else if(item.type==='agentMessage'){text=z.string().parse(item.text);role='assistant'}
    else text=body
    this.db.prepare('INSERT OR IGNORE INTO anchors VALUES(?,?,?,?,?,?,?,?,?,?)').run(anchorId,thread.id,turn.id,item.id,role,order,body,text,digest,turn.status)
    this.db.prepare('INSERT INTO anchor_observations VALUES(?,?,?,?,?)').run(randomUUID(),anchorId,readId,turn.status,order++)
   }}
   return {readId,threadId:thread.id,turnCount:thread.turns.length,historyComplete:'unknown' as const,hostCompressionHistory:'unknown' as const}
  })
 }
 private anchorQuery=`SELECT a.*,COALESCE((SELECT o.turn_status FROM anchor_observations o JOIN raw_reads r ON r.id=o.read_id WHERE o.anchor_id=a.id ORDER BY r.read_at DESC,r.rowid DESC,o.rowid DESC LIMIT 1),a.turn_status) AS observed_status FROM anchors a`
 private toAnchor(r:Record<string,unknown>):Anchor{return {id:String(r.id),threadId:String(r.thread_id),turnId:String(r.turn_id),itemId:String(r.item_id),role:String(r.role),order:Number(r.ordinal),text:String(r.text),sha256:String(r.sha256),turnStatus:String(r.observed_status),raw:String(r.body)}}
 anchors(threadId:string):Anchor[]{return this.db.prepare(this.anchorQuery+' WHERE a.thread_id=? ORDER BY a.ordinal,a.rowid').all(threadId).map(r=>this.toAnchor(r))}
 anchor(id:string):Anchor{const r=this.db.prepare(this.anchorQuery+' WHERE a.id=?').get(id);if(!r)fail('SOURCE_MISSING','原文锚点不存在');return this.toAnchor(r)}
 list():Project[]{return this.db.prepare('SELECT document FROM projects ORDER BY rowid DESC').all().map(r=>ProjectSchema.parse(JSON.parse(String(r.document))))}
 get(id:string):Project{const row=this.db.prepare('SELECT document FROM projects WHERE id=?').get(id);if(!row)fail('PROJECT_MISSING','任务不存在');return ProjectSchema.parse(JSON.parse(String(row.document)))}
 runs():Run[]{return this.db.prepare('SELECT document FROM remote_runs ORDER BY rowid DESC').all().map(r=>RunSchema.parse(JSON.parse(String(r.document))))}
 verifications():Verification[]{return this.db.prepare('SELECT document FROM verification_runs ORDER BY rowid DESC').all().map(r=>VerificationSchema.parse(JSON.parse(String(r.document))))}
 verification(id:string):Verification{const row=this.db.prepare('SELECT document FROM verification_runs WHERE id=?').get(id);if(!row)fail('VERIFICATION_MISSING','验证记录不存在');return VerificationSchema.parse(JSON.parse(String(row.document)))}
 saveVerification(record:Verification){return this.transaction(()=>{VerificationSchema.parse(record);if(this.get(record.projectId).revision!==record.request.expectedRevision)fail('REVISION_CONFLICT','任务已改变，先刷新工程与验收条件');if(this.verifications().some(r=>r.status==='running'&&r.repoPath.toLowerCase()===record.repoPath.toLowerCase()))fail('VERIFICATION_BUSY','同一仓库已有正在执行的验证，请等待或取消原验证');this.db.prepare('INSERT INTO verification_runs VALUES(?,?,?)').run(record.id,record.requestHash,JSON.stringify(record));return record})}
 updateVerification(id:string,change:(report:Verification)=>void){return this.transaction(()=>{const report=this.verification(id);change(report);report.updatedAt=now();VerificationSchema.parse(report);this.db.prepare('UPDATE verification_runs SET document=? WHERE id=?').run(JSON.stringify(report),id);return report})}
 saveVerificationLog(id:string,index:number,body:Buffer){this.db.prepare('INSERT INTO verification_logs VALUES(?,?,?,?,?)').run(`${id}:${index}`,id,index,body.toString('base64'),hash(body.toString('base64')))}
 verificationLog(id:string,index:number){const row=this.db.prepare('SELECT * FROM verification_logs WHERE verification_id=? AND step_index=?').get(id,index);if(!row)fail('VERIFICATION_LOG_MISSING','完整验证日志不存在');const bytes=Buffer.from(String(row.body_base64),'base64');if(hash(bytes.toString('base64'))!==row.sha256)fail('VERIFICATION_LOG_HASH','日志校验失败');return {text:bytes.toString('utf8'),bodyBase64:bytes.toString('base64'),bytes:bytes.length}}
 sourcePage(threadId:string,cursor?:string,limit=100){
  let namespace=this.db.prepare('SELECT value FROM meta WHERE key=?').get('source_cursor_namespace')?.value
  if(!namespace){namespace=randomUUID();this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('source_cursor_namespace',namespace);namespace=this.db.prepare('SELECT value FROM meta WHERE key=?').get('source_cursor_namespace')!.value}
  const Cursor=z.object({namespace:z.string(),threadId:z.string().uuid(),maxRow:z.number().int().nonnegative(),row:z.number().int().positive()}).strict()
  const boundary=cursor?Cursor.parse(JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'))):null
  if(boundary&&(boundary.namespace!==namespace||boundary.threadId!==threadId))fail('SOURCE_CURSOR','分页位置不属于当前存储或聊天，请重新读取')
  const maxRow=boundary?.maxRow??Number(this.db.prepare('SELECT max(rowid) n FROM anchors WHERE thread_id=?').get(threadId)?.n??0)
  const filter=" WHERE a.thread_id=? AND a.rowid<=? AND a.role IN ('user','assistant')",params:(string|number)[]=[threadId,maxRow]
  const cutoff=boundary?' AND a.rowid<?':''
  if(boundary)params.push(boundary.row)
  const rows=this.db.prepare(this.anchorQuery.replace('SELECT a.*','SELECT a.rowid AS archive_row,a.*')+filter+cutoff+' ORDER BY a.rowid DESC LIMIT ?').all(...params,limit)
  const last=rows.at(-1),remainingCount=last?Number(this.db.prepare("SELECT count(*) n FROM anchors a"+filter+' AND a.rowid<?').get(threadId,maxRow,last.archive_row)?.n??0):0
  const nextCursor=last&&remainingCount?Buffer.from(JSON.stringify({namespace,threadId,maxRow,row:Number(last.archive_row)})).toString('base64url'):null
  return {threadId,anchors:rows.reverse().map(r=>this.toAnchor(r)),nextCursor,remainingCount,omittedCount:remainingCount,snapshotMaxRow:maxRow}
 }
 run(id:string):Run{const row=this.db.prepare('SELECT document FROM remote_runs WHERE id=?').get(id);if(!row)fail('RUN_MISSING','运行记录不存在');return RunSchema.parse(JSON.parse(String(row.document)))}
 runViews():RunView[]{return this.runs().map(({requestHash,request,result,wireInput,...run})=>({...run,pendingRequests:this.db.prepare('SELECT rpc_id,method,params FROM remote_requests WHERE run_id=? AND resolved=0').all(run.id).map(r=>({id:JSON.parse(String(r.rpc_id)),method:String(r.method),params:JSON.parse(String(r.params))})),observedCompactions:Number(this.db.prepare("SELECT count(*) AS n FROM remote_events WHERE run_id=? AND method='host/compactionObserved'").get(run.id)?.n??0)}))}
 prepareRemote(input:unknown):Run{
  const request=RemoteRequestSchema.parse(input),requestHash=hash(JSON.stringify(request))
  return this.transaction(()=>{
   const prior=this.db.prepare('SELECT document,request_hash FROM remote_runs WHERE id=?').get(request.commandId)
   if(prior){if(prior.request_hash!==requestHash)fail('COMMAND_REUSED','该远端命令 ID 已被不同请求使用');return RunSchema.parse(JSON.parse(String(prior.document)))}
   const p=this.get(request.projectId);if(p.revision!==request.expectedRevision)fail('REVISION_CONFLICT','任务已改变，先刷新来源')
   const node=this.node(p,request.nodeId)
   if(policyFor(p,node.id).paused)fail('BRANCH_PAUSED','分支已暂停；先人工恢复，不能继续派发')
   if(request.operation!=='fork'&&request.reviewId){const review=p.reviews?.find(r=>r.id===request.reviewId);if(!review||!['dispatching','created'].includes(review.status))fail('REVIEW_REQUIRED','复核记录不允许派发')}
   if(this.runs().some(r=>['prepared','dispatching','running','awaiting_user','unknown'].includes(r.state)&&r.sourceThreadId===node.threadId))fail('TARGET_BUSY','目标聊天已有未结束或状态未知的操作，先核查它')
   if(request.operation==='turn'){
    const context=p.contexts.find(c=>c.id===request.contextId)
    if(!context||context.nodeId!==node.id||context.trunkRevisionId!==node.trunkRevisionId)fail('CONTEXT_STALE','上下文不属于当前节点或其主干版本')
   }else if(request.operation==='delegate'){this.delegationContext(request);this.node(p,request.parentId);if(request.mode==='code'&&(!p.engineering||!request.allowedPaths.length||!request.acceptance.length))fail('ENGINEERING_UNASSIGNED','代码子任务必须指定已绑定仓库、允许路径和验收条件')}else if(!this.anchors(node.threadId).some(a=>a.turnId===request.lastTurnId&&a.turnStatus==='completed'))fail('FORK_POINT','分叉点需要已读取的完成轮次')
   const run:Run={id:request.commandId,projectId:p.id,nodeId:node.id,operation:request.operation,requestHash,request,sourceThreadId:node.threadId,threadId:request.operation==='turn'?node.threadId:null,turnId:null,trunkRevisionId:node.trunkRevisionId,state:'prepared',error:null,createdAt:now(),updatedAt:now(),result:null,wireInput:null,terminalEvent:false,cancelRequested:false,ownerPid:null}
   this.db.prepare('INSERT INTO remote_runs VALUES(?,?,?)').run(run.id,requestHash,JSON.stringify(run));return run
  })
 }
 updateRun(id:string,change:(run:Run)=>void):Run{return this.transaction(()=>{const run=this.run(id);change(run);run.updatedAt=now();RunSchema.parse(run);this.db.prepare('UPDATE remote_runs SET document=? WHERE id=?').run(JSON.stringify(run),id);return run})}
 reserveRemote(id:string):Run{return this.updateRun(id,run=>{if(run.state!=='prepared')fail('RUN_ALREADY_DISPATCHED','操作已派发，禁止自动重复发送');run.state='dispatching';run.ownerPid=process.pid})}
 event(runId:string,method:string,body:unknown){this.db.prepare('INSERT INTO remote_events VALUES(?,?,?,?,?)').run(randomUUID(),runId,method,JSON.stringify(body),now())}
 pendingRequest(runId:string,id:number|string,method:string,params:Record<string,unknown>){this.db.prepare('INSERT INTO remote_requests VALUES(?,?,?,?,?,0)').run(randomUUID(),runId,JSON.stringify(id),method,JSON.stringify(params));this.updateRun(runId,r=>{if(!r.terminalEvent)r.state='awaiting_user'})}
 resolveRequest(runId:string,id:number|string){this.db.prepare('UPDATE remote_requests SET resolved=1 WHERE run_id=? AND rpc_id=?').run(runId,JSON.stringify(id));const remaining=this.db.prepare('SELECT count(*) AS n FROM remote_requests WHERE run_id=? AND resolved=0').get(runId);this.updateRun(runId,r=>{if(!r.terminalEvent)r.state=Number(remaining?.n)?'awaiting_user':'running'})}
 noteCompaction(runId:string,params:unknown){
  const itemId=(params as any)?.item?.id
  if(typeof itemId==='string'&&this.db.prepare("SELECT body FROM remote_events WHERE run_id=? AND method='host/compactionObserved'").all(runId).some(row=>JSON.parse(String(row.body))?.item?.id===itemId))return
  const run=this.run(runId);this.event(runId,'host/compactionObserved',params)
  this.transaction(()=>{const p=this.get(run.projectId);for(const s of p.segments.filter(s=>s.nodeId===run.nodeId)){s.history='unknown';s.cooling=true}p.revision++;p.updatedAt=now();this.db.prepare('UPDATE projects SET revision=?,document=? WHERE id=?').run(p.revision,JSON.stringify(ProjectSchema.parse(p)),p.id)})
 }
 attachFork(runId:string,threadId:string):Project{return this.transaction(()=>{
  const run=this.run(runId);if(run.operation!=='fork'||run.request.operation!=='fork')fail('RUN_OPERATION','该记录不是分叉操作')
  const p=this.get(run.projectId),parent=this.node(p,run.nodeId)
  const existing=p.nodes.find(n=>n.threadId===threadId)
  if(existing){if(existing.relation==='forked'&&existing.parentId===run.nodeId&&existing.forkTurnId===run.request.lastTurnId)return p;fail('THREAD_ALREADY_BOUND','目标聊天已经绑定到其他节点')}
  this.assertRead(threadId)
  const id=randomUUID();p.nodes.push({id,title:run.request.title,kind:'branch',threadId,parentId:parent.id,trunkRevisionId:run.trunkRevisionId,scope:run.request.scope,status:'active',forkTurnId:run.request.lastTurnId,relation:'forked',x:parent.x+330,y:parent.y+(p.nodes.filter(n=>n.parentId===parent.id).length+1)*180});p.edges.push({id:randomUUID(),source:parent.id,target:id,kind:'branch_from'})
  const lineage=p.segments.filter(s=>s.nodeId===parent.id).at(-1)
  if(lineage){const child=this.anchors(threadId),mapped=lineage.rawAnchorIds.flatMap(a=>{const source=this.anchor(a);const target=child.find(c=>c.itemId===source.itemId&&c.turnId===source.turnId&&c.sha256===source.sha256);return target?[target.id]:[]});if(!child.length)fail('FORK_HISTORY_EMPTY','分叉历史尚未可读，不能绑定');p.segments.push({...lineage,id:randomUUID(),nodeId:id,rawAnchorIds:mapped.length?mapped:[child[0].id],history:mapped.length&&lineage.history==='known'?'known':'unknown',lastCheckpointId:null,rebuiltFromRaw:false})}
  p.revision++;p.updatedAt=now();this.db.prepare('UPDATE projects SET revision=?,document=? WHERE id=?').run(p.revision,JSON.stringify(ProjectSchema.parse(p)),p.id)
  this.event(run.id,'fork/bound',{threadId,nodeId:id});return p
 })}
 delegationContext(input:unknown){
  const request=RemoteRequestSchema.parse(input);if(request.operation!=='delegate')fail('RUN_OPERATION','需要子任务请求')
  const p=this.get(request.projectId),source=this.node(p,request.nodeId)
  this.ownedAnchors(p,source.id,request.anchorIds)
  const value=this.context(p,source.id,request.anchorIds,request.packageIds,request.budget)
  const text=`${value.text}\n\n[子任务范围] ${request.scope}\n[任务说明] ${request.task}`,count=[...text].length
  if(count>request.budget)fail('CONTEXT_BUDGET','任务说明与必要来源超过预算，请缩小来源范围')
  return {...value,text,count}
 }
 attachDelegate(runId:string,threadId:string):Project{return this.transaction(()=>{
  const run=this.run(runId),request=run.request;if(request.operation!=='delegate')fail('RUN_OPERATION','不是子任务创建')
  const p=this.get(run.projectId),source=this.node(p,request.nodeId),parent=this.node(p,request.parentId),existing=p.nodes.find(n=>n.threadId===threadId)
  if(existing){if(existing.relation==='delegated'&&existing.task?.creationRunId===run.id)return p;fail('THREAD_ALREADY_BOUND','聊天已绑定其他任务')}
  if(p.revision!==request.expectedRevision)fail('REVISION_CONFLICT','创建期间任务归属或工程发生变化；新聊天已保留，先核查，不重新创建')
  this.assertRead(threadId)
  if(threadId===source.threadId||this.anchors(threadId).length)fail('DELEGATE_HISTORY','子聊天必须为空，不能冒充独立任务')
  const value=this.delegationContext(request),id=randomUUID(),createdAt=now()
  p.nodes.push({id,title:request.title,kind:'branch',threadId,parentId:parent.id,originParentId:source.id,trunkRevisionId:source.trunkRevisionId,scope:request.scope,status:'active',forkTurnId:null,relation:'delegated',task:{brief:request.task,mode:request.mode,originNodeId:source.id,sourceAnchorIds:[...new Set(request.anchorIds)],sourcePackageIds:request.packageIds,createdAt,creationRunId:run.id,initialTurnCommandId:randomUUID()},topic:request.topic,importance:request.topic?'high':'normal',x:parent.x+330,y:parent.y+(p.nodes.filter(n=>n.parentId===parent.id).length+1)*180})
  p.edges.push({id:randomUUID(),source:parent.id,target:id,kind:'branch_from'})
  if(source.id!==parent.id)p.edges.push({id:randomUUID(),source:source.id,target:id,kind:'reference'})
  p.contexts.push({id:randomUUID(),nodeId:id,trunkRevisionId:source.trunkRevisionId,anchorIds:value.anchorIds,packageIds:request.packageIds,excluded:[],budget:request.budget,text:value.text,codePoints:value.count,createdAt})
  if(request.mode==='code'){
   const engineering=p.engineering;if(!engineering)fail('ENGINEERING_MISSING','代码任务缺少工程基线')
   engineering.leases??=[];engineering.leases.push({id:randomUUID(),sourceNodeId:source.id,childNodeId:id,state:'active',createdAt})
   engineering.assignments.push({nodeId:id,allowedPaths:request.allowedPaths,acceptance:request.acceptance})
  }
  p.revision++;p.updatedAt=now();this.db.prepare('UPDATE projects SET revision=?,document=? WHERE id=?').run(p.revision,JSON.stringify(ProjectSchema.parse(p)),p.id)
  this.event(run.id,'delegate/bound',{threadId,nodeId:id,parentId:parent.id,originNodeId:source.id});return p
 })}
 changeReview(projectId:string,reviewId:string,change:(review:Review,project:Project)=>void):Project{return this.transaction(()=>{const p=this.get(projectId),review=p.reviews?.find(r=>r.id===reviewId);if(!review)fail('REVIEW_MISSING','复核记录不存在');const before=JSON.stringify(review);change(review,p);if(JSON.stringify(review)===before)return p;review.updatedAt=now();ReviewSchema.parse(review);p.revision++;p.updatedAt=now();this.db.prepare('UPDATE projects SET revision=?,document=? WHERE id=?').run(p.revision,JSON.stringify(ProjectSchema.parse(p)),p.id);return p})}
 enqueueReview(projectId:string,nodeId:string,input:unknown,origin:'human'|'bot',sourceRunId:string|null,confirmed=false,planItemId?:string):Project{return this.transaction(()=>{
  const p=this.get(projectId),node=this.node(p,nodeId),request=RemoteRequestSchema.parse(input);if(request.projectId!==p.id||request.nodeId!==node.id)fail('REVIEW_TARGET','提案只能使用自己的项目和节点');if(request.operation==='fork')fail('REVIEW_OPERATION','完整分叉使用人工入口');
  const prior=p.reviews?.find(r=>r.id===request.commandId);if(prior){if(JSON.stringify(prior.request)!==JSON.stringify(request))fail('COMMAND_REUSED','复核 ID 已用于其他任务');return p}
  if(origin==='human'&&request.expectedRevision!==p.revision)fail('REVISION_CONFLICT','任务已改变，请刷新后重新复核')
  if(request.operation==='delegate'){this.delegationContext(request);this.node(p,request.parentId)}else{const c=p.contexts.find(c=>c.id===request.contextId);if(!c||c.nodeId!==node.id||c.trunkRevisionId!==node.trunkRevisionId)fail('CONTEXT_STALE','续聊提案上下文不一致')}
  const effective=policyFor(p,nodeId);if(effective.paused)fail('BRANCH_PAUSED','分支已暂停，请先恢复');p.reviews??=[];
  p.reviews.push({id:request.commandId,nodeId,sourceRunId,origin,request,status:confirmed?'approved':'pending',reason:confirmed?'人工已复核并派发':'等待人工复核',humanApproved:confirmed,policyHash:effective.policyHash,grantNodeId:effective.grantNodeId,...(planItemId?{planItemId}:{}),createdAt:now(),updatedAt:now(),error:null});
  p.revision++;p.updatedAt=now();this.db.prepare('UPDATE projects SET revision=?,document=? WHERE id=?').run(p.revision,JSON.stringify(ProjectSchema.parse(p)),p.id);return p
 })}
 setProposalKey(runId:string,key:string){this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('proposal:'+runId,hash(key))}
 authorizeProposal(runId:string,key:string){const run=this.run(runId),saved=this.db.prepare('SELECT value FROM meta WHERE key=?').get('proposal:'+runId);if(!saved||saved.value!==hash(key)||run.terminalEvent||!['running','dispatching'].includes(run.state))fail('PROPOSAL_UNAUTHORIZED','提案需要本插件当前活动运行的凭证');return run}
 private assertRead(threadId:string){if(!this.db.prepare('SELECT id FROM raw_reads WHERE thread_id=? LIMIT 1').get(threadId))fail('PRIMARY_UNBOUND','聊天尚未经过真实读取')}
 private statements(statements:StatementType[],primaryId:string){for(const statement of statements){
  const refs=statement.anchorIds.map(id=>this.anchor(id))
  if(statement.authority==='user'&&!refs.some(a=>a.role==='user'&&a.threadId===primaryId))fail('AUTHORITY_MISMATCH','用户主干要求必须有主对话用户原文')
  if(statement.authority==='confirmed'&&(!statement.confirmationAnchorId||this.anchor(statement.confirmationAnchorId).role!=='user'||this.anchor(statement.confirmationAnchorId).threadId!==primaryId))fail('CONFIRMATION_MISSING','已确认决定需要主对话中的用户确认来源')
  if(statement.hard&&statement.authority==='suggestion')fail('SUGGESTION_NOT_CONSTRAINT','AI 建议不能自动升级为硬约束')
 }}
 private node(project:Project,id:string){const n=project.nodes.find(n=>n.id===id);if(!n)fail('NODE_MISSING','节点不属于当前任务');return n}
 private ownedAnchors(project:Project,nodeId:string,ids:string[]){const n=this.node(project,nodeId);for(const id of ids){const a=this.anchor(id);if(a.threadId!==n.threadId&&!n.task?.sourceAnchorIds.includes(id))fail('SCOPE_VIOLATION','原文来源不属于当前分支');if(a.turnStatus!=='completed')fail('TURN_INCOMPLETE','检查点和上下文只能采用已完成轮次的原文')}}
 private execute<T>(commandId:string,input:unknown,work:()=>T):T{return this.transaction(()=>{
  const requestHash=hash(JSON.stringify(input)),previous=this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId)
  if(previous){if(previous.request_hash!==requestHash)fail('COMMAND_REUSED','命令 ID 已被不同请求使用');return JSON.parse(String(previous.result)) as T}
  const value=work();this.db.prepare('INSERT INTO commands VALUES(?,?,?)').run(commandId,requestHash,JSON.stringify(value));return value
 })}
 create(input:unknown):Project{const request=CreateSchema.parse(input);return this.execute(request.commandId,request,()=>{
  this.assertRead(request.primaryThreadId);this.statements(request.statements,request.primaryThreadId)
  const trunkId=randomUUID(),project:Project={schemaVersion:2,id:randomUUID(),title:request.title,primaryThreadId:request.primaryThreadId,binding:'read_verified',revision:0,createdAt:now(),updatedAt:now(),trunks:[{id:trunkId,ordinal:1,statements:request.statements,createdAt:now()}],activeTrunkId:trunkId,nodes:[{id:'main',title:request.title,kind:'main',threadId:request.primaryThreadId,parentId:null,trunkRevisionId:trunkId,scope:'维护主干目标、约束与已确认决定',status:'active',forkTurnId:null,relation:'primary',x:20,y:230}],edges:[],checkpoints:[],packages:[],contexts:[],segments:[],compressions:[],merges:[],viewport:{x:0,y:0,zoom:1},engineering:null,hostCompressionHistory:'unknown'}
  ProjectSchema.parse(project);this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(project.id,0,JSON.stringify(project));return project
 })}
 apply(input:unknown):Project{const command=CommandSchema.parse(input);return this.execute(command.commandId,command,()=>{
  const project=this.get(command.projectId)
  if(project.revision!==command.expectedRevision)fail('REVISION_CONFLICT','任务已发生变化，请刷新后重新检查')
  this.mutate(project,command);project.revision++;project.updatedAt=now();ProjectSchema.parse(project)
  this.db.prepare('UPDATE projects SET revision=?,document=? WHERE id=?').run(project.revision,JSON.stringify(project),project.id)
  this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(randomUUID(),project.id,project.revision,command.commandId,JSON.stringify(command),now());return project
 })}
 private revise(project:Project,statements:StatementType[]){this.statements(statements,project.primaryThreadId);const trunk={id:randomUUID(),ordinal:project.trunks.length+1,statements,createdAt:now()};project.trunks.push(trunk);project.activeTrunkId=trunk.id;this.node(project,'main').trunkRevisionId=trunk.id;return trunk.id}
 private context(project:Project,nodeId:string,anchorIds:string[],packageIds:string[],budget:number){
  const node=this.node(project,nodeId),trunk=project.trunks.find(t=>t.id===node.trunkRevisionId)!
  // Context may use other branches only through bounded result packages; raw selection stays local.
  const hard=trunk.statements.filter(s=>s.hard),hardIds=hard.flatMap(s=>s.anchorIds)
  // Exact hard-constraint anchors from this node's pinned trunk may be carried forward.
  this.ownedAnchors(project,nodeId,anchorIds.filter(id=>!hardIds.includes(id)))
  const all=[...new Set([...hardIds,...anchorIds])]
  const selected=all.map(id=>this.anchor(id))
  const packages=packageIds.map(id=>{const p=project.packages.find(p=>p.id===id);if(!p)fail('PACKAGE_MISSING','成果包不存在');return p})
  const conclusions=new Map<string,string>();for(const pack of packages)for(const item of pack.items){if(conclusions.has(item.key)&&conclusions.get(item.key)!==item.text)fail('CONTEXT_CONFLICT','所选成果有矛盾，请先汇合预览并明确处理');conclusions.set(item.key,item.text)}
  const text=[`主干版本 ${trunk.ordinal}`, ...trunk.statements.map(s=>`[${s.authority}${s.hard?' / 硬约束':''}] ${s.text}`),...(node.task?[`[子任务范围] ${node.scope}\n[任务说明] ${node.task.brief}`]:[]),...selected.map(a=>`[原文 ${a.id} / ${a.role}]\n${a.text}`),...packages.flatMap(p=>p.items.map(i=>`[成果 ${p.id} / ${i.scope}] ${i.text}\n来源：${i.anchorIds.join(', ')}`))].join('\n\n')
  const count=[...text].length;if(count>budget)fail('CONTEXT_BUDGET','必要原文、硬约束与成果超过总预算；请拆分任务，不会静默截断')
  return {text,count,anchorIds:all}
 }
 private mutate(p:Project,c:Command){switch(c.operation){
  case 'set_review_policy':{const a=c.payload,node=this.node(p,a.nodeId);node.reviewPolicy=a.policy;if(a.subtree)for(const child of p.nodes.filter(n=>n.id!==node.id&&lineage(p,n.id).some(parent=>parent.id===node.id)))delete child.reviewPolicy;break}
  case 'inherit_review_policy':{const node=this.node(p,c.payload.nodeId);if(!node.parentId)fail('POLICY_ROOT','主任务没有父级授权');delete node.reviewPolicy;break}
  case 'pause_branch':{const node=this.node(p,c.payload.nodeId),effective=policyFor(p,node.id);node.reviewPolicy={...effective.policy,paused:c.payload.paused};break}
  case 'decide_review':{const a=c.payload,review=p.reviews?.find(r=>r.id===a.reviewId);if(!review)fail('REVIEW_MISSING','复核记录不存在');if(!['pending','failed','unknown'].includes(review.status))fail('REVIEW_STATE','当前记录不能重复审批');if(a.request){if(review.executedRequest)fail('REVIEW_ALREADY_SENT','已经发送的请求不能修改后重发');const request=RemoteRequestSchema.parse(a.request);if(request.commandId!==review.id||request.nodeId!==review.nodeId||request.projectId!==p.id||request.operation==='fork')fail('REVIEW_TARGET','编辑不能更换来源任务或命令');if(request.operation==='delegate')this.delegationContext(request);review.request=request}review.status=a.decision==='approve'?'approved':'rejected';review.humanApproved=a.decision==='approve';review.reason=a.decision==='approve'?'人工批准一次':'人工已拒绝';review.error=null;review.updatedAt=now();break}
  case 'release_scope':{const node=this.node(p,c.payload.nodeId);const active=this.runs().some(r=>r.projectId===p.id&&lineage(p,r.nodeId).some(n=>n.id===node.id)&&!r.terminalEvent&&!['completed','failed','interrupted'].includes(r.state));if(active)fail('SCOPE_BUSY','先停止并核查本任务及后代轮次，再交还范围');for(const lease of p.engineering?.leases??[])if(lease.state==='active'&&lineage(p,lease.childNodeId).some(n=>n.id===node.id)){lease.state='released';lease.releasedAt=now()}break}

  case 'set_importance':this.node(p,c.payload.nodeId).importance=c.payload.importance;break
  case 'promote_topic':{
   const a=c.payload,n=this.node(p,a.nodeId);this.node(p,a.parentId)
   if(n.kind==='main')fail('MAIN_IMMUTABLE','主干不能提升或移动')
   let cursor:string|null=a.parentId;const seen=new Set<string>()
   while(cursor){if(cursor===n.id||seen.has(cursor))fail('TASK_CYCLE','任务归属不能成环');seen.add(cursor);cursor=this.node(p,cursor).parentId}
   n.originParentId??=n.parentId;n.moves??=[];n.moves.push({from:n.parentId,to:a.parentId,reason:a.reason,createdAt:now()})
   const old=n.parentId;n.parentId=a.parentId;n.topic=true;n.importance='high';n.title=a.title
   p.edges=p.edges.filter(e=>!(e.target===n.id&&e.kind==='branch_from'))
   p.edges.push({id:randomUUID(),source:a.parentId,target:n.id,kind:'branch_from'})
   if(old&&old!==a.parentId&&!p.edges.some(e=>e.source===old&&e.target===n.id&&e.kind==='reference'))p.edges.push({id:randomUUID(),source:old,target:n.id,kind:'reference'})
   break
  }
  case 'accept_result':{
   const a=c.payload,node=this.node(p,a.nodeId),pack=p.packages.find(x=>x.id===a.packageId)
   if(!pack||((pack.deliveryToId??this.node(p,pack.nodeId).parentId)!==node.id))fail('RESULT_RECIPIENT','成果只能先交给指定直接父任务')
   if(pack.trunkRevisionId!==node.trunkRevisionId)fail('CONTEXT_STALE','成果与父任务主干版本不同，需先核对版本')
   const previous=p.contexts.filter(x=>x.nodeId===node.id&&x.trunkRevisionId===node.trunkRevisionId).at(-1)
   if(!previous)fail('CONTEXT_MISSING','先为父任务准备原文上下文，再纳入成果')
   const packageIds=[...new Set([...previous.packageIds,pack.id])],value=this.context(p,node.id,previous.anchorIds,packageIds,a.budget)
   p.contexts.push({...previous,id:randomUUID(),anchorIds:value.anchorIds,packageIds,budget:a.budget,text:value.text,codePoints:value.count,createdAt:now()});break
  }

  case 'attach_branch':{
   const a=c.payload,parent=this.node(p,a.parentId);this.assertRead(a.threadId)
   if(p.nodes.some(n=>n.threadId===a.threadId))fail('THREAD_ALREADY_BOUND','同一任务里该聊天已有节点')
   const id=randomUUID();p.nodes.push({id,title:a.title,kind:'branch',threadId:a.threadId,parentId:parent.id,trunkRevisionId:parent.trunkRevisionId,scope:a.scope,status:'active',forkTurnId:null,relation:'attached',x:parent.x+330,y:parent.y+(p.nodes.filter(n=>n.parentId===parent.id).length+1)*180});p.edges.push({id:randomUUID(),source:parent.id,target:id,kind:'branch_from'});break
  }
  case 'revise_trunk':this.revise(p,c.payload.statements);break
  case 'collapse_node':this.node(p,c.payload.nodeId).collapsed=c.payload.collapsed;break
  case 'save_view':for(const pos of c.payload.positions){const n=this.node(p,pos.nodeId);n.x=pos.x;n.y=pos.y}p.viewport=c.payload.viewport;break
  case 'add_reference':{
   const a=c.payload;this.node(p,a.source);this.node(p,a.target);if(a.source===a.target)fail('SELF_EDGE','节点不能连接自身')
   if(a.kind==='context_from'){
    const seen=new Set<string>();const visit=(id:string):boolean=>{if(id===a.source)return true;if(seen.has(id))return false;seen.add(id);return p.edges.filter(e=>e.source===id&&e.kind!=='reference').some(e=>visit(e.target))}
    if(visit(a.target))fail('CONTEXT_CYCLE','上下文依赖不能成环')
   }
   p.edges.push({id:randomUUID(),...a});break
  }
  case 'checkpoint':{
   const a=c.payload;this.ownedAnchors(p,a.nodeId,a.anchorIds);const turns=new Set(a.anchorIds.map(id=>this.anchor(id).turnId));if(a.completedTurnIds.some(id=>!turns.has(id)))fail('CHECKPOINT_SOURCE','检查点轮次缺少对应原文');p.checkpoints.push({...a,id:randomUUID(),createdAt:now()});break
  }
  case 'result_package':{
   const a=c.payload,n=this.node(p,a.nodeId);if(n.kind==='main')fail('BRANCH_REQUIRED','分支成果包必须来自分支节点')
   if([...a.items.map(i=>i.text).join('')].length>4000)fail('RESULT_BUDGET','成果正文超过 4000 个 Unicode 码点，原文不受此限制')
   for(const i of a.items){if(i.scope!==n.scope)fail('SCOPE_VIOLATION','成果有效范围必须与分支范围一致');this.ownedAnchors(p,n.id,i.anchorIds)}
   p.packages.push({...a,id:randomUUID(),trunkRevisionId:n.trunkRevisionId,...(n.parentId?{deliveryToId:n.parentId}:{}),createdAt:now()});break
  }
  case 'prepare_context':{
   const {nodeId,budget}=c.payload,node=this.node(p,nodeId),existing=p.contexts.filter(context=>context.nodeId===nodeId).at(-1)
   if(existing?.trunkRevisionId===node.trunkRevisionId)break
   this.assertRead(node.threadId)
   // Use the latest read's order, not archival ordinals that may precede host compaction.
   const read=this.db.prepare('SELECT id FROM raw_reads WHERE thread_id=? ORDER BY read_at DESC,rowid DESC LIMIT 1').get(node.threadId)!
   const all=this.db.prepare('SELECT anchor_id FROM anchor_observations WHERE read_id=? ORDER BY ordinal,rowid').all(String(read.id)).map(row=>this.anchor(String(row.anchor_id))).filter(anchor=>anchor.role==='user'||anchor.role==='assistant'),completed=all.filter(a=>a.turnStatus==='completed')
   if(!completed.length)fail('CONTEXT_SOURCE_EMPTY','这条对话尚无已完成原文，请先同步或选择可用来源')
   const turns=[...new Set(completed.map(a=>a.turnId))].slice(-2)
   if(node.forkTurnId){const cutoff=this.anchors(node.threadId).filter(a=>a.turnId===node.forkTurnId&&a.turnStatus==='completed'&&(a.role==='user'||a.role==='assistant'));if(!cutoff.length)fail('FORK_CUTOFF_MISSING','分叉点原文不可回查，请同步后核对上下文');for(const anchor of cutoff)if(!completed.some(a=>a.id===anchor.id))completed.push(anchor);turns.push(node.forkTurnId)}
   const anchorIds=completed.filter(a=>turns.includes(a.turnId)).map(a=>a.id),excluded=all.filter(a=>!anchorIds.includes(a.id)).map(a=>({id:a.id,reason:a.turnStatus==='completed'?'默认引用最近两轮与分叉点；其余原文保留在所属聊天':'轮次尚未完成，不作为上下文来源'}))
   const value=this.context(p,nodeId,anchorIds,[],budget)
   p.contexts.push({id:randomUUID(),nodeId,trunkRevisionId:node.trunkRevisionId,anchorIds:value.anchorIds,packageIds:[],excluded,budget,text:value.text,codePoints:value.count,createdAt:now()});break
  }
  case 'build_context':{
   const a=c.payload,value=this.context(p,a.nodeId,a.anchorIds,a.packageIds,a.budget);p.contexts.push({...a,id:randomUUID(),trunkRevisionId:this.node(p,a.nodeId).trunkRevisionId,anchorIds:value.anchorIds,text:value.text,codePoints:value.count,createdAt:now()});break
  }
  case 'rebuild_segment':{
   const a=c.payload,context=p.contexts.find(s=>s.id===a.contextId),checkpoint=p.checkpoints.find(s=>s.id===a.checkpointId);this.node(p,a.nodeId)
   if(!context||!checkpoint||context.nodeId!==a.nodeId||checkpoint.nodeId!==a.nodeId||!context.anchorIds.every(id=>checkpoint.anchorIds.includes(id)||p.trunks.find(t=>t.id===context.trunkRevisionId)!.statements.some(s=>s.hard&&s.anchorIds.includes(id))))fail('RAW_REBUILD_REQUIRED','重建需要本节点原文上下文和已核对检查点')
   const old=[...p.segments].reverse().find(s=>s.nodeId===a.nodeId)
   if(old?.cooling&&(checkpoint.id===old.lastCheckpointId||!checkpoint.completedTurnIds.some(t=>!old.lastTurnIds.includes(t)&&context.anchorIds.some(id=>this.anchor(id).turnId===t&&this.anchor(id).role==='user'))))fail('COMPRESSION_COOLDOWN','重建不能绕过冷却；需要新的实质轮次及原文检查点')
   p.segments.push({id:randomUUID(),lineageId:old?.lineageId??randomUUID(),nodeId:a.nodeId,rawAnchorIds:context.anchorIds,compressions:0,history:'known',cooling:false,lastTurnIds:[],lastCheckpointId:checkpoint.id,rebuiltFromRaw:true});break
  }
  case 'compress_context':{
   const a=c.payload,segment=p.segments.find(s=>s.id===a.segmentId),context=p.contexts.find(s=>s.id===a.contextId),checkpoint=p.checkpoints.find(s=>s.id===a.checkpointId)
   if(!segment||segment.history==='unknown')fail('COMPRESSION_UNKNOWN','压缩历史未知，先从原文建立并核对上下文段')
   if(!context||!checkpoint||context.nodeId!==segment.nodeId||checkpoint.nodeId!==segment.nodeId)fail('SCOPE_VIOLATION','压缩输入不属于当前节点')
   if(p.segments.filter(s=>s.nodeId===segment.nodeId).at(-1)?.id!==segment.id)fail('SEGMENT_STALE','只能操作当前上下文段')
   if(segment.compressions>=2)fail('COMPRESSION_LIMIT','该段已压缩两次；保存检查点后从原文重建')
   const failures=p.compressions.filter(e=>e.segmentId===segment.id).slice(-3)
   if(failures.length===3&&failures.every(e=>e.status==='failed'&&p.contexts.find(c=>c.id===e.contextId)?.text===context.text))fail('COMPRESSION_RETRY_LIMIT','同一输入已连续失败三次；换命令或快照 ID 不能解除，需要有依据地改变输入')
   const newTurns=checkpoint.completedTurnIds.filter(id=>!segment.lastTurnIds.includes(id))
   if(segment.cooling&&(!newTurns.length||checkpoint.id===segment.lastCheckpointId))fail('COMPRESSION_COOLDOWN','连续压缩被拒绝；需要新的实质轮次和原文检查点')
   if(!context.anchorIds.every(id=>segment.rawAnchorIds.includes(id)||checkpoint.anchorIds.includes(id)))fail('RAW_SOURCE_REQUIRED','压缩必须直接采用可回查原文')
   if(segment.cooling&&!newTurns.some(id=>context.anchorIds.some(a=>this.anchor(a).turnId===id&&this.anchor(a).role==='user'&&this.anchor(a).text.trim().length>0)))fail('NO_SUBSTANTIVE_PROGRESS','新轮次缺少实质用户任务原文')
   p.compressions.push({id:randomUUID(),segmentId:segment.id,contextId:context.id,summary:a.summary,status:a.status,sourceAnchorIds:context.anchorIds,createdAt:now()})
   if(a.status==='completed'){segment.compressions++;segment.cooling=true;segment.lastTurnIds=checkpoint.completedTurnIds;segment.lastCheckpointId=checkpoint.id}break
  }
  case 'merge_preview':{
   const packages=c.payload.packageIds.map(id=>{const item=p.packages.find(i=>i.id===id);if(!item)fail('PACKAGE_MISSING','成果包不存在');return item})
   const nodes=[...new Set(packages.map(a=>a.nodeId))];if(nodes.length<2)fail('MERGE_SOURCES','汇合至少需要两个不同分支')
   const grouped=new Map<string,{packageId:string,text:string}[]>();for(const pack of packages)for(const item of pack.items){const list=grouped.get(item.key)??[];list.push({packageId:pack.id,text:item.text});grouped.set(item.key,list)}
   const conflicts=[...grouped.entries()].filter(([,values])=>new Set(values.map(v=>v.text)).size>1).map(([key,candidates])=>({key,candidates,resolution:c.payload.resolutions[key]??null}))
   p.merges.push({id:randomUUID(),sourceNodeIds:nodes,packageIds:c.payload.packageIds,conflicts,status:'preview',adoptedTrunkId:null,createdAt:now()});break
  }
  case 'merge_adopt':{
   const merge=p.merges.find(m=>m.id===c.payload.mergeId);if(!merge||merge.status!=='preview')fail('MERGE_MISSING','汇合预览不存在或已采纳')
   if(merge.conflicts.some(c=>c.resolution===null||!c.resolution.trim()))fail('UNRESOLVED_CONFLICT','矛盾结论必须先明确处理，不能拼成一致事实')
   merge.adoptedTrunkId=this.revise(p,c.payload.statements);merge.status='adopted';break
  }
  case 'set_engineering':{
   const a=c.payload;if(!isAbsolute(a.repoPath))fail('REPO_PATH','工程根目录必须为绝对路径')
   const owners=new Map<string,string>()
   for(const task of activeAssignments(a)){this.node(p,task.nodeId);for(const path of task.allowedPaths){if(isAbsolute(path)||/^[A-Za-z]:/.test(path)||path.split(/[\\/]/).includes('..')||/[*?]/.test(path)||!path.trim()||path.includes('\0')||path.split(/[\\/]/).some(s=>s.toLowerCase()==='.git'))fail('PATH_ESCAPE','写入范围须为工程内的明确相对路径，不能逃逸或使用通配符');const key=normalize(path).replaceAll('\\','/').replace(/\/$/,'').toLowerCase();for(const [prior,owner] of owners){if(owner!==task.nodeId&&(prior==='.'||key==='.'||prior===key||prior.startsWith(key+'/')||key.startsWith(prior+'/')))fail('ENGINEERING_OVERLAP','代码分支写入范围重叠，需要隔离工作区或串行执行')}owners.set(key,task.nodeId)}}
   for(const v of a.verifications){this.node(p,v.nodeId);if(v.testedCommit!==a.baseCommit)fail('BASELINE_DRIFT','验证提交与当前工程基线不一致')}
   p.engineering=a;break
  }
  case 'node_status':{const n=this.node(p,c.payload.nodeId);if(c.payload.status==='done'&&!c.payload.evidence?.trim())fail('ACCEPTANCE_REQUIRED','标记完成需要验收证据');n.status=c.payload.status;if(n.status==='done')for(const lease of p.engineering?.leases??[])if(lease.childNodeId===n.id&&lease.state==='active'){lease.state='released';lease.releasedAt=now()}break}
 }}
}
