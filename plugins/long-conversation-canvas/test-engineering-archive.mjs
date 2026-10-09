import {build} from 'esbuild'
import {mkdir,mkdtemp,writeFile,readFile,realpath,rm,symlink} from 'node:fs/promises'
import {resolve,relative} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true});const root=await realpath('../../runtime'),dir=await mkdtemp(resolve(root,'engineering-archive-'))
await build({entryPoints:['src/store.ts','src/engineering.ts','src/archive.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outdir:dir,outExtension:{'.js':'.mjs'}})
const {Store}=await import(pathToFileURL(resolve(dir,'store.mjs')).href),{inspectRepository,inspectEngineering,requireEngineering,allowedTarget}=await import(pathToFileURL(resolve(dir,'engineering.mjs')).href),{exportProject,restoreProject,validateArchive}=await import(pathToFileURL(resolve(dir,'archive.mjs')).href)
const repo=resolve(dir,'工程'),outside=resolve(dir,'outside');await mkdir(resolve(repo,'src'),{recursive:true});await mkdir(outside)
const git=(...args)=>execFileSync('git',['-c','user.name=Isolated test fixture','-c','user.email=fixture@localhost','-c','core.autocrlf=false','-C',repo,...args],{encoding:'utf8',windowsHide:true}).trim()
git('init','-q');await writeFile(resolve(repo,'src/接口.txt'),'基线🧭\n');await writeFile(resolve(repo,'README.md'),'工程说明\n');git('add','.');git('commit','-qm','isolated baseline');const base=git('rev-parse','HEAD')
const cases=[],stores=[]
function pass(name,fn){fn();cases.push({name,status:'PASS'})}
async function reject(code,fn){await assert.rejects(fn,e=>e.code===code);cases.push({name:code,status:'PASS'})}
function newStore(name){const store=new Store(resolve(dir,name,'tasks.sqlite'));stores.push(store);return store}
const primary='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
const fixture=(id,status='completed')=>({id,turns:[{id:'turn-1',status,items:[{type:'userMessage',id:'u1',content:[{type:'text',text:'精确原文🧭\n空格  保留。'}]},{id:'a1',type:'agentMessage',text:'助手建议'},{id:'tool-1',type:'commandExecution',command:'fixture',aggregatedOutput:'完整工具结果\n🧭'}]}]})
try{
 const store=newStore('original');store.importThread(fixture(primary,'inProgress'),primary);await new Promise(r=>setTimeout(r,3));store.importThread(fixture(primary),primary);store.importThread(fixture(other),other)
 const source=store.anchors(primary).find(a=>a.role==='user'),branchSource=store.anchors(other).find(a=>a.role==='user')
 let p=store.create({commandId:randomUUID(),title:'可恢复长任务',primaryThreadId:primary,statements:[{text:'保存主干和原文',authority:'user',hard:true,anchorIds:[source.id]}]})
 function op(operation,payload){p=store.apply({commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation,payload})}
 op('attach_branch',{parentId:'main',threadId:other,title:'代码分支',scope:'接口检查'});const node=p.nodes.at(-1)
 op('set_engineering',{repoPath:repo,baseCommit:base,contractVersion:'2',assignments:[{nodeId:node.id,allowedPaths:['src'],acceptance:['原文与代码一致']}],verifications:[]})
 const clean=await inspectEngineering(p,node.id);pass('真实 Git 提交和工作树哈希',()=>{assert.equal(clean.head,base);assert(clean.baselineMatches);assert(clean.scopeMatches);assert.equal(clean.fileCount,2)})
 await reject('REPO_ROOT',()=>inspectRepository(resolve(repo,'src')))
 await reject('GIT_INSPECTION_FAILED',()=>inspectEngineering({...p,engineering:{...p.engineering,baseCommit:'a'.repeat(40)}}))
 await reject('CONTRACT_DRIFT',()=>inspectEngineering({...p,engineering:{...p.engineering,contractVersion:'99'}}))
 await writeFile(resolve(repo,'src/接口.txt'),'合法修改🧭\n');const dirty=await requireEngineering(p,node.id)
 pass('允许范围内修改可核查且改变哈希',()=>{assert(dirty.dirty);assert(dirty.worktreeDigest!==clean.worktreeDigest);assert(dirty.changes.some(c=>c.path==='src/接口.txt'&&c.owners.includes(node.id)))})
 await writeFile(resolve(repo,'README.md'),'越界修改\n');await reject('ENGINEERING_OUT_OF_SCOPE',()=>requireEngineering(p,node.id))
 git('checkout','--','README.md');git('add','src/接口.txt');git('commit','-qm','second fixture revision');await reject('BASELINE_DRIFT',()=>requireEngineering(p,node.id))
 await reject('PATH_ESCAPE',()=>allowedTarget(repo,'../outside'))
 await reject('PATH_ESCAPE',()=>allowedTarget(repo,'.git/config'))
 await symlink(outside,resolve(repo,'external-link'),process.platform==='win32'?'junction':'dir');await reject('PATH_ESCAPE',()=>allowedTarget(repo,'external-link/new.txt'))
 await rm(resolve(repo,'external-link'))
 op('save_view',{positions:[{nodeId:node.id,x:77,y:123}],viewport:{x:5,y:9,zoom:.7}})
 op('checkpoint',{nodeId:node.id,anchorIds:[branchSource.id],completedTurnIds:['turn-1'],decisions:[],unresolved:['真实侧栏待验收'],nextAction:'核查工程'})
 op('build_context',{nodeId:node.id,anchorIds:[branchSource.id],packageIds:[],excluded:[],budget:20000});const context=p.contexts.at(-1)
 op('rebuild_segment',{nodeId:node.id,contextId:context.id,checkpointId:p.checkpoints.at(-1).id})
 op('compress_context',{segmentId:p.segments.at(-1).id,contextId:context.id,checkpointId:p.checkpoints.at(-1).id,summary:'从原文整理的阶段摘要',status:'completed'})
 const request={commandId:randomUUID(),projectId:p.id,expectedRevision:p.revision,operation:'turn',nodeId:node.id,contextId:context.id,message:'原请求'}
 const run=store.prepareRemote(request);store.reserveRemote(run.id);store.updateRun(run.id,r=>{r.state='awaiting_user';r.turnId='fixture-turn';r.wireInput='已发送的精确文本'});store.pendingRequest(run.id,900,'item/commandExecution/requestApproval',{threadId:other,turnId:'fixture-turn',command:'fixture'});store.event(run.id,'fixture/evidence',{original:'完整事件🧭'})
 const result=await exportProject(store,p.id),envelope=JSON.parse(await readFile(result.path,'utf8'))
 pass('导出包含工具原文、版本、布局、冷却和运行记录',()=>{assert.equal(result.runCount,1);assert(envelope.data.anchors.some(a=>a.role==='commandExecution'));assert.equal(envelope.data.project.segments[0].compressions,1);assert.equal(envelope.data.project.viewport.zoom,.7)})
 const restored=newStore('restored');const recovery=await restoreProject(restored,result.path)
 pass('恢复原文逐字符与来源哈希一致',()=>{assert.deepEqual(restored.anchors(primary),store.anchors(primary));assert.deepEqual(recovery.project,p)})
 pass('恢复不重放运行，也不复用旧审批连接',()=>{assert.equal(recovery.remoteReplay,false);assert.equal(restored.run(run.id).state,'unknown');assert.equal(restored.run(run.id).ownerPid,null);assert.equal(restored.runViews()[0].pendingRequests.length,0);assert(recovery.project.segments[0].cooling)})
 await reject('PROJECT_EXISTS',()=>restoreProject(restored,result.path))
 const tampered=structuredClone(envelope);tampered.data.project.title='改动';assert.throws(()=>validateArchive(tampered),e=>e.code==='ARCHIVE_HASH');cases.push({name:'归档损坏哈希拒绝',status:'PASS'})
 const missing=structuredClone(envelope);missing.data.project.trunks[0].statements[0].anchorIds=['missing'];missing.sha256=createHash('sha256').update(JSON.stringify(missing.data)).digest('hex');assert.throws(()=>validateArchive(missing),e=>e.code==='ARCHIVE_REFERENCE');cases.push({name:'重新计算包哈希也不能绕过缺失来源校验',status:'PASS'})
 const collision=newStore('collision');collision.importThread(fixture(primary),primary);collision.db.prepare('UPDATE anchors SET body=? WHERE id=?').run('different',source.id);const count=collision.db.prepare('SELECT count(*) n FROM raw_reads').get().n
 await reject('ARCHIVE_COLLISION',()=>restoreProject(collision,result.path));pass('冲突导入完整回滚',()=>{assert.equal(collision.list().length,0);assert.equal(collision.db.prepare('SELECT count(*) n FROM raw_reads').get().n,count)})
 const older=newStore('older-source');older.importThread(fixture(primary),primary);const status=older.anchor(source.id).turnStatus;await restoreProject(older,result.path)
 pass('导入旧观察不降级较新的完成状态',()=>assert.equal(older.anchor(source.id).turnStatus,status))
 const report={status:'PASS',case_count:cases.length,cases,scope:'real isolated Git repositories and Node SQLite archives; no user repository changes',model_calls:0,codex_chat_writes:0,native_sidebar_verified:false}
 await writeFile('../../evidence/engineering-archive-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:'PASS',case_count:cases.length,model_calls:0,codex_chat_writes:0}))
}finally{for(const store of stores)store.close();const target=await realpath(dir);assert(!relative(root,target).startsWith('..'));await rm(target,{recursive:true,force:true})}
