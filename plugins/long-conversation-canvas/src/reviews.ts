import {randomUUID} from 'node:crypto'
import {RemoteRequestSchema,type Project,type Review,type Run,type RunView} from './schema'
import {Store,PolicyError} from './store'
import {RemoteManager} from './remote'
import {automaticDecision,policyFor} from './governance'
export class ReviewManager{
 private ticking=false
 constructor(readonly store:Store,readonly remote:RemoteManager,readonly enabled:boolean){}
 async submit(input:unknown,confirmed=false){const request=RemoteRequestSchema.parse(input);this.store.enqueueReview(request.projectId,request.nodeId,request,'human',null,confirmed);await this.tick();return {project:this.store.get(request.projectId),review:this.store.get(request.projectId).reviews!.find(r=>r.id===request.commandId)!}}
 async propose(projectId:string,nodeId:string,sourceRunId:string,key:string,request:unknown,planItemId?:string){
  const source=this.store.authorizeProposal(sourceRunId,key);if(source.projectId!==projectId||source.nodeId!==nodeId||source.operation!=='turn')throw new PolicyError('PROPOSAL_TARGET','凭证不能用于其他任务')
  const parsed=RemoteRequestSchema.parse(request);if(parsed.commandId===sourceRunId)throw new PolicyError('COMMAND_REUSED','提案不能使用来源轮次 ID')
  this.store.enqueueReview(projectId,nodeId,parsed,'bot',sourceRunId,false,planItemId);await this.tick();const review=this.store.get(projectId).reviews!.find(r=>r.id===parsed.commandId)!;return {reviewId:review.id,status:review.status,reason:review.reason}
 }
 async tick(){if(this.ticking||!this.enabled)return;this.ticking=true;try{
  for(const project of this.store.list())for(const initial of project.reviews??[]){
   if(!['pending','approved','dispatching','created'].includes(initial.status))continue
   const p=this.store.get(project.id),review=p.reviews!.find(r=>r.id===initial.id)!,effective=policyFor(p,review.nodeId)
   if(effective.paused){if(review.reason!=='分支已暂停，停止新派发')this.update(p,review,{reason:'分支已暂停，停止新派发'});continue}
   if(review.sourceRunId){const source=this.store.run(review.sourceRunId);if(!source.terminalEvent){if(review.reason!=='等待来源轮次结束后再派发')this.update(p,review,{reason:'等待来源轮次结束后再派发'});continue}if(source.state!=='completed'&&!review.humanApproved){if(review.reason!=='来源轮次未正常完成，需要人工复核')this.update(p,review,{reason:'来源轮次未正常完成，需要人工复核'});continue}}
   if(review.status==='pending'){
    const reason=review.origin==='bot'?automaticDecision(p,review,RemoteRequestSchema.parse(review.request)):'等待人工复核'
    if(reason){if(review.reason!==reason)this.update(p,review,{reason});continue}
   }
   try{await this.dispatch(p,review)}catch(e){const latest=this.store.get(p.id).reviews!.find(r=>r.id===review.id)!;this.update(p,latest,{status:latest.executedRequest?'unknown':'failed',error:e instanceof Error?e.message:String(e),reason:'派发未完成，请人工核查原请求'})}
  }
 }finally{this.ticking=false}}
 private update(project:Project,review:Review,fields:Partial<Review>){return this.store.changeReview(project.id,review.id,r=>Object.assign(r,fields))}
 private async dispatch(project:Project,review:Review){
  let p=project,r=review
  // A stored request is reused byte-for-byte on recovery; no replacement command IDs.
  if(!r.executedRequest){p=this.store.changeReview(p.id,r.id,(v,current)=>{if(v.executedRequest)return;v.status='dispatching';v.reason=v.humanApproved?'人工已批准，正在派发':'符合已授予规则，正在派发';v.executedRequest=RemoteRequestSchema.parse({...v.request,expectedRevision:current.revision+1,reviewId:v.id})});r=p.reviews!.find(v=>v.id===r.id)!}

  const request=RemoteRequestSchema.parse(r.executedRequest);let run:Run|RunView|undefined=this.store.runs().find(v=>v.id===request.commandId)
  if(run&&run.state==='unknown'){this.update(p,r,{status:'unknown',runId:run.id,error:run.error,reason:'远端结果待核查，未重新发送'});return}
  if(run&&run.state==='failed'){this.update(p,r,{status:'failed',runId:run.id,error:run.error,reason:'远端明确失败，保留原记录'});return}
  if(!run)run=await this.remote.submit(request)
  if(!run)throw new PolicyError('REVIEW_RUN','未取得运行记录')
  if(['failed','unknown'].includes(run.state)){this.update(p,r,{status:run.state as 'failed'|'unknown',runId:run.id,error:run.error,reason:'请核查原请求，未重复创建'});return}
  if(request.operation==='turn'){this.update(p,r,{status:'completed',runId:run.id,reason:'已派发；执行结果在聊天运行记录中查看',error:null});return}
  if(request.operation!=='delegate'||run.state!=='completed'){this.update(p,r,{status:'unknown',runId:run.id,reason:'创建尚未核实，不自动重建'});return}
  p=this.store.get(p.id);const child=p.nodes.find(n=>n.task?.creationRunId===run!.id);if(!child)throw new PolicyError('REVIEW_CHILD','创建记录缺少对应子任务')
  r=p.reviews!.find(v=>v.id===review.id)!
  if(!r.firstRequest){p=this.store.changeReview(p.id,r.id,(v,current)=>{if(v.firstRequest)return;const context=current.contexts.filter(c=>c.nodeId===child.id).at(-1)!;Object.assign(v,{status:'created',runId:run.id,childNodeId:child.id,reason:'子聊天已建立，准备原任务首轮',firstRequest:{commandId:child.task!.initialTurnCommandId,projectId:current.id,expectedRevision:current.revision+1,operation:'turn',nodeId:child.id,contextId:context.id,message:child.task!.brief,reviewId:v.id}})});r=p.reviews!.find(v=>v.id===review.id)!}
  const first=RemoteRequestSchema.parse(r.firstRequest);let firstRun:Run|RunView|undefined=this.store.runs().find(v=>v.id===first.commandId)
  if(!firstRun){if(policyFor(this.store.get(p.id),child.id).paused)return;const current=this.store.get(p.id);if(first.expectedRevision!==current.revision){this.update(p,r,{status:'unknown',reason:'首轮派发前任务状态已变化，请人工核查并继续'});return}firstRun=await this.remote.submit(first)}
  this.update(p,r,{status:firstRun&&['failed','unknown'].includes(firstRun.state)?firstRun.state as 'failed'|'unknown':'completed',runId:first.commandId,childNodeId:child.id,error:firstRun?.error??null,reason:firstRun&&['failed','unknown'].includes(firstRun.state)?'子聊天已保留，首轮未完成；核查原请求后继续':'子任务已派发，成果先交给直接父任务'})
 }
 async recover(projectId:string,reviewId:string){
  const p=this.store.get(projectId),review=p.reviews?.find(r=>r.id===reviewId);if(!review)throw new PolicyError('REVIEW_MISSING','复核记录不存在')
  if(['completed','rejected'].includes(review.status))return {project:p}
  if(review.runId)await this.remote.recover(review.runId)
  this.store.changeReview(projectId,reviewId,(v,current)=>{
   v.status=v.childNodeId?'created':'approved';v.humanApproved=true;v.reason='人工核查并批准继续原派发';v.error=null
   // Rebase only a request proven never reserved/sent; existing remote requests stay immutable.
   const key=v.firstRequest?'firstRequest':v.executedRequest?'executedRequest':null
   if(key){const request=RemoteRequestSchema.parse(v[key]);if(!this.store.runs().some(run=>run.id===request.commandId))v[key]={...request,expectedRevision:current.revision+1}}
  })
  await this.tick();return {project:this.store.get(projectId)}
 }
}
