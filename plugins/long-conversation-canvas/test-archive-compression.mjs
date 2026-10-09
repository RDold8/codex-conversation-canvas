import {build} from 'esbuild';
import {mkdtemp,mkdir,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
await mkdir('../../runtime',{recursive:true});const root=await realpath('../../runtime'),dir=await mkdtemp(resolve(root,'archive-compression-'));
await build({entryPoints:['src/archive.ts','src/store.ts'],bundle:true,platform:'node',format:'esm',target:'node24',outdir:dir});
const {Store}=await import(pathToFileURL(resolve(dir,'store.js')).href),{exportProject,restoreProject}=await import(pathToFileURL(resolve(dir,'archive.js')).href);
const stores=[],cases=[];let passed=false;
const check=(name,fn)=>{fn();cases.push({name,status:'PASS'})};
try{
 const source=new Store(resolve(dir,'source.sqlite')),restored=new Store(resolve(dir,'restored.sqlite'));stores.push(source,restored);
 const threadId=randomUUID(),text='x'.repeat(22*1024*1024)+'\n原文 🧭 空格  与标点。';
 source.importThread({id:threadId,turns:[{id:'completed-source',status:'completed',items:[{id:'large-user-original',type:'userMessage',content:[{type:'text',text}]}]}]},threadId);
 const anchor=source.anchors(threadId)[0],project=source.create({commandId:randomUUID(),title:'Large lossless source archive',primaryThreadId:threadId,statements:[{text:'保留所有原文和角色顺序',authority:'user',hard:true,anchorIds:[anchor.id]}]});
 const archive=await exportProject(source,project.id),bytes=await readFile(archive.path);
 check('大于64MB原文归档无损压缩为gzip',()=>{assert(archive.expandedBytes>64*1024*1024);assert(archive.bytes<64*1024*1024);assert.equal(archive.encoding,'gzip');assert(archive.path.endsWith('.json.gz'));assert.equal(bytes[0],0x1f);assert.equal(bytes[1],0x8b)});
 const result=await restoreProject(restored,archive.path);
 check('压缩恢复保留项目和逐字符原文',()=>{assert.deepEqual(result.project,project);assert.equal(restored.anchors(threadId)[0].text,text);assert.equal(restored.anchors(threadId)[0].sha256,anchor.sha256);assert.equal(result.remoteReplay,false)});
 check('归档文件哈希核对压缩后的实际载荷',()=>assert.equal(archive.sha256,createHash('sha256').update(bytes).digest('hex')));
 await assert.rejects(restoreProject(restored,archive.path),e=>e.code==='PROJECT_EXISTS');cases.push({name:'压缩归档同样拒绝覆盖已有任务',status:'PASS'});
 const bad=resolve(dir,'broken.json.gz');await writeFile(bad,Buffer.from([0x1f,0x8b,0x00]));
 await assert.rejects(restoreProject(restored,bad),e=>e.code==='ARCHIVE_ENCODING');check('损坏压缩归档报错且不改动已有任务',()=>assert.deepEqual(restored.get(project.id),project));
 const report={status:'PASS',case_count:cases.length,cases,expanded_bytes:archive.expandedBytes,packed_bytes:archive.bytes,source_text_utf8_bytes:Buffer.byteLength(text),model_calls:0,codex_chat_writes:0,actual_codex_ui:false};
 await writeFile('../../evidence/archive-compression-tests.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));passed=true;
}finally{
 for(const store of stores)store.close();
 if(passed){const target=await realpath(dir);const within=relative(root,target);assert(within&&!isAbsolute(within)&&!within.startsWith('..'));await rm(target,{recursive:true,force:true})}
}
