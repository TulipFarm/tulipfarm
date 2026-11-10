import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { workspaceSkillDefinitionSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { workspaceRoute } from '@/router';
import { useTableWrite } from '@/features/tables/use-table-write';
import { WriteFeedback } from '@/features/tables/feedback';
import { skillImportApi } from './import-api';

export function CreateSkillPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const api = useMemo(() => skillImportApi(workspace.id), [workspace.id]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState('');
  const nameInput = useRef<HTMLInputElement>(null);
  const open = (id: string) =>
    void navigate({
      to: '/$workspaceSlug/skills/import/$importId',
      params: { workspaceSlug: workspace.slug, importId: id },
    });
  const write = useTableWrite(
    (input: { id: string; definition: { name: string; description: string; instructions: string } }) =>
      api.draft(input.id, input.definition),
    view => open(view.id),
  );
  const busy = write.state.kind === 'sending' || write.state.kind === 'uncertain';
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <PageContent>
        <PageHeader
          title="Create skill"
          description="Write a procedure, then review it before saving."
          back={{
            label: 'Back to skills',
            link: <Link to="/$workspaceSlug/skills" params={{ workspaceSlug: workspace.slug }} />,
          }}
        />
        <Form
          disabled={busy}
          onSubmit={() => {
            if (busy) return;
            const parsed = workspaceSkillDefinitionSchema
              .omit({ package: true })
              .required({ description: true })
              .safeParse({ name, description, instructions });
            if (!parsed.success) {
              setError('Enter a name, description and instructions.');
              nameInput.current?.focus();
              return 'invalid';
            }
            setError('');
            void write.submit({ id: crypto.randomUUID(), definition: parsed.data });
          }}
        >
          <div className="max-w-2xl space-y-4">
            <Field id="skill-name" label="Name" required>
              <Input ref={nameInput} value={name} maxLength={120} onChange={event => setName(event.target.value)} />
            </Field>
            <Field
              id="skill-description"
              label="Description"
              required
              helper="What this skill does and when to use it."
            >
              <Input value={description} maxLength={280} onChange={event => setDescription(event.target.value)} />
            </Field>
            <Field id="skill-instructions" label="Instructions" required helper="The steps to follow.">
              <Textarea
                value={instructions}
                maxLength={32000}
                rows={10}
                onChange={event => setInstructions(event.target.value)}
              />
            </Field>
            <FormFooter
              dirty={false}
              submit={{
                label: 'Review skill',
                pendingLabel: 'Preparing review…',
                state: busy ? { kind: 'busy' } : { kind: 'ready' },
              }}
              error={error || undefined}
              note="Nothing is saved or enabled until you approve. Safety review uses workspace Credits."
            >
              <WriteFeedback
                state={write.state}
                retry={input => void write.submit(input)}
                checkStatus={() => {
                  if ('input' in write.state) open(write.state.input.id);
                }}
              />
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link
                    to="/$workspaceSlug"
                    params={{ workspaceSlug: workspace.slug }}
                    search={{ intent: 'create-skill' }}
                  />
                }
              >
                Create in chat
              </Button>
            </FormFooter>
          </div>
        </Form>
      </PageContent>
    </div>
  );
}
