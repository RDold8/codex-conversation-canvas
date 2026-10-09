import { version as PLUGIN_VERSION } from '../package.json'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { codexRequest } from './codex'
import { Store,PolicyError } from './store'
import { CommandSchema,CreateSchema,RemoteRequestSchema,VerificationRequestSchema,SCHEMA_VERSION } from './schema'
import { CodexConnection } from './connection'
import { RemoteManager } from './remote'
import { inspectRepository,inspectEngineering,requireEngineering,requireIdleCodeRepository } from './engineering'
import { exportProject,restoreProject } from './archive'
import {ReviewManager} from './reviews'
import {activeAssignments} from './governance'
import { VerificationManager } from './verification'
const URI='ui://long-conversation-canvas/workspace.html'
const UI_HTML=readFileSync(fileURLToPath(new URL('./workspace.html',import.meta.url)),'utf8')
const server=new McpServer({name:'long-conversation-canvas',version:PLUGIN_VERSION})
let storage:Store|undefined
let remote:RemoteManager|undefined
let verification:VerificationManager|undefined
let reviews:ReviewManager|undefined
function reviewer(){return reviews??=new ReviewManager(store(),manager(),REMOTE_ENABLED)}
const reviewTimer=setInterval(()=>{if(reviews)void reviews.tick().catch(e=>process.stderr.write('Review queue: '+String(e)+'\n'))},1000);reviewTimer.unref()
function verifier(){return verification??=new VerificationManager(store())}
const REMOTE_ENABLED=process.env.CANVAS_ENABLE_REMOTE_WRITES==='1'
function manager(){return remote??=new RemoteManager(store(),new CodexConnection(),REMOTE_ENABLED,{createConnection:()=>new CodexConnection()})}
function store(){return storage??=new Store(join(process.env.CANVAS_DATA_DIR??join(process.env.CODEX_HOME??join(homedir(),'.codex'),'long-conversation-canvas'),'tasks.sqlite'))}
function workspace(){manager();verifier();reviewer();return {schemaVersion:SCHEMA_VERSION,projects:store().list(),storagePath:store().path,runs:store().runViews(),verifications:store().verifications(),remoteEnabled:REMOTE_ENABLED}}
function overview(){return {schemaVersion:SCHEMA_VERSION,tasks:store().list().map(p=>({id:p.id,title:p.title,primaryThreadId:p.primaryThreadId,revision:p.revision,nodes:p.nodes.length})),remoteEnabled:REMOTE_ENABLED}}
async function guarded(work:()=>unknown|Promise<unknown>){try{return result(await work() as Record<string,unknown>)}catch(e){return {isError:true,...result({error:{code:e instanceof PolicyError?e.code:e instanceof z.ZodError?'SCHEMA_INVALID':'SOURCE_ERROR',message:e instanceof Error?e.message:String(e)}})}}}
function result(value:Record<string,unknown>){return{content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value}}
server.registerTool('canvas_read',{description:'读取已保存的长任务简要总览；完整原文由画布按需读取。',inputSchema:{}},async()=>guarded(()=>overview()))
server.registerTool('canvas_render',{description:'打开长任务总览。每个任务显式选择主对话，保存主干、分支关系、上下文与检查点。',title:'长任务',inputSchema:{},_meta:{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'global'}],preferredModelDisplayMode:'fullscreen'}}},async()=>guarded(()=>overview()))
const APP_ONLY={ui:{visibility:['app'] as ('app'|'model')[]}}
server.registerTool('workspace_capabilities',{description:'只读查询当前 Codex 可用模型和技能，不创建聊天或发送消息。',inputSchema:{cwd:z.string().optional()},_meta:APP_ONLY},async({cwd})=>guarded(async()=>{
 const values=await Promise.allSettled([codexRequest('model/list',{limit:100}),codexRequest('skills/list',{cwds:cwd?[cwd]:[],forceReload:false})]);
 const models=values[0],skills=values[1];return {models:models.status==='fulfilled'?(models.value.data??[]).filter((m:any)=>!m.hidden).map((m:any)=>({id:m.model,displayName:m.displayName,defaultReasoningEffort:m.defaultReasoningEffort,supportedReasoningEfforts:m.supportedReasoningEfforts})):[],skills:skills.status==='fulfilled'?(skills.value.data??[]).flatMap((entry:any)=>(entry.skills??[]).filter((skill:any)=>skill.enabled).map((skill:any)=>({name:skill.name,path:skill.path,description:skill.shortDescription??skill.description}))):[],errors:values.flatMap((v,index)=>v.status==='rejected'?[`${index===0?'模型':'技能'}查询失败：${String(v.reason)}`]:[]),modelsNextCursor:models.status==='fulfilled'?models.value.nextCursor??null:null}
}))
server.registerTool('workspace_read',{description:'读取长任务工作区的持久化状态。',inputSchema:{},_meta:APP_ONLY},async()=>guarded(()=>workspace()))
server.registerTool('workspace_sources',{description:'同步聊天可见原文到追加存档，返回可选来源。历史完整性与宿主压缩次数仍标未知。',inputSchema:{threadId:z.string().uuid()},_meta:APP_ONLY},async({threadId})=>guarded(async()=>{
 const response=await codexRequest('thread/read',{threadId,includeTurns:true});const read=store().importThread(response.thread,threadId)
 return {...read,...store().sourcePage(threadId)}
}))
server.registerTool('workspace_source_page',{description:'读取已存档对话；不传cursor时读取最近一页，传cursor加载较早原文。不启动模型或重复同步。',inputSchema:{threadId:z.string().uuid(),cursor:z.string().min(1).optional(),limit:z.number().int().min(1).max(100).default(100)},_meta:APP_ONLY},async({threadId,cursor,limit})=>guarded(()=>store().sourcePage(threadId,cursor,limit)))
server.registerTool('workspace_source_read',{description:'按来源锚点读取完整原文及其哈希。',inputSchema:{anchorId:z.string().min(1)},_meta:APP_ONLY},async({anchorId})=>guarded(()=>({anchor:store().anchor(anchorId)})))
server.registerTool('workspace_create',{description:'从已读取的真实主对话创建本地长任务。不会创建新的 Codex 聊天。',inputSchema:{request:CreateSchema},_meta:APP_ONLY},async({request})=>guarded(()=>({project:store().create(request)})))
server.registerTool('workspace_command',{description:'执行带版本校验与幂等 ID 的本地任务命令；工程动作核对实际仓库，不会启动模型轮次。',inputSchema:{command:CommandSchema},_meta:APP_ONLY},async({command})=>guarded(async()=>{
 if(store().db.prepare('SELECT id FROM commands WHERE id=?').get(command.commandId))return {project:store().apply(command)}
 const project=store().get(command.projectId)
 if(command.operation==='prepare_context'){
  const node=project.nodes.find(n=>n.id===command.payload.nodeId);if(!node)throw new PolicyError('NODE_MISSING','节点不属于当前任务')
  if(project.contexts.filter(c=>c.nodeId===node.id).at(-1)?.trunkRevisionId!==node.trunkRevisionId){const response=await codexRequest('thread/read',{threadId:node.threadId,includeTurns:true});store().importThread(response.thread,node.threadId)}
 }
 if(command.operation==='release_scope'&&project.engineering){await requireIdleCodeRepository(store(),project.engineering.repoPath);if(store().verifications().some(v=>v.status==='running'&&v.repoPath.toLowerCase()===project.engineering!.repoPath.toLowerCase()))throw new PolicyError('SCOPE_BUSY','仓库验证仍在执行，请等待结束再交还范围')}
 if(command.operation==='set_engineering'){
  await requireIdleCodeRepository(store(),command.payload.repoPath);if(project.engineering)await requireIdleCodeRepository(store(),project.engineering.repoPath)
  const observed=await inspectEngineering({...project,engineering:command.payload});if(!observed.baselineMatches)throw new PolicyError('BASELINE_DRIFT','工程基线与实际 HEAD 不一致')
 }
 if(command.operation==='result_package'&&command.payload.items.some(i=>i.kind==='change')){await requireEngineering(project,command.payload.nodeId);await verifier().requireCurrent(project.id,command.payload.nodeId,'branch')}
 if(command.operation==='node_status'&&command.payload.status==='done'&&project.engineering&&(command.payload.nodeId==='main'||project.engineering.assignments.some(a=>a.nodeId===command.payload.nodeId)))await verifier().requireCurrent(project.id,command.payload.nodeId,command.payload.nodeId==='main'?'merged':'branch',command.payload.verificationId)
 if(command.operation==='merge_adopt'&&project.engineering){const observed=await inspectEngineering(project);if(!observed.baselineMatches||!observed.scopeMatches)throw new PolicyError('ENGINEERING_MERGE','代码基线或修改范围不一致，先核对再汇合')}
 const updated=store().apply(command);if(['decide_review','pause_branch','set_review_policy','inherit_review_policy'].includes(command.operation))void reviewer().tick().catch(e=>process.stderr.write(String(e)+'\n'));return {project:updated}
}))
server.registerTool('workspace_engineering_inspect',{description:'只读核对实际 Git 提交、工作树哈希、分支范围及越界文件。不是测试通过凭证。',inputSchema:{projectId:z.string().min(1),nodeId:z.string().min(1).optional()},_meta:APP_ONLY},async({projectId,nodeId})=>guarded(async()=>({observed:await inspectEngineering(store().get(projectId),nodeId)})))
server.registerTool('workspace_engineering_bind',{description:'显式建立或更新代码基线，使用实际 HEAD；要求干净仓库，不覆盖现有文件。',inputSchema:{commandId:z.string().uuid(),projectId:z.string().min(1),expectedRevision:z.number().int().nonnegative(),nodeId:z.string().min(1),repoPath:z.string().min(1),allowedPaths:z.array(z.string().min(1)).min(1),acceptance:z.array(z.string().min(1)).min(1),updateBaseline:z.boolean().default(false)},_meta:APP_ONLY},async input=>guarded(async()=>{
 const project=store().get(input.projectId),observed=await inspectRepository(input.repoPath)
 await requireIdleCodeRepository(store(),observed.repoPath);if(project.engineering)await requireIdleCodeRepository(store(),project.engineering.repoPath)
 if(observed.dirty)throw new PolicyError('BASELINE_DIRTY','仓库有未提交修改，先保存版本基线或选用已准备的隔离工作区')
 const old=project.engineering
 if(old&&(old.baseCommit!==observed.head||old.repoPath!==observed.repoPath)&&!input.updateBaseline)throw new PolicyError('BASELINE_DRIFT','仓库或提交已改变，请先核对，再明确选择更新基线')
 if(old&&old.repoPath!==observed.repoPath&&old.assignments.some(a=>a.nodeId!==input.nodeId))throw new PolicyError('ENGINEERING_REPO_CHANGE','其他代码分支仍绑定原仓库，请先处理它们的工程范围')
 const payload={repoPath:observed.repoPath,baseCommit:observed.head,contractVersion:String(SCHEMA_VERSION),assignments:[...(old?.assignments.filter(a=>a.nodeId!==input.nodeId)??[]),{nodeId:input.nodeId,allowedPaths:input.allowedPaths,acceptance:input.acceptance}],...(old?.leases?{leases:old.leases}:{}),verifications:old?.baseCommit===observed.head?old.verifications:[]}
 const checked=await inspectEngineering({...project,engineering:payload},input.nodeId)
 return {project:store().apply({commandId:input.commandId,projectId:input.projectId,expectedRevision:input.expectedRevision,operation:'set_engineering',payload}),observed:checked}
}))
server.registerTool('workspace_verification_start',{description:'显式执行选定代码检查，先落盘唯一请求；返回运行记录，报告关联提交/内容/验收条件。',inputSchema:{request:VerificationRequestSchema},_meta:APP_ONLY},async({request})=>guarded(async()=>({verification:await verifier().start(request)})))
server.registerTool('workspace_verification_current',{description:'核对最新报告能否证明当前代码，拒绝过期、失败或被新记录替代的报告。',inputSchema:{projectId:z.string().min(1),nodeId:z.string().min(1),purpose:z.enum(['branch','merged']),verificationId:z.string().uuid().optional()},_meta:APP_ONLY},async({projectId,nodeId,purpose,verificationId})=>guarded(async()=>({verification:await verifier().requireCurrent(projectId,nodeId,purpose,verificationId)})))
server.registerTool('workspace_verification_cancel',{description:'取消本连接创建的检查进程，不按进程名取消其他任务。',inputSchema:{verificationId:z.string().uuid()},_meta:APP_ONLY},async({verificationId})=>guarded(()=>({verification:verifier().cancel(verificationId)})))
server.registerTool('workspace_verification_log',{description:'读取已存档的完整验证日志；预览截断不替代原日志。',inputSchema:{verificationId:z.string().uuid(),stepIndex:z.number().int().nonnegative()},_meta:APP_ONLY},async({verificationId,stepIndex})=>guarded(()=>store().verificationLog(verificationId,stepIndex)))
server.registerTool('workspace_export',{description:'导出单任务的原文、版本、布局、上下文和运行记录到本地文件，回读校验。',inputSchema:{projectId:z.string().min(1)},_meta:APP_ONLY},async({projectId})=>guarded(async()=>({archive:await exportProject(store(),projectId)})))
server.registerTool('workspace_restore',{description:'校验并恢复本地任务导出文件。同一任务已存在时拒绝覆盖，运行和审批不重放。',inputSchema:{path:z.string().min(1)},_meta:APP_ONLY},async({path})=>guarded(async()=>restoreProject(store(),path)))
server.registerTool('canvas_propose',{description:'活动子 Bot 提交有来源的子任务或续聊提案。需当前运行凭证，只能操作自己的节点；授权不足时进入人工复核，不自动扩大工程范围。',inputSchema:{projectId:z.string().min(1),nodeId:z.string().min(1),sourceRunId:z.string().uuid(),authorization:z.string().uuid(),request:RemoteRequestSchema,planItemId:z.string().optional()}},async({projectId,nodeId,sourceRunId,authorization,request,planItemId})=>guarded(()=>reviewer().propose(projectId,nodeId,sourceRunId,authorization,request,planItemId)))
server.registerTool('workspace_review_submit',{description:'人工提交草案或确认派发，持久保存复核与子聊天首轮；可核查原派发记录。',inputSchema:{request:RemoteRequestSchema.optional(),confirmed:z.boolean().default(false),projectId:z.string().optional(),reviewId:z.string().uuid().optional()},_meta:APP_ONLY},async({request,confirmed,projectId,reviewId})=>guarded(async()=>{if(reviewId&&projectId)return reviewer().recover(projectId,reviewId);if(!request)throw new PolicyError('REVIEW_REQUEST','缺少复核请求');return reviewer().submit(request,confirmed)}))
server.registerTool('workspace_run_submit',{description:'按唯一命令 ID 对选定聊天分叉或启动轮次。由插件配置启用；仅按明确请求执行，不自动重发不确定请求。',inputSchema:{request:RemoteRequestSchema},_meta:APP_ONLY},async({request})=>guarded(async()=>({run:await manager().submit(request)})))
server.registerTool('workspace_run_recover',{description:'核对已发请求；必要时完成本插件新分支的自动目标隔离，不重新分叉或启动轮次。',inputSchema:{runId:z.string().uuid(),knownForkId:z.string().uuid().optional()},_meta:APP_ONLY},async({runId,knownForkId})=>guarded(async()=>({run:await manager().recover(runId,knownForkId)})))
server.registerTool('workspace_run_cancel',{description:'请求中断本插件已记录的目标轮次；回执不代表已结束。',inputSchema:{runId:z.string().uuid()},_meta:APP_ONLY},async({runId})=>guarded(async()=>({run:await manager().cancel(runId)})))
server.registerTool('workspace_run_respond',{description:'将用户明确选择的审批或输入回应送回原连接；不会自动批准。',inputSchema:{runId:z.string().uuid(),requestId:z.union([z.string(),z.number()]),response:z.record(z.unknown())},_meta:APP_ONLY},async({runId,requestId,response})=>guarded(()=>{manager().respond(runId,requestId,response);return {run:store().runViews().find(r=>r.id===runId)}}))
server.registerTool('codex_threads',{description:'按名称搜索本机 Codex 已保存聊天，支持分页。只读。',inputSchema:{limit:z.number().int().min(1).max(30).default(15),searchTerm:z.string().max(200).optional(),cursor:z.string().min(1).optional()}},async({limit,searchTerm,cursor})=>{
 const value=await codexRequest('thread/list',{limit,...(searchTerm?.trim()?{searchTerm:searchTerm.trim()}:{}),...(cursor?{cursor}:{}),sortKey:'updated_at'});return result({threads:(value.data??[]).map((t:any)=>({id:t.id,name:t.name,preview:t.preview,cwd:t.cwd,createdAt:t.createdAt,updatedAt:t.updatedAt})),nextCursor:value.nextCursor??null})
})
server.registerTool('codex_thread_read',{description:'按 ID 读取 Codex 对话。仅返回可见消息的有限片段和来源锚点，避免全量历史写入当前上下文。',inputSchema:{threadId:z.string().uuid(),limit:z.number().int().min(1).max(20).default(6)}},async({threadId,limit})=>{
 const r=await codexRequest('thread/read',{threadId,includeTurns:true});const turns=r.thread.turns??[]
 return result({threadId,savedTurns:turns.length,turns:turns.slice(-limit).map((t:any)=>({id:t.id,status:t.status,items:(t.items??[]).filter((i:any)=>['userMessage','agentMessage'].includes(i.type)).map((i:any)=>({id:i.id,type:i.type,text:(i.type==='agentMessage'?i.text:(i.content??[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')).slice(0,1800),excerpt:true}))})),compressionHistory:'unknown'})
})
server.registerResource('canvas-workspace',URI,{mimeType:'text/html;profile=mcp-app'},async()=>({contents:[{uri:URI,mimeType:'text/html;profile=mcp-app',text:UI_HTML,_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}}]}))
await server.connect(new StdioServerTransport())
process.stdin.once('end',()=>{remote?.close();verification?.close()})
