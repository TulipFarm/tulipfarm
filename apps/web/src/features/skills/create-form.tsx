import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Button } from '@tulipfarm/sprout/button';
import { Field } from '@tulipfarm/sprout/field';
import { Form, FormFooter } from '@tulipfarm/sprout/form';
import { Input } from '@tulipfarm/sprout/input';
import { Textarea } from '@tulipfarm/sprout/textarea';
import { PageContent } from '@tulipfarm/sprout/page-content';
import { PageHeader } from '@tulipfarm/sprout/page-header';
import { Alert, AlertDescription } from '@tulipfarm/sprout/alert';
import { workspaceSkillDefinitionSchema } from '@tulipfarm/agents/workspace-skill-contracts';
import { workspaceRoute } from '@/router';
import { useTableWrite } from '@/features/tables/use-table-write';
import { skillImportApi } from './import-api';

export function CreateSkillPage() {
  const { workspace } = workspaceRoute.useRouteContext();
  const navigate = useNavigate();
  const api = useMemo(() => skillImportApi(workspace.id, true), [workspace.id]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [errors, setErrors] = useState<Partial<Record<'name' | 'description' | 'instructions', string>>>({});
  const nameInput = useRef<HTMLInputElement>(null);
  const descriptionInput = useRef<HTMLInputElement>(null);
  const instructionsInput = useRef<HTMLTextAreaElement>(null);
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
              const invalid = {
                ...(!name.trim() ? { name: 'Enter a name.' } : {}),
                ...(!description.trim() ? { description: 'Enter a description.' } : {}),
                ...(!instructions.trim() ? { instructions: 'Enter instructions.' } : {}),
              };
              setErrors(invalid);
              (invalid.name ? nameInput : invalid.description ? descriptionInput : instructionsInput).current?.focus();
              return 'invalid';
            }
            setErrors({});
            void write.submit({ id: crypto.randomUUID(), definition: parsed.data });
          }}
        >
          <div className="max-w-2xl space-y-4">
            <Field id="skill-name" label="Name" required error={errors.name}>
              <Input
                ref={nameInput}
                value={name}
                maxLength={120}
                onChange={event => {
                  setName(event.target.value);
                  setErrors(current => ({ ...current, name: '' }));
                }}
              />
            </Field>
            <Field
              id="skill-description"
              label="Description"
              required
              error={errors.description}
              helper="What this skill does and when to use it."
            >
              <Input
                ref={descriptionInput}
                value={description}
                maxLength={280}
                onChange={event => {
                  setDescription(event.target.value);
                  setErrors(current => ({ ...current, description: '' }));
                }}
              />
            </Field>
            <Field
              id="skill-instructions"
              label="Instructions"
              required
              error={errors.instructions}
              helper="The steps to follow."
            >
              <Textarea
                ref={instructionsInput}
                value={instructions}
                maxLength={32000}
                rows={10}
                onChange={event => {
                  setInstructions(event.target.value);
                  setErrors(current => ({ ...current, instructions: '' }));
                }}
              />
            </Field>
            <FormFooter
              dirty={false}
              submit={{
                label: 'Review skill',
                pendingLabel: 'Starting review…',
                state:
                  write.state.kind === 'sending'
                    ? { kind: 'busy' }
                    : write.state.kind === 'uncertain'
                      ? { kind: 'blocked', reason: 'Check whether it started before trying again.' }
                      : { kind: 'ready' },
              }}
              note="Starts a safety review, which uses workspace Credits when the review runs. The skill isn't saved or enabled until you approve it."
            >
              {(write.state.kind === 'uncertain' || write.state.kind === 'rejected') && (
                <div className="space-y-3">
                  <Alert variant="destructive">
                    <AlertDescription>
                      {write.state.kind === 'uncertain'
                        ? "We couldn't confirm that the safety review started. Your skill is still here. Check whether it started before trying again."
                        : write.state.message}
                    </AlertDescription>
                  </Alert>
                  {write.state.kind === 'uncertain' && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        onClick={() => {
                          if ('input' in write.state) open(write.state.input.id);
                        }}
                      >
                        Check whether it started
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if ('input' in write.state) void write.submit(write.state.input);
                        }}
                      >
                        Try again
                      </Button>
                    </div>
                  )}
                </div>
              )}
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
