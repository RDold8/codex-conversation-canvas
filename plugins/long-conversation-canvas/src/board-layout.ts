export type Direction='right'|'down'|'left'|'up'
export type CardMode='full'|'step'|'mini'
export type Box={id:string,parentId:string|null,width:number,height:number,direction?:Direction}
type Rect={x:number,y:number,width:number,height:number}
const intersects=(a:Rect,b:Rect)=>a.x<b.x+b.width+40&&a.x+a.width+40>b.x&&a.y<b.y+b.height+40&&a.y+a.height+40>b.y
/** Local subtree boxes keep siblings apart in all four growth directions. */
export function layoutTree(boxes:Box[],direction:Direction='right'){
 const positions=new Map<string,{x:number,y:number}>(),seen=new Set<string>(),gap=140
 function build(node:Box):{bounds:Rect,items:Map<string,{x:number,y:number}>}{
  seen.add(node.id);const items=new Map([[node.id,{x:0,y:0}]]),placed:Rect[]=[{x:0,y:0,width:node.width,height:node.height}]
  const children=boxes.filter(b=>b.parentId===node.id&&!seen.has(b.id)),buckets=new Map<Direction,Box[]>()
  for(const child of children){const d=child.direction??node.direction??direction;buckets.set(d,[...(buckets.get(d)??[]),child])}
  for(const [d,group] of buckets){const parts=group.filter(c=>!seen.has(c.id)).map(c=>build(c)),horizontal=d==='right'||d==='left',total=parts.reduce((n,p)=>n+(horizontal?p.bounds.height:p.bounds.width),0)+gap*Math.max(0,parts.length-1);let cursor=(horizontal?node.height:node.width)/2-total/2
   for(const part of parts){const b=part.bounds;let x=horizontal?(d==='right'?node.width+gap: -gap-b.width)-b.x:cursor-b.x,y=horizontal?cursor-b.y:(d==='down'?node.height+gap:-gap-b.height)-b.y
    let rect={x:x+b.x,y:y+b.y,width:b.width,height:b.height};let attempts=0
    while(placed.some(p=>intersects(rect,p))&&attempts++<placed.length+2){const hits=placed.filter(p=>intersects(rect,p));if(horizontal){x=(d==='right'?Math.max(...hits.map(p=>p.x+p.width))+gap:Math.min(...hits.map(p=>p.x))-gap-b.width)-b.x}else{y=(d==='down'?Math.max(...hits.map(p=>p.y+p.height))+gap:Math.min(...hits.map(p=>p.y))-gap-b.height)-b.y}rect={...rect,x:x+b.x,y:y+b.y}}
    for(const [id,p] of part.items)items.set(id,{x:p.x+x,y:p.y+y});placed.push(rect);cursor+=(horizontal?b.height:b.width)+gap
   }
  }
  const x=Math.min(...placed.map(r=>r.x)),y=Math.min(...placed.map(r=>r.y));return {items,bounds:{x,y,width:Math.max(...placed.map(r=>r.x+r.width))-x,height:Math.max(...placed.map(r=>r.y+r.height))-y}}
 }
 let offset=0;for(const node of [...boxes.filter(b=>!b.parentId||!boxes.some(p=>p.id===b.parentId)),...boxes]){if(seen.has(node.id))continue;const tree=build(node);for(const [id,p] of tree.items)positions.set(id,{x:p.x-tree.bounds.x+80,y:p.y-tree.bounds.y+80+offset});offset+=tree.bounds.height+gap}
 return positions
}
export function connectionSides(a:Rect,b:Rect):[Direction,Direction]{
 const dx=b.x+b.width/2-a.x-a.width/2,dy=b.y+b.height/2-a.y-a.height/2
 return Math.abs(dx)/(a.width+b.width)>=Math.abs(dy)/(a.height+b.height)?(dx>=0?['right','left']:['left','right']):(dy>=0?['down','up']:['up','down'])
}
export function cardSize(mode:CardMode,available:{width:number,height:number}){return mode==='mini'?{width:270,height:166}:mode==='step'?{width:Math.max(280,Math.min(420,available.width)),height:360}:available}

export const branchLevels=[{label:'主干',color:'#b89962',width:4.4},{label:'枝干',color:'#6ba69b',width:3.6},{label:'枝桠',color:'#709abb',width:2.9},{label:'叶',color:'#a08fc2',width:2.3},{label:'细叶',color:'#be8c9b',width:1.8},{label:'末梢',color:'#94a276',width:1.4}]
export function branchDepth(id:string,nodes:{id:string,parentId:string|null}[]){let level=0,node=nodes.find(n=>n.id===id);const seen=new Set<string>();while(node?.parentId&&!seen.has(node.id)){seen.add(node.id);const parent=nodes.find(n=>n.id===node!.parentId);if(!parent)break;level++;node=parent}return level}
export function branchLevel(depth:number){const level=branchLevels[Math.min(depth,branchLevels.length-1)];return {...level,label:depth<branchLevels.length?level.label:`第${depth+1}级`}}

/** Extract a useful sentence for the display only; never replace conversation memory. */
export function oneLineExcerpt(text:string,fallback:string){
 const clean=text.replace(/```[\s\S]*?```/g,' ').replace(/[#*_>\[\]`]/g,'').replace(/\s+/g,' ').trim()
 const sentences=clean.match(/[^。！？.!?]+[。！？.!?]?/g)??[]
 const useful=sentences.find(sentence=>sentence.trim().length>=14&&!/^(好的|明白了?|收到|已完成|验证通过|没问题)[，,。！!\s]/.test(sentence.trim()))??sentences.find(sentence=>sentence.trim().length>=6)??fallback
 const value=useful.trim();return value.length>110?value.slice(0,109)+'…':value
}
