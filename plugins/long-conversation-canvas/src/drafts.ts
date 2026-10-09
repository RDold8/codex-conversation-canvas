export type Draft={message:string,model:string,effort:string,skill:string,revision:string}
const volatile=new Map<string,Draft>()
const unsaved=new Set<string>()
export const emptyDraft=():Draft=>({message:'',model:'',effort:'',skill:'',revision:''})
function parse(raw:string):Draft{
 const value=JSON.parse(raw)
 if(!value||!['message','model','effort','skill','revision'].every(key=>typeof value[key]==='string'))throw Error('草稿格式无法读取')
 return value
}
// Memory fallback survives component unmounts; disk failures remain visible to the user.
export function readDraft(key:string,storage:Pick<Storage,'getItem'>){
 try{const raw=storage.getItem(key);const draft=volatile.get(key)??(raw?parse(raw):emptyDraft());volatile.set(key,draft);return {draft,persistent:!unsaved.has(key)}}
 catch(e){return {draft:volatile.get(key)??emptyDraft(),persistent:false,error:String(e)}}
}
export function writeDraft(key:string,draft:Draft,storage:Pick<Storage,'setItem'>){
 volatile.set(key,draft)
 try{storage.setItem(key,JSON.stringify(draft));unsaved.delete(key);return true}catch{unsaved.add(key);return false}
}
export function clearSubmittedDraft(key:string,revision:string,storage:Pick<Storage,'getItem'|'setItem'>){
 const current=readDraft(key,storage).draft
 if(current.revision!==revision)return null // A reopened editor may already hold a newer draft.
 const draft={...current,message:'',revision:crypto.randomUUID()}
 return {draft,persistent:writeDraft(key,draft,storage)}
}
