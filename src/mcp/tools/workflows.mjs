// get_workflow: a playbook for clients that don't show MCP prompts.
import { z } from 'zod';
import { WORKFLOWS } from '../workflows/index.mjs';
import { textResult } from './shared.mjs';

const byName = new Map(WORKFLOWS.map((workflow) => [workflow.name, workflow]));

export const WORKFLOW_TOOLS = [
  {
    name: 'get_workflow',
    title: 'Get a playbook',
    description: `The step-by-step playbook for a multi-step job. Read it before starting one: ${WORKFLOWS.map((workflow) => `${workflow.name} (${workflow.description.replace(/\.$/, '')})`).join('; ')}.`,
    schema: z.object({ name: z.enum(WORKFLOWS.map((workflow) => workflow.name)) }).strict(),
    handler: async ({ name }) => textResult([byName.get(name).text]),
  },
];
