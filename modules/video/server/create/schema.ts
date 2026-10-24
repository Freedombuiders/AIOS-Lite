import { z } from 'zod';
export const createBriefSchema = z.object({
  idea: z.string().trim().min(10).max(12000),
  visuals: z.enum(['auto', 'image', 'video']),
  model: z.string().trim().max(100).optional(),
  targetSeconds: z.number().min(2).max(120),
  audio: z.enum(['silent', 'native']),
  generationAuthorized: z.literal(true),
}).strict();
export const sceneSchema = z.object({
  title: z.string().trim().min(1).max(100),
  kind: z.enum(['image', 'video']),
  prompt: z.string().trim().min(1).max(8000),
  model: z.string().trim().min(1).max(100),
  durationSec: z.number().min(1).max(15),
  generationDuration: z.string().regex(/^\d{1,2}s$/).optional(),
  caption: z.string().trim().max(240).default(''),
}).strict();
export const createPlanSchema = z.object({
  script: z.string().trim().min(1).max(12000),
  scenes: z.array(sceneSchema).min(1).max(20),
}).strict().refine(p => p.scenes.reduce((n, s) => n + s.durationSec, 0) <= 120, 'Video tối đa 120 giây.');
export const flowCapabilitiesSchema = z.object({
  types: z.array(z.string()),
  models: z.object({ image: z.array(z.string()).optional(), video: z.array(z.string()).optional() }),
  ratios: z.object({ image: z.array(z.string()).optional(), video: z.array(z.string()).optional() }),
  durations: z.object({ video: z.array(z.string()).optional() }).nullable().optional(),
}).passthrough();
export type FlowCapabilities = z.infer<typeof flowCapabilitiesSchema>;

/** Metadata is interpreted by the agent, not parsed from chat by a storyboard regex. */
export const chatBriefSchema = z.object({
  intent: z.enum(['plan', 'generate']),
  authorizationQuote: z.string().trim().max(12000).optional(),
  title: z.string().trim().min(1).max(120),
  aspect: z.enum(['9:16', '16:9', '1:1']),
  targetSeconds: z.number().min(2).max(120),
  sceneCount: z.number().int().min(1).max(20).optional(),
  sceneSeconds: z.number().min(1).max(15).optional(),
  visuals: z.enum(['auto', 'image', 'video']),
  model: z.string().trim().min(1).max(100).optional(),
  audio: z.enum(['silent', 'native']),
}).strict();
