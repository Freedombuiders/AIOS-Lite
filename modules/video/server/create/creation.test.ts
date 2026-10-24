import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { bindModuleCtx } from '../host.js';
import { fakeCtx } from '../test-ctx.js';
import { findBin } from '../bin.js';
import { createVideoEditStore } from '../edit/store.js';
import { createPipeline } from '../edit/pipeline/runner.js';
import { registerVideoEditRoutes } from '../edit/routes.js';
import { runDirectorTurn } from '../edit/agent/director.js';
import { runFfmpeg } from '../edit/pipeline/tools.js';
import { probeMedia } from '../edit/media.js';
import { RocketFlowService } from '../studio/service.js';
import { advanceCreations } from '../creation-worker.js';
import { createCreationService } from './service.js';
import { bindCreationService, parseCreationArgs, creationTools } from './runtime.js';
const hasFfmpeg = Boolean(findBin('ffmpeg') && findBin('ffprobe'));
const caps = { types:['image','video'], models:{image:['fixture-image'],video:['fixture-video']},ratios:{image:['9:16','16:9','1:1'],video:['9:16','16:9']},durations:{video:['4s','8s']} };
const brief = { idea:'Create a test story using real fixtures',visuals:'auto' as const,targetSeconds:4,audio:'native' as const,generationAuthorized:true as const };
const plan={script:'Two scenes',scenes:[{title:'Image',kind:'image',prompt:'fixture still',model:'fixture-image',durationSec:2,caption:'Cảnh ảnh'},{title:'Video',kind:'video',prompt:'fixture clip',model:'fixture-video',durationSec:2,generationDuration:'4s',caption:'Cảnh video'}]};
let tmp:string;
beforeEach(()=>{bindModuleCtx(fakeCtx({agents:[{id:'creation-test',runtime:'claude'}]}));tmp=fs.mkdtempSync(path.join(os.tmpdir(),'video-create-test-'));});
afterEach(()=>{vi.restoreAllMocks();bindModuleCtx(undefined);fs.rmSync(tmp,{recursive:true,force:true});});
function setup() {
 const store=createVideoEditStore(path.join(tmp,'edit'));const profile=store.createProfile({name:'Fixture'});
 const p=store.createProject({profileId:profile.id,title:'New video',aspect:'16:9',agentId:'creation-test'});
 store.updateProject(p.id,p=>{p.mode='create';p.creation={brief,state:'brief',scenes:[]};});
 const batches=new Map<string,any>();let seq=0;
 const call=vi.fn(async(name:string,args:any)=>{
  if(name==='list_capabilities')return JSON.stringify({flow:caps});
  if(name.startsWith('generate_')){const batchId=`batch-${++seq}`;batches.set(batchId,{ok:true,batchId,done:false,items:[{batchId,provider:'flow',type:name.slice(9),prompt:args.prompts[0],status:'queued',results:[]}]});return `job_id: ${batchId}`;}
  if(name==='get_job_details')return JSON.stringify(batches.get(args.job_id));
  throw new Error('unsupported mock '+name);
 });
 const rocket=new RocketFlowService(path.join(tmp,'rocket'),call);rocket.grant('creation-test','write');
 const pipeline=createPipeline({store,root:store.root,autoStart:false});
 const service=createCreationService({store,pipeline,rocket,downloadRoot:path.join(tmp,'downloads')});bindCreationService(store.root,service);
 const exec=(name:string,args:unknown={})=>service.execute(p.id,'creation-test',name,args);
 return {store,p,rocket,pipeline,service,exec,call,batches};
}
describe('creation service',()=>{
 it('discovers capabilities, rejects unsupported choices, deduplicates concurrent writes and locks plans',async()=>{
  const s=setup();await expect(s.exec('create_plan',plan)).rejects.toThrow('flow_capabilities');await s.exec('flow_capabilities');
  await expect(s.exec('create_plan',{...plan,scenes:[{...plan.scenes[0],model:'invented',durationSec:4}]})).rejects.toThrow('model');
  await s.exec('create_plan',plan);await Promise.all([s.exec('create_generate',{sceneId:'scene-1'}),s.exec('create_generate',{sceneId:'scene-1'})]);
  expect(s.call.mock.calls.filter(c=>c[0]==='generate_image')).toHaveLength(1);
  const scene=s.service.project(s.p.id).creation.scenes[0];expect(s.rocket.read(scene.requestId)).toMatchObject({agentId:'creation-test',project:s.p.id});
  await expect(s.exec('create_plan',{...plan,script:'changed'})).rejects.toThrow('cố định');
  await expect(s.exec('create_render')).rejects.toThrow('Nhận đủ');
  await expect(s.service.execute(s.p.id,'foreign','create_status',{})).rejects.toThrow('sở hữu');
 });
 it('never replays an uncertain submit after restart or an interrupted reservation',async()=>{
  const s=setup();await s.exec('flow_capabilities');await s.exec('create_plan',plan);
  s.call.mockRejectedValueOnce(new Error('offline'));await expect(s.exec('create_generate',{sceneId:'scene-1'})).rejects.toThrow('offline');
  // Capability failure happened before dispatch, so a later explicit attempt is safe.
  s.call.mockImplementationOnce(async()=>JSON.stringify({flow:caps})).mockRejectedValueOnce(new Error('disconnected after send'));
  await s.exec('create_generate',{sceneId:'scene-1'});
  expect(s.service.project(s.p.id).creation.scenes[0].state).toBe('unknown');
  const count=s.call.mock.calls.length;
  const restarted=createCreationService({store:s.store,pipeline:s.pipeline,rocket:new RocketFlowService(s.rocket.root,s.call)});
  await restarted.execute(s.p.id,'creation-test','create_generate',{sceneId:'scene-1'});expect(s.call).toHaveBeenCalledTimes(count);
  s.store.updateProject(s.p.id,p=>{p.creation!.scenes[1].state='submitted';});
  await expect(s.exec('create_generate',{sceneId:'scene-2'})).rejects.toThrow('Không gửi lại');expect(s.call).toHaveBeenCalledTimes(count);
 });
 it.skipIf(!hasFfmpeg)('imports only matching downloaded outputs, stores library assets and actually assembles image + video into MP4',async()=>{
  const s=setup();await s.exec('flow_capabilities');await s.exec('create_plan',plan);
  for(const sceneId of ['scene-1','scene-2']) await s.exec('create_generate',{sceneId});
  const scenes=s.service.project(s.p.id).creation.scenes;
  for(const scene of scenes){
   const dir=path.join(tmp,'downloads',`studio-${scene.requestId}`);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,scene.kind==='image'?'image.png':'clip.mp4');
   await runFfmpeg(scene.kind==='image'?['-f','lavfi','-i','color=c=blue:s=320x180','-frames:v','1','-y',file]:['-f','lavfi','-i','color=c=red:s=320x180:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',file],{});
   const job=s.rocket.read(scene.requestId);const result=s.batches.get(job.jobId!);result.done=true;result.items[0].status='done';result.items[0].results=[{kind:scene.kind,path:file}];
   const original=result.items[0].prompt;result.items[0].prompt='foreign';await expect(s.exec('create_import',{sceneId:scene.id})).rejects.toThrow('khớp');result.items[0].prompt=original;
   const outside=path.join(tmp,`outside.${scene.kind==='image'?'png':'mp4'}`);fs.copyFileSync(file,outside);result.items[0].results[0].path=outside;
   await expect(s.exec('create_import',{sceneId:scene.id})).rejects.toThrow('thư mục');result.items[0].results[0].path=file;
   await s.exec('create_import',{sceneId:scene.id});
  }
  expect(s.service.project(s.p.id).creation.scenes.every(s=>s.assetId&&s.mediaSha256)).toBe(true);
  await Promise.all([s.exec('create_render'),s.exec('create_render')]);expect(s.pipeline.queue.list(s.p.id)).toHaveLength(1);
  expect(s.store.loadProject(s.p.id)!.outputs.final).not.toBe(true);s.pipeline.queue.start();await s.pipeline.queue.idle();
  const final=s.store.loadProject(s.p.id)!;expect(final.creation?.error).toBeUndefined();expect(final.creation?.state).toBe('done');expect(final.outputs.final).toBe(true);
  const media=await probeMedia(s.store.finalFile(s.p.id)!);expect(media.width).toBe(1280);expect(media.height).toBe(720);expect(media.durationSec).toBeCloseTo(4,0);expect(media.hasAudio).toBe(true);
 },30000);
});
it('the lean director turn gets the action guide and Flow capabilities, never MCP tools',async()=>{
 const s=setup();const prompts:string[]=[];
 const run=async(turn:{prompt:string})=>{prompts.push(turn.prompt);return {ok:true,output:'Đã đọc yêu cầu.'};};
 const result=await runDirectorTurn({projectId:s.p.id,reason:'plan',abortController:new AbortController()},{store:s.store,run,projectRoot:path.resolve(__dirname,'../..')});
 expect(result.error).toBeUndefined();
 expect(prompts[0]).toContain('create.call');
 expect(prompts[0]).toContain('FLOW CÓ SẴN');
 expect(prompts[0]).toContain('fixture-video');
 expect(prompts[0]).not.toContain('MCP video-create đã gắn');
 expect(prompts[0]).not.toContain('video-cli transcript');
});
it('creation tool arguments are validated like the owner MCP gateway',()=>{
 expect(creationTools).toHaveLength(10);
 expect(()=>parseCreationArgs('create_generate',{sceneId:'x'})).toThrow();
 expect(parseCreationArgs('create_generate',{sceneId:'scene-1'})).toEqual({sceneId:'scene-1'});
 expect(()=>parseCreationArgs('shell',{})).toThrow('không tồn tại');
});
it('the worker drives planned scenes through generate and poll without an agent turn',async()=>{
 const s=setup();await s.exec('flow_capabilities');await s.exec('create_plan',plan);
 const first=await advanceCreations(s.store,s.service);
 expect(first.filter(r=>r.step.startsWith('generate')&&r.ok)).toHaveLength(2);
 expect(s.call.mock.calls.filter(c=>String(c[0]).startsWith('generate_'))).toHaveLength(2);
 const second=await advanceCreations(s.store,s.service);
 expect(second.filter(r=>r.step.startsWith('poll')&&r.ok)).toHaveLength(2);
 expect(s.call.mock.calls.filter(c=>String(c[0]).startsWith('generate_'))).toHaveLength(2);
});
it('the worker does nothing before the owner authorised generation',async()=>{
 const s=setup();s.store.updateProject(s.p.id,p=>{p.creation!.brief.generationAuthorized=false as never;});
 expect(await advanceCreations(s.store,s.service)).toEqual([]);
});
it('creation routes start the agent without raw footage and isolate edit routes',async()=>{
 const s=setup();const app=new Hono();const runDirector=vi.fn(async()=>({text:'Waiting for test assets',activity:[],durationMs:1}));
 const {store}=registerVideoEditRoutes(app,{root:path.join(tmp,'routes'),tools:{runDirector},creationRocket:s.rocket,autoStart:false});
 store.createProfile({name:'Test'});const post=(url:string,data:unknown)=>app.request(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const request={requestId:randomUUID(),text:'tạo storyboard video mẹ bé, rồi tạo đi, video 16s ghép bởi 2 cái lại',agentId:'creation-test'};
 const response=await post('/edit/creation/projects',request);expect(response.status).toBe(200);
 const {project}=await response.json() as any;expect(project.mode).toBe('create');expect(project.source).toBeUndefined();expect(runDirector).toHaveBeenCalled();
 const duplicate=await(await post('/edit/creation/projects',request)).json() as any;expect(duplicate.project.id).toBe(project.id);expect(runDirector).toHaveBeenCalledTimes(1);
 expect((await post('/edit/creation/projects',{...request,text:'changed'})).status).toBe(409);
 expect((await(await app.request('/edit/projects')).json() as any).projects).toHaveLength(0);
 expect((await(await app.request('/edit/creation/projects')).json() as any).projects).toHaveLength(1);
 expect((await post(`/edit/projects/${project.id}/run`,{step:'ingest'})).status).toBe(409);
 expect((await app.request(`/edit/projects/${project.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({agentId:'other'})})).status).toBe(409);
 expect((await app.request(`/edit/creation/projects/${project.id}/scenes/scene-1`)).status).toBe(404);
});

