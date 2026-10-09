import { version as PLUGIN_VERSION } from '../package.json'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
export async function codexRequest(method:string,params:Record<string,unknown>):Promise<any>{
 const executable=process.env.CANVAS_CODEX_EXECUTABLE||'codex'
 const child=spawn(executable,['app-server','--stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true})
 let errors='';child.stderr.on('data',d=>{errors=(errors+d.toString()).slice(-2000)})
 const lines=createInterface({input:child.stdout});let seq=0
 const pending=new Map<number,{resolve:(x:any)=>void,reject:(e:Error)=>void}>()
 lines.on('line',line=>{try{const msg=JSON.parse(line);if(typeof msg.id==='number'){
  const p=pending.get(msg.id);if(p){pending.delete(msg.id);if(msg.error)p.reject(Error(JSON.stringify(msg.error)));else p.resolve(msg.result)}
 }}catch{/* Non-protocol output is not accepted as a successful result. */}})
 child.on('error',error=>{for(const p of pending.values())p.reject(error);pending.clear()})
 child.on('exit',code=>{for(const p of pending.values())p.reject(Error(`App Server exited (${code}): ${errors}`));pending.clear()})
 function request(method:string,params:unknown){return new Promise<any>((resolve,reject)=>{
  const id=++seq;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n')
 })}
 const deadline=setTimeout(()=>{for(const p of pending.values())p.reject(Error('App Server timed out'));pending.clear();child.kill()},45000)
 try{
  await request('initialize',{clientInfo:{name:'long_conversation_canvas',version:PLUGIN_VERSION}})
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
  return await request(method,params)
 }finally{clearTimeout(deadline);lines.close();child.stdin.end();if(child.exitCode===null)child.kill()}
}
