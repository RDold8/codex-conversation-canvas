import {z} from 'zod'
import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises'
import {dirname,join,isAbsolute} from 'node:path'
import {gzip,gunzip} from 'node:zlib'
import {promisify} from 'node:util'
import {Store,PolicyError} from './store'
import {ProjectSchema,RunSchema,RemoteRequestSchema,VerificationSchema,type Project} from './schema'
const text=z.string(),hash=z.string().regex(/^[a-f0-9]{64}$/),integer=z.number().int().nonnegative()
const raw=z.object({id:text,thread_id:text,read_at:text,body:text,sha256:hash}).strict()
const anchor=z.object({id:text,thread_id:text,turn_id:text,item_id:text,role:text,ordinal:integer,body:text,text,sha256:hash,turn_status:text}).strict()
const observation=z.object({id:text,anchor_id:text,read_id:text,turn_status:text,ordinal:integer}).strict()
const command=z.object({id:text,request_hash:hash,result:text}).strict()
const event=z.object({id:text,project_id:text,revision:integer,command_id:text,body:text,created_at:text}).strict()
const run=z.object({id:text,request_hash:hash,document:text}).strict()
const remoteEvent=z.object({id:text,run_id:text,method:text,body:text,created_at:text}).strict()
const remoteRequest=z.object({id:text,run_id:text,rpc_id:text,method:text,params:text,resolved:z.number().int().min(0).max(1)}).strict()
const verificationLog=z.object({id:text,verification_id:text,step_index:integer,body_base64:text,sha256:hash}).strict()
const Data=z.object({project:ProjectSchema,raw_reads:z.array(raw),anchors:z.array(anchor),anchor_observations:z.array(observation),commands:z.array(command),events:z.array(event),remote_runs:z.array(run),remote_events:z.array(remoteEvent),remote_requests:z.array(remoteRequest),verification_runs:z.array(run).default([]),verification_logs:z.array(verificationLog).default([])}).strict()
const Envelope=z.object({format:z.literal('codex-long-task-archive'),version:z.literal(1),createdAt:text,sha256:hash,data:Data}).strict()
type DataType=z.infer<typeof Data>
const digest=(body:string|Buffer)=>createHash('sha256').update(body).digest('hex')
const LIMIT=64*1024*1024,EXPANDED_LIMIT=256*1024*1024
const gzipArchive=promisify(gzip),gunzipArchive=promisify(gunzip)
function fail(code:string,message:string):never{throw new PolicyError(code,message)}
function unique(rows:{id:string}[]){if(new Set(rows.map(r=>r.id)).size!==rows.length)fail('ARCHIVE_DUPLICATE','导出内容含重复标识')}
function validateReferences(data:DataType){
 const p=data.project,nodes=new Map(p.nodes.map(n=>[n.id,n])),trunks=new Set(p.trunks.map(t=>t.id)),anchors=new Map(data.anchors.map(a=>[a.id,a])),reads=new Map(data.raw_reads.map(r=>[r.id,r])),packages=new Set(p.packages.map(a=>a.id)),contexts=new Set(p.contexts.map(c=>c.id)),segments=new Set(p.segments.map(s=>s.id)),checkpoints=new Set(p.checkpoints.map(c=>c.id)),runs=new Map(data.remote_runs.map(r=>[r.id,RunSchema.parse(JSON.parse(r.document))]))
 for(const rows of Object.values(data).filter(Array.isArray))unique(rows as {id:string}[])
 for(const rows of [p.nodes,p.trunks,p.edges,p.packages,p.contexts,p.segments,p.checkpoints,p.compressions,p.merges])unique(rows)
 const requireRefs=(ids:string[],set:{has:(key:string)=>boolean})=>{if(ids.some(id=>!set.has(id)))fail('ARCHIVE_REFERENCE','导出内容缺少所引用的原文、节点或版本')}
 if(p.nodes.filter(n=>n.kind==='main').length!==1||nodes.get('main')?.threadId!==p.primaryThreadId||nodes.get('main')?.relation!=='primary'||!trunks.has(p.activeTrunkId))fail('ARCHIVE_MAIN','主对话或活动主干版本不一致')
 for(const n of p.nodes){requireRefs([n.trunkRevisionId],trunks);if(n.parentId)requireRefs([n.parentId],nodes);if(n.kind==='main'&&n.parentId!==null)fail('ARCHIVE_MAIN','主对话不能有父节点');if(n.originParentId)requireRefs([n.originParentId],nodes);if(n.task){requireRefs([n.task.originNodeId],nodes);requireRefs(n.task.sourceAnchorIds,anchors);requireRefs(n.task.sourcePackageIds,packages);requireRefs([n.task.creationRunId],runs)};for(const move of n.moves??[])requireRefs([...(move.from?[move.from]:[]),move.to],nodes)}
 for(const lease of p.engineering?.leases??[])requireRefs([lease.sourceNodeId,lease.childNodeId],nodes)
 unique(p.reviews??[]);unique(p.engineering?.leases??[])
 for(const review of p.reviews??[]){
  requireRefs([review.nodeId,review.grantNodeId],nodes);if(review.sourceRunId)requireRefs([review.sourceRunId],runs);if(review.childNodeId)requireRefs([review.childNodeId],nodes)
  const original=RemoteRequestSchema.parse(review.request);if(original.projectId!==p.id||original.nodeId!==review.nodeId||original.commandId!==review.id||original.operation==='fork')fail('ARCHIVE_REVIEW','复核任务身份不一致')
  if(review.executedRequest){const executed=RemoteRequestSchema.parse(review.executedRequest);if(executed.projectId!==p.id||executed.nodeId!==review.nodeId||executed.commandId!==review.id||executed.operation!==original.operation||executed.reviewId!==review.id)fail('ARCHIVE_REVIEW','已派发复核身份不一致')}
  if(review.firstRequest){const first=RemoteRequestSchema.parse(review.firstRequest);if(first.operation!=='turn'||first.projectId!==p.id||first.nodeId!==review.childNodeId||first.reviewId!==review.id||first.commandId!==nodes.get(first.nodeId)?.task?.initialTurnCommandId)fail('ARCHIVE_REVIEW','子任务首轮身份不一致')}
 }
 for(const edge of p.edges)requireRefs([edge.source,edge.target],nodes)
 const visiting=new Set<string>(),visited=new Set<string>()
 function visit(id:string){if(visiting.has(id))fail('CONTEXT_CYCLE','导出内容存在上下文依赖环');if(visited.has(id))return;visiting.add(id);for(const e of p.edges.filter(e=>e.source===id&&e.kind!=='reference'))visit(e.target);visiting.delete(id);visited.add(id)}
 for(const id of nodes.keys())visit(id)
 const parsedReads=new Map<string,any>()
 for(const r of data.raw_reads){if(digest(r.body)!==r.sha256)fail('ARCHIVE_SOURCE_HASH','读取原文哈希不一致');const body=JSON.parse(r.body);if(body.id!==r.thread_id||!Array.isArray(body.turns))fail('ARCHIVE_SOURCE_ID','读取原文身份不一致');parsedReads.set(r.id,body)}
 for(const a of data.anchors){
  const item=JSON.parse(a.body),role=item.type==='userMessage'?'user':item.type==='agentMessage'?'assistant':item.type
  const text=item.type==='userMessage'?(item.content??[]).filter((v:any)=>v.type==='text').map((v:any)=>v.text??'').join('\n'):item.type==='agentMessage'?item.text:a.body
  if(digest(a.body)!==a.sha256||item.id!==a.item_id||a.role!==role||text!==a.text||a.id!==`${a.thread_id}:${a.turn_id}:${a.item_id}:${a.sha256}`)fail('ARCHIVE_SOURCE_HASH','原文锚点、角色、文本或哈希不一致')
 }
 for(const o of data.anchor_observations){requireRefs([o.anchor_id],anchors);requireRefs([o.read_id],reads);const a=anchors.get(o.anchor_id)!,r=reads.get(o.read_id)!,turn=parsedReads.get(r.id).turns.find((t:any)=>t.id===a.turn_id);if(r.thread_id!==a.thread_id||!turn||turn.status!==o.turn_status||!turn.items?.some((i:any)=>i.id===a.item_id&&isDeepStrictEqual(i,JSON.parse(a.body))))fail('ARCHIVE_OBSERVATION','原文观察与读取记录不一致')}
 for(const a of data.anchors)if(!data.anchor_observations.some(o=>o.anchor_id===a.id))fail('ARCHIVE_OBSERVATION','锚点缺少读取观察')
 for(const n of p.nodes)if(!data.raw_reads.some(r=>r.thread_id===n.threadId))fail('PRIMARY_UNBOUND','节点缺少真实读取记录')
 for(const t of p.trunks)for(const s of t.statements){requireRefs(s.anchorIds,anchors);if(s.confirmationAnchorId)requireRefs([s.confirmationAnchorId],anchors);if(s.authority==='user'&&!s.anchorIds.some(id=>anchors.get(id)?.thread_id===p.primaryThreadId&&anchors.get(id)?.role==='user'))fail('AUTHORITY_MISMATCH','主干用户要求缺少主对话原文');if(s.authority==='suggestion'&&s.hard)fail('SUGGESTION_NOT_CONSTRAINT','建议不能恢复为硬约束');if(s.authority==='confirmed'&&(!s.confirmationAnchorId||anchors.get(s.confirmationAnchorId)?.role!=='user'||anchors.get(s.confirmationAnchorId)?.thread_id!==p.primaryThreadId))fail('CONFIRMATION_MISSING','确认决定缺少用户确认原文')}
 for(const cp of p.checkpoints){requireRefs([cp.nodeId],nodes);requireRefs(cp.anchorIds,anchors);if(cp.completedTurnIds.some(id=>!cp.anchorIds.some(a=>anchors.get(a)?.turn_id===id)))fail('CHECKPOINT_SOURCE','检查点轮次缺少原文')}
 for(const pack of p.packages){requireRefs([pack.nodeId],nodes);requireRefs([pack.trunkRevisionId],trunks);if([...pack.items.map(i=>i.text).join('')].length>4000)fail('RESULT_BUDGET','导出成果包超过预算');for(const item of pack.items)requireRefs(item.anchorIds,anchors)}
 for(const pack of p.packages)if(pack.deliveryToId)requireRefs([pack.deliveryToId],nodes)
 for(const c of p.contexts){requireRefs([c.nodeId],nodes);requireRefs([c.trunkRevisionId],trunks);requireRefs(c.anchorIds,anchors);requireRefs(c.packageIds,packages);if([...c.text].length!==c.codePoints||c.codePoints>c.budget)fail('CONTEXT_BUDGET','上下文字符数或预算不一致')}
 for(const s of p.segments){requireRefs([s.nodeId],nodes);requireRefs(s.rawAnchorIds,anchors);if(s.lastCheckpointId)requireRefs([s.lastCheckpointId],checkpoints)}
 for(const c of p.compressions){requireRefs([c.segmentId],segments);requireRefs([c.contextId],contexts);requireRefs(c.sourceAnchorIds,anchors)}
 for(const m of p.merges){requireRefs(m.sourceNodeIds,nodes);requireRefs(m.packageIds,packages);if(m.adoptedTrunkId)requireRefs([m.adoptedTrunkId],trunks)}
 for(const r of runs.values()){if(r.projectId!==p.id||r.request.projectId!==p.id||r.id!==r.request.commandId||r.requestHash!==digest(JSON.stringify(r.request)))fail('ARCHIVE_RUN','运行请求身份或哈希不一致');requireRefs([r.nodeId],nodes);requireRefs([r.trunkRevisionId],trunks)}
 for(const r of data.remote_runs)if(r.request_hash!==runs.get(r.id)!.requestHash)fail('ARCHIVE_RUN','运行记录索引哈希不一致')
 const verifications=new Map(data.verification_runs.map(r=>[r.id,VerificationSchema.parse(JSON.parse(r.document))]))
 for(const row of data.verification_runs){const v=verifications.get(row.id)!;if(row.id!==v.id||v.id!==v.request.commandId||v.nodeId!==v.request.nodeId||v.purpose!==v.request.purpose||v.projectId!==p.id||v.request.projectId!==p.id||v.requestHash!==row.request_hash||digest(JSON.stringify(v.request))!==v.requestHash)fail('ARCHIVE_VERIFICATION','验证请求身份或哈希不一致');requireRefs([v.nodeId],nodes)}
 for(const log of data.verification_logs){requireRefs([log.verification_id],verifications);const v=verifications.get(log.verification_id)!,bytes=Buffer.from(log.body_base64,'base64');if(log.id!==`${log.verification_id}:${log.step_index}`||bytes.toString('base64')!==log.body_base64||digest(log.body_base64)!==log.sha256||digest(bytes)!==v.steps[log.step_index]?.logSha256)fail('ARCHIVE_VERIFICATION_LOG','验证日志内容或引用不一致')}
 for(const v of verifications.values())for(const [index] of v.steps.entries())if(!data.verification_logs.some(l=>l.verification_id===v.id&&l.step_index===index))fail('ARCHIVE_VERIFICATION_LOG','验证报告缺少完整日志')
 for(const r of [...data.remote_events,...data.remote_requests])requireRefs([r.run_id],runs)
 for(const r of data.commands){const result=ProjectSchema.parse(JSON.parse(r.result));if(result.id!==p.id)fail('ARCHIVE_COMMAND','历史命令属于其他任务')}
 for(const e of data.events){if(e.project_id!==p.id)fail('ARCHIVE_EVENT','事件不属于该任务');JSON.parse(e.body)}
}
export function validateArchive(value:unknown){
 const envelope=Envelope.parse(value)
 // Hash the original JSON value, before schema normalization changes property order.
 if(digest(JSON.stringify((value as any).data))!==envelope.sha256)fail('ARCHIVE_HASH','导出包哈希不一致，禁止恢复')
 validateReferences(envelope.data);return envelope
}
export async function exportProject(store:Store,projectId:string){
 const db=store.db;db.exec('BEGIN IMMEDIATE');let data:DataType
 try{
  const project=store.get(projectId),runs=store.runs().filter(r=>r.projectId===projectId);if(runs.some(r=>!r.terminalEvent&&!['completed','interrupted','failed'].includes(r.state)&&db.prepare('SELECT value FROM meta WHERE key=?').get('proposal:'+r.id)))fail('ARCHIVE_ACTIVE_PROPOSAL','当前运行仍持有临时提案凭证，请在轮次结束后导出');const threads=new Set(project.nodes.map(n=>n.threadId))
  const scan=(value:unknown)=>{if(Array.isArray(value)){value.forEach(scan);return}if(value&&typeof value==='object')for(const [name,child] of Object.entries(value)){if(['anchorIds','rawAnchorIds','sourceAnchorIds'].includes(name)&&Array.isArray(child))for(const id of child)threads.add(store.anchor(String(id)).threadId);else if(name==='confirmationAnchorId'&&typeof child==='string')threads.add(store.anchor(child).threadId);else scan(child)}}
  scan(project)
  for(const r of runs){threads.add(r.sourceThreadId);if(r.threadId)threads.add(r.threadId)}
  const raw_reads=db.prepare('SELECT * FROM raw_reads ORDER BY rowid').all().filter(r=>threads.has(String(r.thread_id))),anchors=db.prepare('SELECT * FROM anchors ORDER BY rowid').all().filter(r=>threads.has(String(r.thread_id))),anchorIds=new Set(anchors.map(r=>r.id)),readIds=new Set(raw_reads.map(r=>r.id)),runIds=new Set(runs.map(r=>r.id))
  data=Data.parse({project,raw_reads,anchors,anchor_observations:db.prepare('SELECT * FROM anchor_observations ORDER BY rowid').all().filter(r=>anchorIds.has(r.anchor_id)&&readIds.has(r.read_id)),commands:db.prepare('SELECT * FROM commands ORDER BY rowid').all().filter(r=>JSON.parse(String(r.result)).id===projectId),events:db.prepare('SELECT * FROM events WHERE project_id=? ORDER BY rowid').all(projectId),remote_runs:db.prepare('SELECT * FROM remote_runs ORDER BY rowid').all().filter(r=>runIds.has(String(r.id))),remote_events:db.prepare('SELECT * FROM remote_events ORDER BY rowid').all().filter(r=>runIds.has(String(r.run_id))),remote_requests:db.prepare('SELECT * FROM remote_requests ORDER BY rowid').all().filter(r=>runIds.has(String(r.run_id)))})
  data.verification_runs=db.prepare('SELECT * FROM verification_runs ORDER BY rowid').all().filter(r=>JSON.parse(String(r.document)).projectId===projectId).map(r=>run.parse(r))
  const verifications=new Map(data.verification_runs.map(r=>[r.id,VerificationSchema.parse(JSON.parse(r.document))]))
  data.verification_logs=db.prepare('SELECT * FROM verification_logs ORDER BY rowid').all().filter(r=>Number(r.step_index)<(verifications.get(String(r.verification_id))?.steps.length??0)).map(r=>verificationLog.parse(r))
  db.exec('COMMIT')
 }catch(e){db.exec('ROLLBACK');throw e}
 const envelope={format:'codex-long-task-archive' as const,version:1 as const,createdAt:new Date().toISOString(),sha256:digest(JSON.stringify(data!)),data:data!}
 validateArchive(envelope)
 const expanded=Buffer.from(JSON.stringify(envelope,null,2)+'\n','utf8');if(expanded.length>EXPANDED_LIMIT)fail('ARCHIVE_SIZE','任务归档展开大小超过256MB限额')
 const compressed=expanded.length>LIMIT,bytes=compressed?await gzipArchive(expanded):expanded
 if(bytes.length>LIMIT)fail('ARCHIVE_SIZE','压缩后的任务归档仍超过64MB限额')
 const folder=join(dirname(store.path),'exports');await mkdir(folder,{recursive:true});const path=join(folder,`task-${randomUUID()}.json${compressed?'.gz':''}`)
 await writeFile(path,bytes,{flag:'wx'});if(digest(await readFile(path))!==digest(bytes))fail('ARCHIVE_WRITE','导出文件回读哈希不一致')
 return {path,sha256:digest(bytes),bytes:bytes.length,expandedBytes:expanded.length,encoding:compressed?'gzip':'json',projectId,sourceCount:data!.anchors.length,runCount:data!.remote_runs.length}
}
export async function restoreProject(store:Store,path:string){
 if(!isAbsolute(path))fail('ARCHIVE_PATH','请选择导出文件的完整路径')
 if((await stat(path)).size>LIMIT)fail('ARCHIVE_SIZE','导入文件超过64MB限额')
 const bytes=await readFile(path);if(bytes.length>LIMIT)fail('ARCHIVE_SIZE','导入文件超过64MB限额')
 let expanded=bytes
 if(bytes[0]===0x1f&&bytes[1]===0x8b){
  try{expanded=await gunzipArchive(bytes,{maxOutputLength:EXPANDED_LIMIT})}catch(e){fail('ARCHIVE_ENCODING',`压缩归档损坏或展开大小超过256MB限额：${e instanceof Error?e.message:String(e)}`)}
 }
 const envelope=validateArchive(JSON.parse(expanded.toString('utf8'))),data=envelope.data,db=store.db
 db.exec('BEGIN IMMEDIATE')
 try{
  if(db.prepare('SELECT id FROM projects WHERE id=?').get(data.project.id))fail('PROJECT_EXISTS','同一任务已存在，禁止用导出文件覆盖当前修改')
  const tables=['raw_reads','anchors','anchor_observations','commands','events','remote_runs','remote_events','remote_requests','verification_runs','verification_logs'] as const
  for(const table of tables)for(const original of data[table]){
   let row:Record<string,unknown>={...original}
   if(table==='remote_runs'){
    const record=RunSchema.parse(JSON.parse(String(row.document)))
    record.ownerPid=null
    if(!record.terminalEvent){if(record.state==='prepared'){record.state='interrupted';record.terminalEvent=true;record.error='恢复时关闭尚未派发的记录；未向远端发送'}else{record.state='unknown';record.error='由导出恢复，原连接不可接续；只读核查后再处理，不会自动重发'}}
    row.document=JSON.stringify(record)
   }
   if(table==='remote_requests')row.resolved=1 // Original connection is not portable.
   if(table==='verification_runs'){const report=VerificationSchema.parse(JSON.parse(String(row.document)));report.ownerPid=null;report.childPid=null;report.status='unknown';report.error='报告由归档恢复，需在当前仓库重新验证；旧报告与完整日志保留';row.document=JSON.stringify(report)}
   const existing=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(String(row.id))
   if(existing){const keys=Object.keys(row).filter(k=>table!=='anchors'||!['turn_status','ordinal'].includes(k));if(keys.some(k=>existing[k]!==row[k]))fail('ARCHIVE_COLLISION','已有来源或命令标识与导入内容冲突，全部恢复撤销');continue}
   const columns=Object.keys(row);db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...Object.values(row) as (string|number|null)[])
  }
  const p=data.project;for(const review of p.reviews??[])if(!['completed','rejected'].includes(review.status)){review.status='pending';review.origin='human';review.humanApproved=false;review.reason='归档恢复后需人工核查；不会自动派发';review.updatedAt=new Date().toISOString()}
  db.prepare('INSERT INTO projects VALUES(?,?,?)').run(p.id,p.revision,JSON.stringify(p));db.exec('COMMIT')
  return {project:store.get(p.id),archiveSha256:digest(bytes),restoredRuns:data.remote_runs.length,remoteReplay:false}
 }catch(e){db.exec('ROLLBACK');throw e}
}
