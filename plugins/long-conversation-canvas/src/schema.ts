import {z} from 'zod'
export const SCHEMA_VERSION=2 as const
const id=z.string().min(1).max(200)
const text=z.string().min(1)
export const ReviewPolicySchema=z.object({level:z.number().int().min(0).max(3),paused:z.boolean().default(false),maxDepth:z.number().int().min(0).max(30).default(6),maxChildren:z.number().int().min(1).max(30).default(6),maxActions:z.number().int().min(1).max(200).default(20),expiresAt:z.string().datetime().nullable().default(null),plan:z.array(z.object({id,text}).strict()).max(50).default([])}).strict()
export const ReviewSchema=z.object({id:z.string().uuid(),nodeId:id,sourceRunId:z.string().uuid().nullable(),origin:z.enum(['human','bot']),request:z.record(z.unknown()),status:z.enum(['pending','approved','dispatching','created','completed','failed','unknown','rejected']),reason:text,humanApproved:z.boolean(),policyHash:text,grantNodeId:id,planItemId:id.optional(),createdAt:text,updatedAt:text,executedRequest:z.record(z.unknown()).optional(),firstRequest:z.record(z.unknown()).optional(),childNodeId:id.optional(),runId:z.string().uuid().optional(),error:z.string().nullable()}).strict()
export type Review=z.infer<typeof ReviewSchema>
export const Statement=z.object({text,authority:z.enum(['user','suggestion','confirmed']),hard:z.boolean(),anchorIds:z.array(id).min(1),confirmationAnchorId:id.optional()}).strict()
export const NodeSchema=z.object({id,title:text,kind:z.enum(['main','branch','merge']),threadId:z.string().uuid(),parentId:id.nullable(),trunkRevisionId:id,scope:text,status:z.enum(['active','waiting','done']),forkTurnId:id.nullable(),relation:z.enum(['primary','attached','forked','delegated']),task:z.object({brief:text,mode:z.enum(['discussion','code']),originNodeId:id,sourceAnchorIds:z.array(id).min(1),sourcePackageIds:z.array(id),createdAt:text,creationRunId:z.string().uuid(),initialTurnCommandId:z.string().uuid()}).strict().optional(),topic:z.boolean().optional(),importance:z.enum(['normal','high','critical']).optional(),originParentId:id.nullable().optional(),moves:z.array(z.object({from:id.nullable(),to:id,reason:text,createdAt:text}).strict()).optional(),reviewPolicy:ReviewPolicySchema.optional(),collapsed:z.boolean().optional(),x:z.number().finite(),y:z.number().finite()}).strict()
export const EdgeSchema=z.object({id,source:id,target:id,kind:z.enum(['branch_from','merge_from','context_from','reference'])}).strict()
export const TrunkSchema=z.object({id,ordinal:z.number().int().positive(),statements:z.array(Statement).min(1),createdAt:text}).strict()
export const CheckpointSchema=z.object({id,nodeId:id,anchorIds:z.array(id).min(1),completedTurnIds:z.array(id).min(1),decisions:z.array(z.string()),unresolved:z.array(z.string()),nextAction:text,createdAt:text}).strict()
export const ResultItem=z.object({key:text,kind:z.enum(['fact','decision_candidate','change','verification','unresolved']),text,anchorIds:z.array(id).min(1),scope:text}).strict()
export const PackageSchema=z.object({id,nodeId:id,trunkRevisionId:id,items:z.array(ResultItem).min(1).max(8),deliveryToId:id.optional(),createdAt:text}).strict()
export const ContextSchema=z.object({id,nodeId:id,trunkRevisionId:id,anchorIds:z.array(id).min(1),packageIds:z.array(id),excluded:z.array(z.object({id,reason:text}).strict()),budget:z.number().int().positive(),codePoints:z.number().int().nonnegative(),text,createdAt:text}).strict()
export const SegmentSchema=z.object({id,lineageId:id,nodeId:id,rawAnchorIds:z.array(id).min(1),compressions:z.number().int().min(0).max(2),history:z.enum(['known','unknown']),cooling:z.boolean(),lastTurnIds:z.array(id),lastCheckpointId:id.nullable(),rebuiltFromRaw:z.boolean()}).strict()
export const CompressionSchema=z.object({id,segmentId:id,contextId:id,summary:text,status:z.enum(['completed','failed','cancelled']),sourceAnchorIds:z.array(id).min(1),createdAt:text}).strict()
export const MergeSchema=z.object({id,sourceNodeIds:z.array(id).min(2),packageIds:z.array(id).min(1),conflicts:z.array(z.object({key:text,candidates:z.array(z.object({packageId:id,text}).strict()).min(2),resolution:z.string().nullable()}).strict()),status:z.enum(['preview','adopted']),adoptedTrunkId:id.nullable(),createdAt:text}).strict()
export const EngineeringSchema=z.object({repoPath:text,baseCommit:z.string().regex(/^[a-f0-9]{40,64}$/),contractVersion:text,assignments:z.array(z.object({nodeId:id,allowedPaths:z.array(text).min(1),acceptance:z.array(text).min(1)}).strict()),leases:z.array(z.object({id:z.string().uuid(),sourceNodeId:id,childNodeId:id,state:z.enum(['active','released']),createdAt:text,releasedAt:text.optional()}).strict()).optional(),verifications:z.array(z.object({nodeId:id,testedCommit:text,commands:z.array(text).min(1),evidence:text}).strict())}).strict()
export const ProjectSchema=z.object({schemaVersion:z.literal(SCHEMA_VERSION),id,title:text,primaryThreadId:z.string().uuid(),binding:z.literal('read_verified'),revision:z.number().int().nonnegative(),createdAt:text,updatedAt:text,trunks:z.array(TrunkSchema).min(1),activeTrunkId:id,nodes:z.array(NodeSchema).min(1),edges:z.array(EdgeSchema),checkpoints:z.array(CheckpointSchema),packages:z.array(PackageSchema),contexts:z.array(ContextSchema),segments:z.array(SegmentSchema),compressions:z.array(CompressionSchema),merges:z.array(MergeSchema),viewport:z.object({x:z.number().finite(),y:z.number().finite(),zoom:z.number().min(.1).max(4)}).strict(),engineering:EngineeringSchema.nullable(),reviews:z.array(ReviewSchema).optional(),hostCompressionHistory:z.literal('unknown')}).strict()
export type Project=z.infer<typeof ProjectSchema>
export const SourcePageSchema=z.object({anchors:z.array(z.object({id,threadId:z.string().uuid(),turnId:id,itemId:id,role:z.string(),text:z.string(),turnStatus:z.string(),sha256:z.string(),order:z.number().optional(),raw:z.string().optional()}).passthrough()),nextCursor:z.string().nullable().optional()}).passthrough()
export type StatementType=z.infer<typeof Statement>
export const CreateSchema=z.object({commandId:z.string().uuid(),title:text,primaryThreadId:z.string().uuid(),statements:z.array(Statement).min(1)}).strict()
const common={commandId:z.string().uuid(),projectId:id,expectedRevision:z.number().int().nonnegative()}
export const CommandSchema=z.discriminatedUnion('operation',[
 z.object({...common,operation:z.literal('set_review_policy'),payload:z.object({nodeId:id,policy:ReviewPolicySchema,subtree:z.boolean().default(false)}).strict()}).strict(),
 z.object({...common,operation:z.literal('inherit_review_policy'),payload:z.object({nodeId:id}).strict()}).strict(),
 z.object({...common,operation:z.literal('pause_branch'),payload:z.object({nodeId:id,paused:z.boolean()}).strict()}).strict(),
 z.object({...common,operation:z.literal('decide_review'),payload:z.object({reviewId:z.string().uuid(),decision:z.enum(['approve','reject']),request:z.record(z.unknown()).optional()}).strict()}).strict(),
 z.object({...common,operation:z.literal('release_scope'),payload:z.object({nodeId:id}).strict()}).strict(),

 z.object({...common,operation:z.literal('promote_topic'),payload:z.object({nodeId:id,parentId:id,title:text,reason:text}).strict()}).strict(),
 z.object({...common,operation:z.literal('set_importance'),payload:z.object({nodeId:id,importance:z.enum(['normal','high','critical'])}).strict()}).strict(),
 z.object({...common,operation:z.literal('accept_result'),payload:z.object({nodeId:id,packageId:id,budget:z.number().int().positive().max(200000).default(20000)}).strict()}).strict(),
 z.object({...common,operation:z.literal('attach_branch'),payload:z.object({parentId:id,threadId:z.string().uuid(),title:text,scope:text}).strict()}).strict(),
 z.object({...common,operation:z.literal('revise_trunk'),payload:z.object({statements:z.array(Statement).min(1)}).strict()}).strict(),
 z.object({...common,operation:z.literal('collapse_node'),payload:z.object({nodeId:id,collapsed:z.boolean()}).strict()}).strict(),
 z.object({...common,operation:z.literal('save_view'),payload:z.object({positions:z.array(z.object({nodeId:id,x:z.number().finite(),y:z.number().finite()}).strict()),viewport:z.object({x:z.number().finite(),y:z.number().finite(),zoom:z.number().min(.1).max(4)}).strict()}).strict()}).strict(),
 z.object({...common,operation:z.literal('add_reference'),payload:z.object({source:id,target:id,kind:z.enum(['reference','context_from'])}).strict()}).strict(),
 z.object({...common,operation:z.literal('checkpoint'),payload:CheckpointSchema.omit({id:true,createdAt:true})}).strict(),
 z.object({...common,operation:z.literal('result_package'),payload:PackageSchema.omit({id:true,trunkRevisionId:true,createdAt:true,deliveryToId:true})}).strict(),
 z.object({...common,operation:z.literal('prepare_context'),payload:z.object({nodeId:id,budget:z.number().int().positive().max(200000).default(20000)}).strict()}).strict(),
 z.object({...common,operation:z.literal('build_context'),payload:ContextSchema.omit({id:true,trunkRevisionId:true,createdAt:true,codePoints:true,text:true})}).strict(),
 z.object({...common,operation:z.literal('rebuild_segment'),payload:z.object({nodeId:id,contextId:id,checkpointId:id}).strict()}).strict(),
 z.object({...common,operation:z.literal('compress_context'),payload:z.object({segmentId:id,contextId:id,checkpointId:id,summary:text,status:z.enum(['completed','failed','cancelled'])}).strict()}).strict(),
 z.object({...common,operation:z.literal('merge_preview'),payload:z.object({packageIds:z.array(id).min(2),resolutions:z.record(z.string())}).strict()}).strict(),
 z.object({...common,operation:z.literal('merge_adopt'),payload:z.object({mergeId:id,statements:z.array(Statement).min(1)}).strict()}).strict(),
 z.object({...common,operation:z.literal('set_engineering'),payload:EngineeringSchema}).strict(),
 z.object({...common,operation:z.literal('node_status'),payload:z.object({nodeId:id,status:z.enum(['active','waiting','done']),evidence:z.string().optional(),verificationId:z.string().uuid().optional()}).strict()}).strict(),
])
export type Command=z.infer<typeof CommandSchema>
export const RemoteRequestSchema=z.discriminatedUnion('operation',[
 z.object({...common,reviewId:z.string().uuid().optional(),operation:z.literal('delegate'),nodeId:id,parentId:id,title:text,scope:text,task:text.max(12000),mode:z.enum(['discussion','code']),scopeAccess:z.enum(['assigned','project']).default('assigned'),anchorIds:z.array(id).min(1).max(2000),packageIds:z.array(id).max(50),budget:z.number().int().min(1000).max(200000).default(20000),allowedPaths:z.array(text).max(30).default([]),acceptance:z.array(text).max(30).default([]),topic:z.boolean().default(false)}).strict(),
 z.object({...common,operation:z.literal('fork'),nodeId:id,lastTurnId:id,title:text,scope:text}).strict(),
 z.object({...common,reviewId:z.string().uuid().optional(),operation:z.literal('turn'),nodeId:id,contextId:id,message:text,model:z.string().min(1).max(200).optional(),effort:z.string().min(1).max(80).optional(),skills:z.array(z.object({name:text,path:text}).strict()).max(8).optional()}).strict(),
])
export type RemoteRequest=z.infer<typeof RemoteRequestSchema>
export const RunSchema=z.object({id:z.string().uuid(),projectId:id,nodeId:id,operation:z.enum(['fork','turn','delegate']),requestHash:text,request:RemoteRequestSchema,sourceThreadId:z.string().uuid(),threadId:z.string().uuid().nullable(),turnId:id.nullable(),trunkRevisionId:id,state:z.enum(['prepared','dispatching','running','awaiting_user','unknown','completed','interrupted','failed']),error:z.string().nullable(),createdAt:text,updatedAt:text,result:z.unknown().nullable(),wireInput:z.string().nullable(),terminalEvent:z.boolean(),cancelRequested:z.boolean(),ownerPid:z.number().int().positive().nullable().default(null)}).strict()
export type Run=z.infer<typeof RunSchema>
export const RunViewSchema=RunSchema.omit({requestHash:true,request:true,result:true,wireInput:true}).extend({pendingRequests:z.array(z.object({id:z.union([z.string(),z.number()]),method:text,params:z.record(z.unknown())}).strict()),observedCompactions:z.number().int().nonnegative()}).strict()
export type RunView=z.infer<typeof RunViewSchema>
export const EngineeringObservationSchema=z.object({repoPath:z.string(),head:z.string(),dirty:z.boolean(),changes:z.array(z.object({path:z.string(),status:z.string(),owners:z.array(z.string()),inScope:z.boolean()}).strict()),fileCount:z.number().int().nonnegative(),worktreeDigest:z.string(),checkedAt:z.string(),baseCommit:z.string(),baselineMatches:z.boolean(),nodeId:z.string().nullable(),scopeMatches:z.boolean()}).strict()
export type EngineeringObservation=z.infer<typeof EngineeringObservationSchema>
export const VerificationRequestSchema=z.object({...common,nodeId:id,purpose:z.enum(['branch','merged']),steps:z.array(z.discriminatedUnion('kind',[
 z.object({kind:z.literal('typecheck'),packagePath:text}).strict(),
 z.object({kind:z.literal('build'),packagePath:text}).strict(),
 z.object({kind:z.literal('node'),path:text,args:z.array(z.string()).max(20).default([]),cwd:text.optional()}).strict(),
])).min(1).max(10)}).strict()
export type VerificationRequest=z.infer<typeof VerificationRequestSchema>
export const VerificationSchema=z.object({id:z.string().uuid(),projectId:id,nodeId:id,purpose:z.enum(['branch','merged']),request:VerificationRequestSchema,requestHash:text,repoPath:text,status:z.enum(['running','passed','failed','changed','unknown','cancelled']),testedCommit:text,beforeDigest:text,afterDigest:z.string().nullable(),criteriaHash:text,ownerPid:z.number().int().positive().nullable(),childPid:z.number().int().positive().nullable(),createdAt:text,updatedAt:text,error:z.string().nullable(),steps:z.array(z.object({label:text,exitCode:z.number().int().nullable(),signal:z.string().nullable(),stdout:z.string(),stderr:z.string(),logPath:text,logSha256:text,outputTruncated:z.boolean()}).strict())}).strict()
export type Verification=z.infer<typeof VerificationSchema>
export const WorkspaceSchema=z.object({schemaVersion:z.literal(SCHEMA_VERSION),projects:z.array(ProjectSchema),storagePath:text,runs:z.array(RunViewSchema).default([]),verifications:z.array(VerificationSchema).default([]),remoteEnabled:z.boolean().default(false)}).strict()
