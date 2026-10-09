import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {realpath,readFile,lstat,stat,readlink} from 'node:fs/promises'
import {resolve,relative,isAbsolute,dirname,normalize,sep} from 'node:path'
import {createHash} from 'node:crypto'
import {EngineeringSchema,EngineeringObservationSchema,SCHEMA_VERSION,type Project} from './schema'
import {PolicyError,type Store} from './store'
import {activeAssignments} from './governance'
const execute=promisify(execFile)
const digest=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex')
function fail(code:string,message:string):never{throw new PolicyError(code,message)}
const key=(path:string)=>process.platform==='win32'?normalize(path).toLowerCase():normalize(path)
function inside(root:string,path:string){const r=relative(root,path);return r===''||(!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r))}
async function canonicalTarget(path:string):Promise<string>{try{return await realpath(path)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=dirname(path);if(parent===path)throw e;return resolve(await canonicalTarget(parent),relative(parent,path))}}
export async function allowedTarget(root:string,path:string){
 if(!path.trim()||isAbsolute(path)||/^[A-Za-z]:/.test(path)||path.includes('\0')||/[*?]/.test(path)||path.split(/[\\/]/).some(s=>s==='..'||s.toLowerCase()==='.git'))fail('PATH_ESCAPE','写入范围须为仓库内相对路径；“.”表示整个项目，不能包含 Git 元数据或逃逸路径')
 const target=await canonicalTarget(resolve(root,path))
 if(!inside(root,target))fail('PATH_ESCAPE','范围经过链接后落在仓库之外')
 return target
}
async function git(root:string,args:string[]){try{return (await execute('git',['-c','core.quotepath=false','-C',root,...args],{windowsHide:true,timeout:15000,maxBuffer:8*1024*1024,encoding:'utf8'})).stdout}catch(e){fail('GIT_INSPECTION_FAILED',`Git 核查失败：${(e as Error).message}`)}}
export async function inspectRepository(repoPath:string){
 if(!isAbsolute(repoPath))fail('REPO_PATH','仓库须为绝对路径')
 const root=await realpath(repoPath),top=await realpath((await git(root,['rev-parse','--show-toplevel'])).trim())
 if(key(root)!==key(top))fail('REPO_ROOT','请选择仓库根目录，不能把仓库子目录当成独立基线')
 const head=(await git(root,['rev-parse','--verify','HEAD^{commit}'])).trim()
 const names=(await git(root,['ls-files','--cached','--others','--exclude-standard','-z'])).split('\0').filter(Boolean)
 const files:{path:string,sha256:string,status:string}[]=[]
 for(const path of [...new Set(names)].sort()){
  const target=resolve(root,path);if(!inside(root,target))fail('PATH_ESCAPE','Git 返回的文件名超出根目录')
  try{
   const info=await lstat(target)
   if(info.isSymbolicLink()){
    if(!inside(root,await realpath(target)))fail('PATH_ESCAPE','仓库文件链接到外部内容，须先核查范围')
    files.push({path,sha256:digest(await readlink(target)),status:'symlink'});continue
   }
   if(!info.isFile()&&!info.isSymbolicLink())fail('UNSUPPORTED_REPO_ENTRY','目录或子模块需要单独建立工程基线')
   if((await stat(target)).size>32*1024*1024)fail('ENGINEERING_FILE_LIMIT','单文件超过工程核查限额，请为它单独建立验证范围')
   files.push({path,sha256:digest(await readFile(target)),status:'present'})
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')files.push({path,sha256:digest('deleted'),status:'deleted'});else throw e}
 }
 const raw=await git(root,['status','--porcelain=v1','-z','--untracked-files=all']),parts=raw.split('\0').filter(Boolean)
 const changes:{path:string,status:string}[]=[]
 for(let i=0;i<parts.length;i++){const status=parts[i].slice(0,2);changes.push({path:parts[i].slice(3),status});if(/[RC]/.test(status)&&parts[i+1])changes.push({path:parts[++i],status:'rename-source'})}
 return {repoPath:root,head,dirty:changes.length>0,changes,fileCount:files.length,worktreeDigest:digest(JSON.stringify({head,files,raw})),checkedAt:new Date().toISOString()}
}
export async function inspectEngineering(project:Project,nodeId?:string){
 if(!project.engineering)fail('ENGINEERING_MISSING','尚未建立工程基线')
 const engineering=EngineeringSchema.parse(project.engineering),snapshot=await inspectRepository(engineering.repoPath)
 if(engineering.contractVersion!==String(SCHEMA_VERSION))fail('CONTRACT_DRIFT','工程接口版本与当前插件 schema 不一致')
 const actual=(await git(snapshot.repoPath,['rev-parse','--verify',`${engineering.baseCommit}^{commit}`])).trim()
 if(actual!==engineering.baseCommit)fail('BASELINE_INVALID','基线不是完整提交标识')
 const assignments=await Promise.all(activeAssignments(engineering).map(async a=>({...a,targets:await Promise.all(a.allowedPaths.map(path=>allowedTarget(snapshot.repoPath,path)))})))
 for(let i=0;i<assignments.length;i++)for(let j=i+1;j<assignments.length;j++)if(assignments[i].nodeId!==assignments[j].nodeId&&assignments[i].targets.some(a=>assignments[j].targets.some(b=>inside(a,b)||inside(b,a))))fail('ENGINEERING_OVERLAP','实际路径或目录链接使分支范围重叠')
 const assignment=nodeId?assignments.find(a=>a.nodeId===nodeId):null
 if(nodeId&&!assignment)fail('ENGINEERING_UNASSIGNED','当前节点没有代码任务范围')
 const changes=await Promise.all(snapshot.changes.map(async change=>{
  const path=await canonicalTarget(resolve(snapshot.repoPath,change.path))
  if(!inside(snapshot.repoPath,path))fail('PATH_ESCAPE','修改文件经链接后超出仓库')
  const owners=assignments.filter(a=>a.targets.some(t=>inside(t,path))).map(a=>a.nodeId)
  return {...change,owners,inScope:assignment?owners.includes(assignment.nodeId):owners.length>0}
 }))
 return EngineeringObservationSchema.parse({...snapshot,baseCommit:actual,baselineMatches:snapshot.head===actual,nodeId:nodeId??null,changes,scopeMatches:changes.every(c=>c.inScope)})
}
export async function requireEngineering(project:Project,nodeId:string){const observed=await inspectEngineering(project,nodeId);if(!observed.baselineMatches)fail('BASELINE_DRIFT','实际 HEAD 已偏离任务基线，请核对差异后显式更新基线');if(!observed.scopeMatches)fail('ENGINEERING_OUT_OF_SCOPE','当前修改超出本节点范围，不能作为该分支成果汇入');return observed}
export async function requireIdleCodeRepository(store:Store,repoPath:string,excludeRunId?:string){
 for(const run of store.runs().filter(r=>r.id!==excludeRunId&&r.operation==='turn'&&['prepared','dispatching','running','awaiting_user','unknown'].includes(r.state))){
  const event=store.db.prepare("SELECT body FROM remote_events WHERE run_id=? AND method='engineering/before' ORDER BY rowid DESC LIMIT 1").get(run.id)
  const project=store.get(run.projectId),source=event?JSON.parse(String(event.body)).repoPath:project.engineering&&activeAssignments(project.engineering).some(a=>a.nodeId===run.nodeId)?project.engineering.repoPath:null
  if(source&&key(await realpath(source))===key(repoPath))fail('ENGINEERING_REPO_BUSY','同一仓库还有未结束或状态未知的代码任务，先核查它，避免并发覆盖')
 }
}
