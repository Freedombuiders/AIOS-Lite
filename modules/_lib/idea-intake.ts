/**
 * Contract between the marketing module (provides it as `ideaIntake`) and modules that hand an idea to the content
 * studio (dream's "Giao Bot Nội dung viết"). The row is created through marketing's own create path
 * (core/content.ts createContent) in state `idea`, with its lineage fixed at creation: marketing refuses any later
 * change of lineage. Nothing created here is approved, scheduled or published.
 */
import type { FbContentLineage } from './fb-types.js';

export interface IdeaIntakeInput {
  title: string;
  /** the opening line and what to shoot, as a starting caption the writer replaces */
  caption: string;
  /** reel | video | photo | album | text | link */
  format?: string;
  pillar?: string;
  hookType?: string;
  pageId?: string | null;
  lineage: Partial<FbContentLineage>;
}

export interface IdeaIntake {
  /** Creates the `idea` row as the owner (source 'user'); returns its id. Throws a Vietnamese error on bad input. */
  createIdea(input: IdeaIntakeInput): { id: number };
}
