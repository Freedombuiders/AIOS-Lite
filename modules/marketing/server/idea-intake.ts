// provides.ideaIntake: an idea from another module (dream's daily suggestions) becomes an `idea` row through the same
// createContent the studio uses, with the lineage set once. The owner pressed the button, so the actor is the user.
import type { IdeaIntake } from '../../_lib/idea-intake.js';
import { createContent } from './core/content.js';
import type { FbFormat } from './types.js';

export function createIdeaIntake(): IdeaIntake {
  return {
    createIdea(input) {
      const dto = createContent(
        {
          title: input.title,
          caption: input.caption,
          format: (input.format ?? 'text') as FbFormat,
          pillar: input.pillar ?? '',
          hookType: input.hookType ?? '',
          pageId: input.pageId ?? null,
          status: 'idea',
          lineage: input.lineage,
        },
        { kind: 'user' },
      );
      return { id: dto.id };
    },
  };
}
