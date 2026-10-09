import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {mkdir,writeFile,realpath,stat} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {Store,PolicyError} from './store'
import {VerificationRequestSchema,type VerificationRequest,type Verification,type Project} from './schema'
import {allowedTarget,inspectEngineering,requireEngineering,requireIdleCodeRepository} from './engineering'
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
const now=()=>new Date().toISOString()
function fail(code:string,message:string):never{throw new PolicyError(code,message)}
function alive(pid:number|null){if(!pid)return false;try{process.kill(pid,0);return true}catch(e){return (e as NodeJS.ErrnoException).code==='EPERM'}}
function criteria(project:Project,request:VerificationRequest,repoPath:string){const engineering=project.engineering!;return hash(JSON.stringify({repoPath,baseCommit:engineering.baseCommit,contractVersion:engineering.contractVersion,purpose:request.purpose,trunkId:request.purpose==='merged'?project.activeTrunkId:project.nodes.find(n=>n.id===request.nodeId)?.trunkRevisionId,assignments:request.purpose==='merged'?engineering.assignments:engineering.assignments.filter(a=>a.nodeId===request.nodeId)}))}
async function observed(project:Project,request:VerificationRequest){
 if(request.purpose==='branch')return requireEngineering(project,request.nodeId)
 if(request.nodeId!=='main')fail('VERIFICATION_SCOPE','最终合并验证必须对应主干')
 const value=await inspectEngineering(project)
 if(!value.baselineMatches)fail('BASELINE_DRIFT','最终代码与工程基线不一致，先核对提交')
 if(!value.scopeMatches)fail('ENGINEERING_OUT_OF_SCOPE','最终代码包含未分配范围的改动')
 return value
}
export class VerificationManager{
 private jobs=new Map<string,{cancelled:boolean,child?:ChildProcessWithoutNullStreams}>()
 private closed=false
 constructor(readonly store:Store,readonly timeoutMs=120000){
  for(const r of store.verifications())if(r.status==='running'&&!alive(r.ownerPid))store.updateVerification(r.id,v=>{v.status='unknown';v.ownerPid=null;v.error='原验证进程已退出，未取得终态；不会自动再执行'})
 }
 async start(input:unknown){
  if(this.closed)fail('VERIFICATION_CLOSED','验证服务已关闭')
  const request=VerificationRequestSchema.parse(input),requestHash=hash(JSON.stringify(request)),prior=this.store.verifications().find(v=>v.id===request.commandId)
  if(prior){if(prior.requestHash!==requestHash)fail('COMMAND_REUSED','验证ID已被不同请求使用');return prior}
  const project=this.store.get(request.projectId)
  if(project.revision!==request.expectedRevision)fail('REVISION_CONFLICT','任务已改变，先刷新')
  const before=await observed(project,request)
  await requireIdleCodeRepository(this.store,before.repoPath)
  const record:Verification={id:request.commandId,projectId:project.id,nodeId:request.nodeId,purpose:request.purpose,request,requestHash,repoPath:before.repoPath,status:'running',testedCommit:before.head,beforeDigest:before.worktreeDigest,afterDigest:null,criteriaHash:criteria(project,request,before.repoPath),ownerPid:process.pid,childPid:null,createdAt:now(),updatedAt:now(),error:null,steps:[]}
  this.store.saveVerification(record);this.jobs.set(record.id,{cancelled:false})
  void this.run(record).catch(e=>{if(!this.closed&&this.store.verification(record.id).status==='running')this.store.updateVerification(record.id,v=>{v.status='failed';v.childPid=null;v.error=e instanceof Error?e.message:String(e)})}).finally(()=>this.jobs.delete(record.id))
  return this.store.verification(record.id)
 }
 private async program(root:string,step:VerificationRequest['steps'][number]){
  if(step.kind==='node'){
   const file=await allowedTarget(root,step.path);if(!(await stat(file)).isFile()||!/[.]([cm]?js)$/.test(file))fail('VERIFICATION_SCRIPT','请选择仓库内的 JavaScript 检查文件')
   const cwd=!step.cwd||step.cwd==='.'?root:await allowedTarget(root,step.cwd)
   if(!(await stat(cwd)).isDirectory())fail('VERIFICATION_PACKAGE','检查工作目录不存在或不是目录')
   return {cwd,args:[file,...step.args],label:`node ${step.path}${step.args.length?' '+step.args.join(' '):''}${step.cwd&&step.cwd!=='.'?` (cwd: ${step.cwd})`:''}`}
  }
  const cwd=step.packagePath==='.'?root:await allowedTarget(root,step.packagePath)
  if(!(await stat(cwd)).isDirectory())fail('VERIFICATION_PACKAGE','检查目录不存在')
  const relativeFile=step.kind==='build'?join(step.packagePath,'build.mjs'):join(step.packagePath,'node_modules/typescript/bin/tsc')
  const file=await allowedTarget(root,relativeFile);if(!(await stat(file)).isFile())fail('VERIFICATION_SCRIPT','检查入口不存在')
  return {cwd,args:[file,...(step.kind==='typecheck'?['--noEmit']:[])],label:step.kind==='build'?`node ${relativeFile}`:`tsc --noEmit (${step.packagePath})`}
 }
 private async execute(id:string,program:{cwd:string,args:string[],label:string},index:number){
  const job=this.jobs.get(id);if(!job||job.cancelled||this.closed)return null
  const child=spawn(process.execPath,program.args,{cwd:program.cwd,stdio:['pipe','pipe','pipe'],windowsHide:true});job.child=child;child.stdin.end()
  if(child.pid)this.store.updateVerification(id,v=>{v.childPid=child.pid!})
  const stdout:Buffer[]=[],stderr:Buffer[]=[];let count=0,limited=false,timedOut=false,error:string|null=null
  const capture=(list:Buffer[],data:Buffer)=>{if(limited)return;count+=data.length;list.push(Buffer.from(data));if(count>8*1024*1024){limited=true;error='验证输出超过8MB限额，不能认定通过';child.kill()}}
  child.stdout.on('data',data=>capture(stdout,data));child.stderr.on('data',data=>capture(stderr,data))
  const timer=setTimeout(()=>{timedOut=true;error='验证超过时限，已停止本次创建的检查进程';child.kill()},this.timeoutMs)
  const result=await new Promise<{code:number|null,signal:string|null}>(resolveResult=>{child.on('error',e=>{error=e.message});child.once('close',(code,signal)=>resolveResult({code,signal}))})
  clearTimeout(timer);job.child=undefined
  const out=Buffer.concat(stdout),err=Buffer.concat(stderr),log=Buffer.concat([Buffer.from('STDOUT\n'),out,Buffer.from('\nSTDERR\n'),err])
  const folder=join(dirname(this.store.path),'verification-logs');await mkdir(folder,{recursive:true});const path=join(folder,`${id}-${index}.log`);await writeFile(path,log,{flag:'wx'})
  if(!this.closed)this.store.saveVerificationLog(id,index,log)
  return {step:{label:program.label,exitCode:result.code,signal:result.signal,stdout:out.toString('utf8').slice(0,16000),stderr:err.toString('utf8').slice(0,16000),logPath:path,logSha256:hash(log),outputTruncated:limited||out.length>16000||err.length>16000},error,failed:result.code!==0||limited||timedOut}
 }
 private async run(record:Verification){
  for(const [index,step] of record.request.steps.entries()){
   const program=await this.program(record.repoPath,step),result=await this.execute(record.id,program,index)
   if(!result)return
   const current=this.store.verification(record.id)
   if(current.status!=='running'||this.closed)return
   this.store.updateVerification(record.id,v=>{v.steps.push(result.step);v.childPid=null})
   if(result.failed){this.store.updateVerification(record.id,v=>{v.status='failed';v.error=result.error??`检查退出码 ${result.step.exitCode}`});return}
  }
  const current=this.store.verification(record.id);if(current.status!=='running'||this.closed)return
  const project=this.store.get(record.projectId),after=await observed(project,record.request)
  this.store.updateVerification(record.id,v=>{v.afterDigest=after.worktreeDigest;v.childPid=null;if(after.worktreeDigest!==v.beforeDigest||criteria(project,v.request,after.repoPath)!==v.criteriaHash){v.status='changed';v.error='验证期间代码或验收条件变化，需核对后针对当前内容重新验证'}else{v.status='passed';v.error=null}})
  // Populate the existing evidence reference contract; text alone never satisfies the live gate.
  const report=this.store.verification(record.id)
  const fresh=this.store.get(record.projectId)
  if(report.status==='passed'&&criteria(fresh,report.request,report.repoPath)!==report.criteriaHash){this.store.updateVerification(record.id,v=>{v.status='changed';v.error='验收条件已改变，请刷新并重新核查'});return}
  if(report.status==='passed'&&fresh.engineering&&report.purpose==='branch'){
   const verification={nodeId:report.nodeId,testedCommit:report.testedCommit,commands:report.steps.map(s=>s.label),evidence:`verification:${report.id}`}
   this.store.apply({commandId:randomUUID(),projectId:fresh.id,expectedRevision:fresh.revision,operation:'set_engineering',payload:{...fresh.engineering,verifications:[...fresh.engineering.verifications.filter(v=>v.nodeId!==report.nodeId),verification]}})
  }
 }
 async requireCurrent(projectId:string,nodeId:string,purpose:'branch'|'merged',id?:string){
  const project=this.store.get(projectId),report=this.store.verifications().find(r=>r.projectId===projectId&&r.nodeId===nodeId&&r.purpose===purpose)
  if(id&&report?.id!==id)fail('VERIFICATION_SUPERSEDED','已有更近的验证记录，不能跳过它使用旧报告')
  if(!report||report.status!=='passed')fail('VERIFICATION_REQUIRED','需要最近一次实际执行并通过的对应代码验证报告')
  const current=await observed(project,report.request)
  await requireIdleCodeRepository(this.store,current.repoPath)
  if(current.head!==report.testedCommit||current.worktreeDigest!==report.afterDigest||criteria(project,report.request,current.repoPath)!==report.criteriaHash)fail('VERIFICATION_STALE','代码、提交或验收条件已变化，旧验证报告不能证明当前结果')
  return report
 }
 cancel(id:string){const report=this.store.verification(id),job=this.jobs.get(id);if(report.status!=='running')return report;if(!job)fail('VERIFICATION_CONNECTION_LOST','原检查不由当前连接持有，不能误取消其他进程');job.cancelled=true;job.child?.kill();return this.store.updateVerification(id,v=>{v.status='cancelled';v.error='用户取消本次验证';v.childPid=null})}
 close(){this.closed=true;for(const [id,job] of this.jobs){job.cancelled=true;job.child?.kill();if(this.store.verification(id).status==='running')this.store.updateVerification(id,v=>{v.status='unknown';v.ownerPid=null;v.childPid=null;v.error='验证连接关闭，原请求不会自动重跑'})}}
}
