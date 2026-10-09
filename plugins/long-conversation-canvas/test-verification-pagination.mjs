import {build} from 'esbuild'
import {mkdir,mkdtemp,writeFile,readFile,realpath,rm} from 'node:fs/promises'
import {resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {randomUUID,createHash} from 'node:crypto'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true});const root=await realpath('../../runtime'),dir=await mkdtemp(resolve(root,'verification-page-'))
await build({entryPoints:['src/store.ts','src/verification.ts','src/archive.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outdir:dir,outExtension:{'.js':'.mjs'}})
const {Store}=await import(pathToFileURL(resolve(dir,'store.mjs')).href),{VerificationManager}=await import(pathToFileURL(resolve(dir,'verification.mjs')).href),{exportProject,restoreProject}=await import(pathToFileURL(resolve(dir,'archive.mjs')).href)
const repo=resolve(dir,'repo');await mkdir(resolve(repo,'src'),{recursive:true});await mkdir(resolve(repo,'tests'))
await writeFile(resolve(repo,'src/code.txt'),'初始代码🧭\n');await writeFile(resolve(repo,'.gitignore'),'marker.txt\n')
await writeFile(resolve(repo,'tests/pass.mjs'),"import {readFileSync,writeFileSync} from 'node:fs';let n=0;try{n=Number(readFileSync('marker.txt','utf8'))}catch{};writeFileSync('marker.txt',String(n+1));console.log('真实子进程日志🧭');")
await writeFile(resolve(repo,'tests/fail.mjs'),"console.error('检查失败证据');process.exit(7)")
await writeFile(resolve(repo,'tests/change.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync('src/code.txt','检查期间改变了代码')")
await writeFile(resolve(repo,'tests/hold.mjs'),"setTimeout(()=>console.log('完成'),10000)")
await writeFile(resolve(repo,'tests/large.mjs'),"console.log('完整日志🧭'.repeat(6000))")
await mkdir(resolve(repo,'package/src'),{recursive:true})
await writeFile(resolve(repo,'package/src/input.txt'),'selected directory fixture')
await writeFile(resolve(repo,'tests/cwd.mjs'),"import {readFileSync} from 'node:fs';console.log(readFileSync('src/input.txt','utf8'))")
const git=(...args)=>execFileSync('git',['-c','user.name=Isolated verification fixture','-c','user.email=fixture@localhost','-c','core.autocrlf=false','-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim()
git('init','-q');git('add','.');git('commit','-qm','isolated verification baseline')
let store=new Store(resolve(dir,'data/tasks.sqlite'));const managers=[],stores=[store],cases=[]
const thread='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const fixture=(start,count)=>({id:thread,turns:Array.from({length:count},(_,i)=>({id:'turn-'+(i+start),status:'completed',items:[{id:'u-'+(i+start),type:'userMessage',content:[{type:'text',text:`原文${i+start}🧭\n空格  与标点。`}]},{id:'a-'+(i+start),type:'agentMessage',text:`回复${i+start}`}]}))})
function pass(name,fn){fn();cases.push({name,status:'PASS'})}
async function reject(code,fn){await assert.rejects(fn,e=>e.code===code);cases.push({name:code,status:'PASS'})}
async function wait(id){for(let i=0;i<300;i++){const record=store.verification(id);if(record.status!=='running')return record;await new Promise(r=>setTimeout(r,20))}throw Error('Verification fixture timeout')}
try{
 store.importThread(fixture(1,130),thread);let page=store.sourcePage(thread),all=page.anchors;const firstCursor=page.nextCursor
 store.importThread(fixture(131,3),thread)
 while(page.nextCursor){page=store.sourcePage(thread,page.nextCursor);all=[...page.anchors,...all]}
 pass('跨页完整原文且新消息不会挤乱旧范围',()=>{assert.equal(all.length,260);assert.equal(new Set(all.map(a=>a.id)).size,260);assert.equal(all[0].text,'原文1🧭\n空格  与标点。');assert.equal(all.at(-1).text,'回复130')})
 pass('重新读取可看到新消息',()=>assert.equal(store.sourcePage(thread).anchors.at(-1).text,'回复133'))
 assert.throws(()=>store.sourcePage(other,firstCursor),e=>e.code==='SOURCE_CURSOR');cases.push({name:'分页身份不匹配拒绝',status:'PASS'})
 const foreign=new Store(resolve(dir,'foreign/tasks.sqlite'));stores.push(foreign);assert.throws(()=>foreign.sourcePage(thread,firstCursor),e=>e.code==='SOURCE_CURSOR');cases.push({name:'跨数据库分页位置拒绝',status:'PASS'})
 const original=all[0];let p=store.create({commandId:randomUUID(),title:'验证任务',primaryThreadId:thread,statements:[{text:'保存原文和代码验收',authority:'user',hard:true,anchorIds:[original.id]}]})
 p=store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation:'set_engineering',payload:{repoPath:repo,baseCommit:git('rev-parse','HEAD'),contractVersion:'2',assignments:[{nodeId:'main',allowedPaths:['src'],acceptance:['执行检查并核对来源']}],verifications:[]}})
 const manager=new VerificationManager(store);managers.push(manager)
 const request=(path,purpose='branch')=>({commandId:randomUUID(),projectId:p.id,expectedRevision:store.get(p.id).revision,nodeId:'main',purpose,steps:[{kind:'node',path,args:[]}]})
 const initial=request('tests/pass.mjs'),started=await manager.start(initial),passed=await wait(started.id)
 pass('执行真实检查并保留退出码/完整日志/哈希',()=>{assert.equal(passed.status,'passed');assert.equal(passed.steps[0].exitCode,0);assert(store.verificationLog(passed.id,0).text.includes('真实子进程日志🧭'));assert.equal(passed.beforeDigest,passed.afterDigest)})
 await manager.start(initial);pass('重复请求不再次执行脚本',()=>assert.equal(Number(execFileSync(process.execPath,['-e',"console.log(require('fs').readFileSync('marker.txt','utf8'))"],{cwd:repo,encoding:'utf8'})),1))
 await reject('COMMAND_REUSED',()=>manager.start({...initial,steps:[{kind:'node',path:'tests/fail.mjs',args:[]}]}))
 await manager.requireCurrent(p.id,'main','branch',passed.id);cases.push({name:'当前代码与执行报告一致时可采纳',status:'PASS'})
 const archive=await exportProject(store,p.id),restored=new Store(resolve(dir,'restored/tasks.sqlite'));stores.push(restored);await restoreProject(restored,archive.path)
 pass('归档恢复保留完整验证日志而不冒充当前通过',()=>{assert.equal(restored.verification(passed.id).status,'unknown');assert.equal(restored.verificationLog(passed.id,0).bodyBase64,store.verificationLog(passed.id,0).bodyBase64)})
 const malformed=new Store(resolve(dir,'malformed/tasks.sqlite'));stores.push(malformed)
 const invalidArchive=JSON.parse(await readFile(archive.path,'utf8'));invalidArchive.data.verification_runs[0].id=randomUUID();invalidArchive.sha256=createHash('sha256').update(JSON.stringify(invalidArchive.data)).digest('hex');const invalidPath=resolve(dir,'invalid-verification.json');await writeFile(invalidPath,JSON.stringify(invalidArchive));await reject('ARCHIVE_VERIFICATION',()=>restoreProject(malformed,invalidPath))
 const invalidLog=JSON.parse(await readFile(archive.path,'utf8'));invalidLog.data.verification_logs[0].id='wrong-log-id';invalidLog.sha256=createHash('sha256').update(JSON.stringify(invalidLog.data)).digest('hex');await writeFile(invalidPath,JSON.stringify(invalidLog));await reject('ARCHIVE_VERIFICATION_LOG',()=>restoreProject(malformed,invalidPath));pass('验证归档拒绝后不产生半恢复任务',()=>assert.equal(malformed.list().length,0))
 await writeFile(resolve(repo,'src/code.txt'),'代码在报告后变化');await reject('VERIFICATION_STALE',()=>manager.requireCurrent(p.id,'main','branch',passed.id));git('checkout','--','src/code.txt')
 p=store.get(p.id);store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation:'set_engineering',payload:{...p.engineering,assignments:[{...p.engineering.assignments[0],acceptance:['新的验收条件']}]}})
 await reject('VERIFICATION_STALE',()=>manager.requireCurrent(p.id,'main','branch',passed.id))
 const failed=await manager.start(request('tests/fail.mjs'));assert.equal((await wait(failed.id)).status,'failed');await reject('VERIFICATION_SUPERSEDED',()=>manager.requireCurrent(p.id,'main','branch',passed.id))
 const changed=await manager.start(request('tests/change.mjs'));const changedReport=await wait(changed.id);pass('检查期间代码改变不能宣称通过',()=>assert.equal(changedReport.status,'changed'));git('checkout','--','src/code.txt')
 const held=await manager.start(request('tests/hold.mjs'));await reject('VERIFICATION_BUSY',()=>manager.start(request('tests/pass.mjs')));manager.cancel(held.id);assert.equal(store.verification(held.id).status,'cancelled');cases.push({name:'取消仅处理本管理器创建的检查',status:'PASS'})
 const timeoutManager=new VerificationManager(store,100);managers.push(timeoutManager);const timeout=await timeoutManager.start(request('tests/hold.mjs'));const terminal=await wait(timeout.id);pass('检查超时不能宣称完成',()=>{assert.equal(terminal.status,'failed');assert(terminal.error.includes('时限'))})
 const merged=await manager.start(request('tests/pass.mjs','merged'));await wait(merged.id);await manager.requireCurrent(p.id,'main','merged',merged.id);cases.push({name:'最终代码报告独立于分支报告',status:'PASS'})
 const large=await manager.start(request('tests/large.mjs'));const largeReport=await wait(large.id);pass('界面日志截断不丢失数据库完整原文',()=>{assert.equal(largeReport.status,'passed');assert.equal(largeReport.steps[0].outputTruncated,true);const log=store.verificationLog(large.id,0);assert(log.text.length>30000);assert(log.text.endsWith('\nSTDERR\n'));assert(largeReport.steps[0].stdout.length<=16000)})
 p=store.get(p.id);p=store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation:'build_context',payload:{nodeId:'main',anchorIds:[original.id],packageIds:[],excluded:[],budget:20000}})
 const writer=store.prepareRemote({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,nodeId:'main',operation:'turn',contextId:p.contexts.at(-1).id,message:'隔离日志，不发往真实Codex'})
 await reject('ENGINEERING_REPO_BUSY',()=>manager.start(request('tests/pass.mjs')))
 await reject('ENGINEERING_REPO_BUSY',()=>manager.requireCurrent(p.id,'main','merged',merged.id))
 store.updateRun(writer.id,r=>{r.state='unknown'})
 await reject('ENGINEERING_REPO_BUSY',()=>manager.start(request('tests/pass.mjs')))
 store.updateRun(writer.id,r=>{r.state='completed';r.terminalEvent=true})
 await manager.requireCurrent(p.id,'main','merged',merged.id);cases.push({name:'结束代码任务后可核对当前报告',status:'PASS'})
 const cwdRequest={...request('tests/cwd.mjs'),steps:[{kind:'node',path:'tests/cwd.mjs',args:[],cwd:'package'}]}
 const cwdRun=await manager.start(cwdRequest),cwdReport=await wait(cwdRun.id)
 pass('JavaScript检查使用明确工作目录而脚本路径仍相对仓库',()=>{assert.equal(cwdReport.status,'passed');assert(cwdReport.steps[0].stdout.includes('selected directory fixture'));assert(cwdReport.steps[0].label.includes('cwd: package'))})
 await manager.start(cwdRequest);pass('包含工作目录的同一请求不重复执行',()=>assert.equal(store.verification(cwdRun.id).id,cwdRun.id))
 await reject('COMMAND_REUSED',()=>manager.start({...cwdRequest,steps:[{...cwdRequest.steps[0],cwd:'tests'}]}))
 const escape=await manager.start({...request('tests/cwd.mjs'),steps:[{kind:'node',path:'tests/cwd.mjs',args:[],cwd:'../outside'}]}),escapeReport=await wait(escape.id)
 pass('工作目录逃逸在启动子进程前拒绝',()=>{assert.equal(escapeReport.status,'failed');assert.equal(escapeReport.steps.length,0);assert.equal(escapeReport.childPid,null);assert(escapeReport.error.includes('逃逸'))})
 const report={status:'PASS',case_count:cases.length,cases,scope:'isolated real Node checks, Git and SQLite; no user chat mutations',model_calls:0,codex_chat_writes:0,native_ui_verified:false};await writeFile('../../evidence/verification-pagination-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'PASS',case_count:cases.length,model_calls:0,codex_chat_writes:0}))
}finally{for(const m of managers)m.close();await new Promise(r=>setTimeout(r,100));for(const s of stores)s.close();const target=await realpath(dir);assert(!relative(root,target).startsWith('..'));await rm(target,{recursive:true,force:true})}
