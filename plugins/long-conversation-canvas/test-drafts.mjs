import {build} from 'esbuild'
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
await mkdir('../../runtime',{recursive:true});const dir=await mkdtemp(resolve('../../runtime/draft-test-')),file=resolve(dir,'drafts.mjs')
try{
 await build({entryPoints:['src/drafts.ts'],bundle:true,platform:'node',format:'esm',outfile:file})
 const {emptyDraft,readDraft,writeDraft,clearSubmittedDraft}=await import(pathToFileURL(file).href)
 const values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},cases=[]
 const test=(name,fn)=>{fn();cases.push({name,status:'PASS'})}
 const a={...emptyDraft(),message:'未发送🧭\n保持原文  空格',model:'model-a',effort:'high',skill:'D:/skill/SKILL.md',revision:'a1'}
 test('草稿与选择完整保存',()=>{assert(writeDraft('task-a:node-a',a,storage));assert.deepEqual(readDraft('task-a:node-a',storage).draft,a)})
 test('节点与任务互相隔离',()=>{assert.equal(readDraft('task-a:node-b',storage).draft.message,'');assert.equal(readDraft('task-b:node-a',storage).draft.message,'')})
 const reloaded=await import(pathToFileURL(file).href+'?reload=1')
 test('页面模块重载后恢复磁盘草稿',()=>assert.deepEqual(reloaded.readDraft('task-a:node-a',storage).draft,a))
 writeDraft('task-a:node-a',{...a,message:'更新后的草稿',revision:'a2'},storage)
 test('旧发送结果不清除新草稿',()=>{assert.equal(clearSubmittedDraft('task-a:node-a','a1',storage),null);assert.equal(readDraft('task-a:node-a',storage).draft.message,'更新后的草稿')})
 test('清除已发送正文但保留模型技能',()=>{const result=clearSubmittedDraft('task-a:node-a','a2',storage);assert.equal(result.draft.message,'');assert.equal(result.draft.model,a.model);assert.equal(result.draft.skill,a.skill)})
 const denied={getItem:()=>{throw Error('denied')},setItem:()=>{throw Error('denied')}}
 test('本地存储拒绝时保留页面草稿并显式降级',()=>{assert.equal(writeDraft('denied',a,denied),false);assert.equal(readDraft('denied',denied).persistent,false);assert.equal(readDraft('denied',denied).draft.message,a.message)})
 const quota={getItem:key=>values.get(key)??null,setItem:()=>{throw Error('quota')}}
 values.set('quota',JSON.stringify(a));writeDraft('quota',{...a,revision:'q2',message:'额度已满时的新草稿'},quota)
 test('写入失败后不被旧磁盘草稿覆盖',()=>{assert.equal(readDraft('quota',quota).draft.message,'额度已满时的新草稿');assert.equal(readDraft('quota',quota).persistent,false)})
 values.set('malformed','{');test('损坏草稿显式报告而非崩溃',()=>assert.equal(readDraft('malformed',storage).persistent,false))
 const report={status:'PASS',case_count:cases.length,cases,model_calls:0,chat_writes:0};await writeFile('../../evidence/draft-storage-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}finally{await rm(dir,{recursive:true,force:true})}
