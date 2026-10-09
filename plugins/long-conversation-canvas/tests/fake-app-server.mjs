// Protocol fixture only. All changes stay in the isolated test JSON file; no Codex/model calls.
import {createInterface} from 'node:readline'
import {readFileSync,writeFileSync,renameSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
const file=process.env.FAKE_APP_STATE
let state=JSON.parse(readFileSync(file,'utf8'))
const output=message=>process.stdout.write(JSON.stringify(message)+'\n')
const save=()=>{const staged=file+'.'+process.pid+'.tmp';writeFileSync(staged,JSON.stringify(state));renameSync(staged,file)}
let waiting
const reply=(id,result)=>output({id,result})
const notify=(method,params)=>output({method,params})
function finish(threadId,turnId,status='completed'){
 state=JSON.parse(readFileSync(file,'utf8'))
 const thread=state.threads[threadId],turn=thread.turns.find(t=>t.id===turnId)
 turn.status=status;thread.status={type:'idle'}
 if(status==='completed')turn.items.push({id:turnId+'-answer',type:'agentMessage',text:'协议模拟回复🧭\n原文保留'})
 save();notify('turn/completed',{threadId,turn:structuredClone(turn)})
}
createInterface({input:process.stdin}).on('line',line=>{
 state=JSON.parse(readFileSync(file,'utf8'))
 const m=JSON.parse(line)
 if(m.method==='initialized')return
 if(m.method===undefined){state.responses.push(m);save();if(waiting){const w=waiting;waiting=null;finish(w.threadId,w.turnId,m.result?.decision==='decline'?'interrupted':'completed')}return}
 state.calls.push({method:m.method,params:m.params});save()
 if(m.method==='initialize'){reply(m.id,{userAgent:'fake-protocol-fixture'});return}
 if(m.method==='thread/read'){const thread=state.threads[m.params.threadId];thread?reply(m.id,{thread}):output({id:m.id,error:{code:-32602,message:'fixture thread missing'}});return}
 if(m.method==='thread/goal/get'){reply(m.id,{goal:state.goals?.[m.params.threadId]??null});return}
 if(m.method==='thread/goal/clear'){
  if(state.mode==='forkGoalClearFail'&&!state.clearFailures){state.clearFailures=1;save();output({id:m.id,error:{code:-32000,message:'fixture goal clear rejected'}});return}
  state.goals??={};const cleared=state.goals[m.params.threadId]!=null;state.goals[m.params.threadId]=null;save();reply(m.id,{cleared});return
 }
 if(m.method==='thread/resume'){reply(m.id,{thread:state.threads[m.params.threadId]});return}
 if(m.method==='thread/unsubscribe'){
  const thread=state.threads[m.params.threadId]
  if(thread?.turns.some(t=>t.status==='inProgress')){output({id:m.id,error:{code:-32600,message:'Cannot release active fixture turn'}});return}
  if(state.mode==='forkReleaseFail'){output({id:m.id,error:{code:-32600,message:'fixture ownership release rejected'}});return}
  reply(m.id,{status:'unsubscribed'});return
 }
 if(m.method==='thread/name/set'){state.threads[m.params.threadId].name=m.params.name;save();reply(m.id,{});return}
 if(m.method==='thread/start'){
  const child={id:randomUUID(),forkedFromId:null,cwd:m.params.cwd??'D:/fixture',status:{type:'idle'},turns:[]};
  if(state.mode==='delegateBad')child.turns=structuredClone(Object.values(state.threads)[0].turns);
  state.threads[child.id]=child;save();if(state.mode!=='delegateDropNoId')notify('thread/started',{thread:child});
  if(state.mode.startsWith('delegateDrop')){setTimeout(()=>process.exit(0),10);return}
  if(state.mode==='delegateLate'){setTimeout(()=>reply(m.id,{thread:child}),150);return}
  reply(m.id,{thread:child});return
 }
 if(m.method==='thread/fork'){
  const source=state.threads[m.params.threadId],cut=source.turns.findIndex(t=>t.id===m.params.lastTurnId)
  const child={...structuredClone(source),id:randomUUID(),forkedFromId:source.id,turns:structuredClone(source.turns.slice(0,cut+1))}
  if(state.mode==='forkBad')child.turns.push(structuredClone(source.turns.at(-1)))
  if(state.mode.startsWith('forkGoal')){state.goals??={};state.goals[source.id]={objective:'parent persistent goal',status:'active'};state.goals[child.id]=structuredClone(state.goals[source.id])}
  state.threads[child.id]=child;save()
  if(state.mode!=='forkDropNoId')notify('thread/started',{thread:child})
  if(state.mode.startsWith('forkDrop')){setTimeout(()=>process.exit(0),10);return}
  if(state.mode==='forkLate'){setTimeout(()=>reply(m.id,{thread:child}),150);return}
  reply(m.id,{thread:child});return
 }
 if(m.method==='turn/start'){
  if(state.mode==='turnStartReject'){output({id:m.id,error:{code:-32600,message:'fixture target already has an active writer'}});return}
  const thread=state.threads[m.params.threadId],turn={id:randomUUID(),status:'inProgress',items:[{id:m.params.clientUserMessageId,type:'userMessage',content:[{type:'text',text:m.params.input[0].text}]}],error:null}
  thread.turns.push(turn);thread.status={type:'active'};save()
  if(state.mode==='turnDrop'){thread.status={type:'notLoaded'};save();setTimeout(()=>process.exit(0),10);return}
  notify('item/started',{threadId:thread.id,turnId:turn.id,item:turn.items[0]})
  if(state.mode==='turnBeforeReply'){finish(thread.id,turn.id);reply(m.id,{turn:{...turn,status:'inProgress'}});return}
  if(state.mode==='turnApprovalBeforeReply'){
   waiting={threadId:thread.id,turnId:turn.id};output({id:900,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,command:'echo fixture'}});reply(m.id,{turn});return
  }
  reply(m.id,{turn})
  if(state.mode==='turnCompaction'){
   const item={id:'compaction-fixture-1',type:'contextCompaction'}
   notify('item/started',{threadId:thread.id,turnId:turn.id,item});notify('item/completed',{threadId:thread.id,turnId:turn.id,item})
  }
  if(state.mode==='turnApproval'){waiting={threadId:thread.id,turnId:turn.id};output({id:900,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,command:'echo fixture'}});return}
  if(state.mode==='turnUserInput'){waiting={threadId:thread.id,turnId:turn.id};output({id:901,method:'item/tool/requestUserInput',params:{threadId:thread.id,turnId:turn.id,itemId:'question-item',isBlocking:true,questions:[{id:'direction',header:'方向',question:'选择下一步',options:[{label:'检查',description:'检查来源'}]}]}});return}
  if(state.mode==='turnHold')return
  setTimeout(()=>finish(thread.id,turn.id),25);return
 }
 if(m.method==='turn/interrupt'){
  reply(m.id,{});setTimeout(()=>finish(m.params.threadId,m.params.turnId,'interrupted'),25);return
 }
 output({id:m.id,error:{code:-32601,message:'unknown fixture method'}})
})
