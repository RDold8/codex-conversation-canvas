import { version as PLUGIN_VERSION } from '../package.json'
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process'
import {createInterface,type Interface} from 'node:readline'
import {EventEmitter} from 'node:events'
export class TransportUncertain extends Error{constructor(message:string){super(message)}}
export class RemoteRejected extends Error{constructor(public rpcCode:number,message:string){super(message)}}
type Pending={resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>,method:string,tag?:string}
export type Notification={method:string,params:Record<string,any>}
export class CodexConnection extends EventEmitter{
 private child?:ChildProcessWithoutNullStreams
 private lines?:Interface
 private sequence=0
 private pending=new Map<number,Pending>()
 private abandoned=new Map<number,{method:string,tag?:string}>()
 private serverRequests=new Set<string>()
 private opening?:Promise<void>
 private ready=false
 private stderr=''
 constructor(private executable=process.env.CANVAS_CODEX_EXECUTABLE||'codex',private args=['app-server','--stdio'],private env:NodeJS.ProcessEnv=process.env){super()}
 get connected(){return this.ready&&this.child?.exitCode===null}
 async connect(){
  if(this.connected)return
  if(this.opening)return this.opening
  this.opening=this.open()
  try{await this.opening}finally{this.opening=undefined}
 }
 private async open(){
  const child=spawn(this.executable,this.args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:this.env});this.child=child
  child.stdin.on('error',e=>{if(this.child===child)this.disconnected(new TransportUncertain(`App Server 写入连接关闭：${e.message}`))})
  child.stderr.on('data',chunk=>{this.stderr=(this.stderr+String(chunk)).slice(-2000)})
  this.lines=createInterface({input:child.stdout});this.lines.on('line',line=>this.receive(line))
  child.on('error',e=>{if(this.child===child)this.disconnected(new TransportUncertain(`App Server 无法连接：${e.message}`))})
  child.on('exit',code=>{if(this.child===child)this.disconnected(new TransportUncertain(`App Server 连接关闭 (${code})`))})
  await this.send('initialize',{clientInfo:{name:'long_conversation_canvas',version:PLUGIN_VERSION},capabilities:{experimentalApi:true}},{timeoutMs:45000})
  this.write({method:'initialized'});this.ready=true
 }
 private write(value:unknown){
  if(!this.child||this.child.exitCode!==null||this.child.stdin.destroyed)throw new TransportUncertain('App Server 连接已关闭')
  this.child.stdin.write(JSON.stringify(value)+'\n',error=>{if(error)this.disconnected(new TransportUncertain(error.message))})
 }
 async request(method:string,params:Record<string,unknown>,options:{timeoutMs?:number,tag?:string}={}){await this.connect();return this.send(method,params,options)}
 private send(method:string,params:Record<string,unknown>,options:{timeoutMs?:number,tag?:string}){
  return new Promise<any>((resolve,reject)=>{
   const id=++this.sequence
   const timer=setTimeout(()=>{const request=this.pending.get(id);if(!request)return;this.pending.delete(id);this.abandoned.set(id,{method,tag:options.tag});reject(new TransportUncertain(`${method} 等待超时；操作可能已生效，须核查状态`))},options.timeoutMs??45000)
   this.pending.set(id,{resolve,reject,timer,method,tag:options.tag})
   try{this.write({id,method,params})}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e)}
  })
 }
 private receive(line:string){
  let message:any
  try{message=JSON.parse(line)}catch{this.emit('protocolFault',{message:'App Server 返回了非 JSON 协议行'});return}
  if(typeof message.method==='string'){
   if(message.id!==undefined){this.serverRequests.add(String(message.id));this.emit('serverRequest',{id:message.id,method:message.method,params:message.params??{}})}
   else this.emit('notification',{method:message.method,params:message.params??{}})
   return
  }
  if(typeof message.id!=='number'){this.emit('protocolFault',{message:'App Server 响应缺少有效请求 ID'});return}
  const pending=this.pending.get(message.id)
  if(!pending){const late=this.abandoned.get(message.id);if(late){this.abandoned.delete(message.id);this.emit('lateResponse',{...late,...message})}return}
  clearTimeout(pending.timer);this.pending.delete(message.id)
  if(message.error)pending.reject(new RemoteRejected(Number(message.error.code),String(message.error.message)))
  else if(Object.hasOwn(message,'result'))pending.resolve(message.result)
  else pending.reject(new TransportUncertain('App Server 响应缺少结果，须核查操作状态'))
 }
 respond(id:number|string,result:Record<string,unknown>){if(!this.connected||!this.serverRequests.has(String(id)))throw new TransportUncertain('该交互请求已不在当前连接，请重新核查运行状态');this.write({id,result});this.serverRequests.delete(String(id))}
 private disconnected(error:Error){
  this.ready=false;this.serverRequests.clear()
  for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error)}this.pending.clear()
  this.emit('disconnected',error)
 }
 close(){
  this.ready=false;this.lines?.close();this.child?.stdin.end()
  if(this.child?.exitCode===null)this.child.kill() // Only the child this instance spawned.
 }
 async waitForExit(timeoutMs=5000):Promise<void>{
  const child=this.child
  if(!child||child.exitCode!==null||child.signalCode!==null)return
  await new Promise<void>((resolve,reject)=>{
   const done=()=>{clearTimeout(timer);resolve()}
   const timer=setTimeout(()=>{child.off('exit',done);reject(new TransportUncertain('本操作的服务进程尚未退出，不能确认写入占用已释放'))},timeoutMs)
   child.once('exit',done)
  })
 }
}
