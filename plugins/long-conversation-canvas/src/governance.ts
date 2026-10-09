import {ReviewPolicySchema,type Project,type Review,type RemoteRequest} from './schema'
export const policyNames=['逐项复核','任务内放权','分支内放权','范围内自主'] as const
export function lineage(project:Project,nodeId:string){const result:Project['nodes']=[],seen=new Set<string>();let node=project.nodes.find(n=>n.id===nodeId);while(node&&!seen.has(node.id)){seen.add(node.id);result.push(node);node=project.nodes.find(n=>n.id===node!.parentId)}return result}
export function policyFor(project:Project,nodeId:string){
 const chain=lineage(project,nodeId),owner=chain.find(n=>n.reviewPolicy),policy=owner?.reviewPolicy??ReviewPolicySchema.parse({level:1}),grantNodeId=owner?.id??chain.at(-1)?.id??nodeId
 const paused=chain.some(n=>n.reviewPolicy?.paused),expired=Boolean(policy.expiresAt&&Date.parse(policy.expiresAt)<=Date.now())||chain.some(n=>n.status==='done')
 const policyHash=JSON.stringify({grantNodeId,policy,paused,expired})
 return {policy,grantNodeId,paused,expired,policyHash,inherited:owner?owner.id!==nodeId:chain.length>1,depth:chain.findIndex(n=>n.id===grantNodeId)}
}
export function activeAssignments(engineering:NonNullable<Project['engineering']>){return engineering.assignments.filter(a=>!engineering.leases?.some(l=>(l.state==='active'&&l.sourceNodeId===a.nodeId)||(l.state==='released'&&l.childNodeId===a.nodeId)))}
export function automaticDecision(project:Project,review:Review,request:RemoteRequest):string|null{
 const effective=policyFor(project,review.nodeId),{policy}=effective
 if(effective.paused)return '此分支已暂停，等待人工恢复'
 if(effective.expired)return '授权已到期或任务已结束，需要人工复核'
 if(effective.policyHash!==review.policyHash)return '授权设置已经变化，需要重新复核'
 if(policy.level<2)return '当前档位要求人工确认新的任务或自动续聊'
 if(policy.level===2){const item=policy.plan.find(item=>item.id===review.planItemId);if(!item)return '分支档仅允许执行已确认计划条目';const text=request.operation==='delegate'?request.task:request.operation==='turn'?request.message:'';if(text.trim()!==item.text.trim())return '任务正文与已确认计划不一致，需要人工复核'}
 if(request.operation==='fork')return '完整历史分叉需要人工操作'
 if(request.operation==='delegate'){
  if(request.parentId!==review.nodeId||request.topic)return '改变归属或提取独立专题需要人工复核'
  if(effective.depth+1>policy.maxDepth)return '继续分派会超过授权深度'
  if(project.nodes.filter(n=>n.parentId===review.nodeId&&n.status!=='done').length>=policy.maxChildren)return '未完成子任务数量达到授权上限'
  if(request.scopeAccess==='project')return '扩大到整个项目需要人工复核'
  if(request.mode==='code'&&!activeAssignments(project.engineering??{assignments:[],verifications:[],repoPath:'',baseCommit:'',contractVersion:''}).some(a=>a.nodeId===review.nodeId))return '来源任务没有可交接的有效代码范围'
 }
 const used=(project.reviews??[]).filter(r=>r.id!==review.id&&r.origin==='bot'&&r.grantNodeId===effective.grantNodeId&&['dispatching','created','completed','unknown'].includes(r.status)).length
 if(used>=policy.maxActions)return '自动动作额度已用完，需要人工复核'
 return null
}
