import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { definitionSchema, validateRecord, validateValue, type TableDefinition } from '@tulipfarm/tables/definition';
import { authoredDefinitionSchema } from '@tulipfarm/workflows/contracts';
import { agentSetupSchema } from './setup-contracts.ts';
import { buildSkillPackage } from './skill-packages.ts';
import {
  systemPackageSchema,
  packageBindingsSchema,
  type SystemPackage,
  type PackageResource,
  type PackageBindings,
  type packageIssueSchema,
  type packageWorkflowValueSchema,
} from './system-package-contracts.ts';

export const packageDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const packageIdentity = (installationId: string, key: string) => {
  const bytes = createHash('sha256').update(`${installationId}\0${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
type ResourceReference = { kind: 'resource'; resourceKind: PackageResource['kind']; key: string };
type InputReference = { kind: 'input'; inputKind: SystemPackage['inputs'][number]['kind']; key: string };
function declaredReferences(resource: PackageResource) {
  const resources: ResourceReference[] = [];
  const inputs: InputReference[] = [];
  function visit(value: unknown) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    // Workflow literals are user data, not a second template language.
    if (object.kind === 'literal') return;
    if (object.kind === 'resource' && typeof object.resourceKind === 'string' && typeof object.key === 'string')
      resources.push(object as ResourceReference);
    else if (object.kind === 'input' && typeof object.inputKind === 'string' && typeof object.key === 'string')
      inputs.push(object as InputReference);
    else Object.values(object).forEach(visit);
  }
  visit(resource);
  return { resources, inputs };
}
export function resourceReferences(resource: PackageResource) {
  return declaredReferences(resource).resources;
}
export function resourceDependencies(resource: PackageResource) {
  return [...new Set(resourceReferences(resource).map(ref => ref.key))];
}
export function tableGroups(pkg: SystemPackage) {
  const tables = new Map(pkg.resources.filter(resource => resource.kind === 'table').map(table => [table.key, table]));
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    pending: string[] = [],
    active = new Set<string>();
  const groups: Extract<PackageResource, { kind: 'table' }>[][] = [];
  function visit(key: string) {
    const position = index.size;
    index.set(key, position);
    low.set(key, position);
    pending.push(key);
    active.add(key);
    for (const target of resourceDependencies(tables.get(key)!)) {
      if (!tables.has(target)) continue;
      if (!index.has(target)) {
        visit(target);
        low.set(key, Math.min(low.get(key)!, low.get(target)!));
      } else if (active.has(target)) low.set(key, Math.min(low.get(key)!, index.get(target)!));
    }
    if (low.get(key) !== index.get(key)) return;
    const group = [];
    for (;;) {
      const current = pending.pop()!;
      active.delete(current);
      group.push(tables.get(current)!);
      if (current === key) break;
    }
    groups.push(group);
  }
  for (const key of tables.keys()) if (!index.has(key)) visit(key);
  return groups;
}
export function packageAssetBytes(asset: SystemPackage['assets'][number]) {
  const bytes = Buffer.from(asset.content, asset.encoding);
  if (asset.encoding === 'base64' && bytes.toString('base64') !== asset.content)
    throw new Error(`Asset ${asset.key} must use canonical base64`);
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error(`Asset ${asset.key} size or SHA-256 does not match its bytes`);
  return bytes;
}
export function packageCompiler(pkg: SystemPackage, bindings: PackageBindings, installationId: string) {
  const resources = new Map(pkg.resources.map(resource => [resource.key, resource]));
  const assets = new Map(pkg.assets.map(asset => [asset.key, asset]));
  const id = (key: string) => packageIdentity(installationId, `resource:${key}`);
  const fieldId = (table: string, field: string) => packageIdentity(installationId, `field:${table}:${field}`);
  const optionId = (table: string, field: string, option: string) =>
    packageIdentity(installationId, `option:${table}:${field}:${option}`);
  function table(key: string) {
    const value = resources.get(key);
    if (value?.kind !== 'table') throw new Error(`Unknown table: ${key}`);
    return value;
  }
  function binding(key: string, kind: Exclude<PackageBindings[string]['kind'], 'timezone' | 'slack-channel'>) {
    const value = bindings[key];
    if (!value || value.kind !== kind || !('id' in value)) throw new Error(`Missing ${kind} binding: ${key}`);
    return value.id;
  }
  function inputValue(key: string, kind: 'timezone' | 'slack-channel') {
    const value = bindings[key];
    if (!value || value.kind !== kind || !('value' in value)) throw new Error(`Missing ${kind} binding: ${key}`);
    return value.value;
  }
  function resolve(ref: ResourceReference | InputReference) {
    if (ref.kind === 'resource') return id(ref.key);
    if (ref.inputKind === 'timezone' || ref.inputKind === 'slack-channel') return inputValue(ref.key, ref.inputKind);
    return binding(ref.key, ref.inputKind);
  }
  function timezone(value: string | Extract<InputReference, { kind: 'input' }>) {
    return typeof value === 'string' ? value : inputValue(value.key, 'timezone');
  }
  function definition(resource: Extract<PackageResource, { kind: 'table' }>): TableDefinition {
    return definitionSchema.parse({
      formatVersion: 2,
      id: id(resource.key),
      owningTeamId: binding(resource.owningTeam.key, 'team'),
      label: resource.label,
      fields: resource.fields.map(({ key, ...field }) => {
        const base = { ...field, id: fieldId(resource.key, key) };
        if (field.kind === 'relationship') {
          const { target: _, ...rest } = base as typeof base & { target: unknown };
          return {
            ...rest,
            targetTableId: id(field.target.key),
            reverse: field.reverse
              ? { fieldId: fieldId(field.target.key, field.reverse.key), label: field.reverse.label }
              : null,
          };
        }
        if (field.kind === 'single-select' || field.kind === 'multi-select')
          return {
            ...base,
            options: field.options.map(({ key: option, ...rest }) => ({
              ...rest,
              id: optionId(resource.key, key, option),
            })),
          };
        return base;
      }),
      uniqueKeys: resource.uniqueKeys.map(key => ({
        id: packageIdentity(installationId, `unique:${resource.key}:${key.key}`),
        fieldIds: key.fields.map(field => fieldId(resource.key, field)),
        nulls: key.nulls,
      })),
    });
  }
  function rows(resource: Extract<PackageResource, { kind: 'seed-row' }>) {
    const target = table(resource.table.key);
    const values = Object.fromEntries(
      Object.entries(resource.values).map(([key, value]) => {
        let resolved: unknown = value;
        if (value?.kind === 'single-select')
          resolved = { kind: value.kind, optionId: optionId(target.key, key, value.option) };
        if (value?.kind === 'multi-select')
          resolved = { kind: value.kind, optionIds: value.options.map(option => optionId(target.key, key, option)) };
        if (value?.kind === 'relationship') {
          const field = target.fields.find(field => field.key === key);
          if (field?.kind !== 'relationship') throw new Error(`Expected relationship field: ${key}`);
          for (const row of value.rows) {
            const targetRow = resources.get(row.key);
            if (targetRow?.kind !== 'seed-row' || targetRow.table.key !== field.target.key)
              throw new Error(`Row ${row.key} does not belong to ${field.target.key}`);
          }
          resolved = { kind: value.kind, tableId: id(field.target.key), recordIds: value.rows.map(row => id(row.key)) };
        }
        if (value?.kind === 'file') resolved = { kind: value.kind, fileIds: value.files.map(resolve) };
        return [fieldId(target.key, key), resolved];
      }),
    );
    return validateRecord(definition(target), values);
  }
  function skill(resource: Extract<PackageResource, { kind: 'skill' }>) {
    return buildSkillPackage(
      resource.files.map(file => {
        const asset = assets.get(file.asset);
        if (!asset) throw new Error(`Unknown asset: ${file.asset}`);
        return { path: file.path, bytes: packageAssetBytes(asset) };
      }),
    );
  }
  function workflow(resource: Extract<PackageResource, { kind: 'workflow' }>) {
    const trigger = resource.trigger;
    const field = (tableKey: string, field: string) => {
      if (!table(tableKey).fields.some(item => item.key === field))
        throw new Error(`Unknown field: ${tableKey}.${field}`);
      return fieldId(tableKey, field);
    };
    function compileValue(input: z.infer<typeof packageWorkflowValueSchema>) {
      if (input.kind === 'literal') return input;
      if (input.kind === 'option' || input.kind === 'options') {
        const target = table(input.table.key).fields.find(item => item.key === input.field);
        const keys = input.kind === 'option' ? [input.option] : input.options;
        if (
          !target ||
          (target.kind !== 'single-select' && target.kind !== 'multi-select') ||
          target.kind !== (input.kind === 'option' ? 'single-select' : 'multi-select')
        )
          throw new Error(
            `Expected ${input.kind === 'option' ? 'single-select' : 'multi-select'} field: ${input.table.key}.${input.field}`,
          );
        if (new Set(keys).size !== keys.length || keys.some(key => !target.options.some(option => option.key === key)))
          throw new Error(`Unknown or duplicate select option: ${input.table.key}.${input.field}`);
        const values = keys.map(key => optionId(input.table.key, input.field, key));
        return { kind: 'literal' as const, value: input.kind === 'option' ? values[0]! : values };
      }
      const source = input.kind === 'input' ? trigger : resource.steps.find(step => step.id === input.step);
      const sourceTable = source && 'table' in source ? source.table.key : undefined;
      return {
        ...input,
        path: input.path.map((part, index) => {
          if (typeof part === 'string') return part;
          const rowInput =
            input.kind === 'input' &&
            (trigger.kind === 'row' || trigger.kind === 'record') &&
            index === 1 &&
            (input.path[0] === 'values' ||
              (input.path[0] === 'previousValues' && trigger.kind === 'row' && trigger.event === 'updated'));
          const foundRow =
            input.kind === 'step' &&
            source?.kind === 'find-rows' &&
            index === 3 &&
            input.path[0] === 'rows' &&
            typeof input.path[1] === 'string' &&
            /^(0|[1-9]\d*)$/.test(input.path[1]) &&
            input.path[2] === 'values';
          if (!sourceTable || (!rowInput && !foundRow))
            throw new Error(`Field path in ${resource.key} must name a table source's values or previousValues`);
          if (table(sourceTable).fields.find(item => item.key === part.field)?.kind === 'file')
            throw new Error('Native workflow values do not expose file fields');
          return field(sourceTable, part.field);
        }),
      };
    }
    function filter(input: NonNullable<Extract<typeof trigger, { kind: 'row' }>['filter']>, tableKey: string) {
      const { field: key, ...rest } = input;
      const target = table(tableKey).fields.find(item => item.key === key);
      if ('value' in rest && (!target || target.kind !== rest.value.kind))
        throw new Error(`Filter value does not match ${tableKey}.${key}`);
      if ('value' in rest && rest.value.kind === 'single-select') {
        const selected = rest.value.option;
        if (target?.kind !== 'single-select' || !target.options.some(option => option.key === selected))
          throw new Error(`Unknown option for ${tableKey}.${key}`);
      }
      return {
        ...rest,
        fieldId: field(tableKey, key),
        ...('value' in rest && rest.value.kind === 'single-select'
          ? { value: { kind: 'single-select', optionId: optionId(tableKey, key, rest.value.option) } }
          : {}),
      };
    }
    const compiledTrigger = (() => {
      if (trigger.kind === 'row')
        return {
          kind: trigger.kind,
          tableId: id(trigger.table.key),
          event: trigger.event,
          ...(trigger.fields ? { fieldIds: trigger.fields.map(key => field(trigger.table.key, key)) } : {}),
          ...(trigger.filter ? { filter: filter(trigger.filter, trigger.table.key) } : {}),
        };
      if (trigger.kind === 'record') {
        const { field: key, ...schedule } = trigger.field;
        return {
          kind: trigger.kind,
          tableId: id(trigger.table.key),
          field: {
            ...schedule,
            fieldId: field(trigger.table.key, key),
            ...('timezone' in schedule ? { timezone: timezone(schedule.timezone) } : {}),
          },
          ...(trigger.filter ? { filter: filter(trigger.filter, trigger.table.key) } : {}),
        };
      }
      if (trigger.kind === 'provider')
        return {
          kind: trigger.kind,
          integrationId: integration(resources.get(trigger.integration.key)),
          event: trigger.event,
          minutes: trigger.minutes,
        };
      if ('timezone' in trigger && trigger.timezone) return { ...trigger, timezone: timezone(trigger.timezone) };
      return trigger;
    })();
    return authoredDefinitionSchema.parse({
      version: 1,
      name: resource.name,
      trigger: compiledTrigger,
      steps: resource.steps.map(step => {
        if (step.kind === 'agent') {
          const { agent, ...rest } = step;
          return { ...rest, agentId: resolve(agent), prompt: compileValue(step.prompt) };
        }
        if (step.kind === 'condition')
          return {
            ...step,
            when: {
              ...step.when,
              left: compileValue(step.when.left),
              ...('right' in step.when ? { right: compileValue(step.when.right) } : {}),
            },
          };
        if (step.kind === 'transform')
          return {
            ...step,
            fields: Object.fromEntries(Object.entries(step.fields).map(([key, input]) => [key, compileValue(input)])),
          };
        if (step.kind === 'wait-until') return { ...step, at: compileValue(step.at) };
        if (step.kind === 'code') return { ...step, input: compileValue(step.input) };
        if (step.kind === 'http') {
          const { credential, ...rest } = step;
          return {
            ...rest,
            headers: Object.fromEntries(Object.entries(step.headers).map(([key, input]) => [key, compileValue(input)])),
            ...(step.body ? { body: compileValue(step.body) } : {}),
            ...(credential
              ? { credential: { integrationId: resolve(credential.integration), header: credential.header } }
              : {}),
          };
        }
        if (step.kind === 'slack-message') {
          const { destination, ...rest } = step;
          return { ...rest, destinationId: resolve(destination), text: compileValue(step.text) };
        }
        if ('table' in step) {
          const { table: tableRef, ...rest } = step;
          if ('fields' in rest) {
            if (new Set(rest.fields.map(entry => entry.field)).size !== rest.fields.length)
              throw new Error(`Duplicate field mapping: ${step.id}`);
            return {
              ...rest,
              ...(step.kind === 'update-row' ? { row: compileValue(step.row) } : {}),
              tableId: id(tableRef.key),
              fields: Object.fromEntries(
                rest.fields.map(entry => {
                  const targetId = field(tableRef.key, entry.field);
                  if (entry.value.kind !== 'table-value') return [targetId, compileValue(entry.value)];
                  const target = definition(table(tableRef.key)).fields.find(item => item.id === targetId)!;
                  const value = entry.value.value;
                  let resolved: unknown = value;
                  if (value?.kind === 'single-select')
                    resolved = { kind: value.kind, optionId: optionId(tableRef.key, entry.field, value.option) };
                  if (value?.kind === 'multi-select')
                    resolved = {
                      kind: value.kind,
                      optionIds: value.options.map(option => optionId(tableRef.key, entry.field, option)),
                    };
                  if (value?.kind === 'relationship') {
                    if (target.kind !== 'relationship') throw new Error('Expected relationship field');
                    for (const row of value.rows) {
                      const item = resources.get(row.key);
                      if (item?.kind !== 'seed-row' || id(item.table.key) !== target.targetTableId)
                        throw new Error(`Relationship target mismatch: ${row.key}`);
                    }
                    resolved = {
                      kind: value.kind,
                      tableId: target.targetTableId,
                      recordIds: value.rows.map(row => id(row.key)),
                    };
                  }
                  if (value?.kind === 'file') resolved = { kind: value.kind, fileIds: value.files.map(resolve) };
                  const parsed = validateValue(target, resolved);
                  const literal =
                    parsed === null
                      ? null
                      : 'value' in parsed
                        ? parsed.value
                        : parsed.kind === 'single-select'
                          ? parsed.optionId
                          : parsed.kind === 'multi-select'
                            ? parsed.optionIds
                            : parsed.kind === 'relationship'
                              ? parsed.recordIds
                              : parsed.fileIds;
                  return [targetId, { kind: 'literal', value: literal }];
                }),
              ),
            };
          }
          return {
            ...rest,
            tableId: id(tableRef.key),
            filters: rest.filters.map(({ field: key, ...filter }) => ({
              ...filter,
              ...('value' in filter ? { value: compileValue(filter.value) } : {}),
              fieldId: field(tableRef.key, key),
            })),
          };
        }
        return step;
      }),
    });
  }
  function integration(resource: PackageResource | undefined) {
    if (resource?.kind !== 'integration') throw new Error('Expected integration reference');
    return binding(resource.binding.key, 'integration');
  }
  function agent(resource: Extract<PackageResource, { kind: 'agent' }>, revisions: Record<string, string>) {
    const scope = (entries: typeof resource.scope) =>
      entries.map(entry => ({
        assetId: resolve('table' in entry ? entry.table : entry.asset),
        permissions: entry.permissions,
      }));
    const { mcp, ...definition } = resource.definition;
    return agentSetupSchema.parse({
      definition: {
        ...definition,
        ...(mcp
          ? {
              mcp: mcp.map(({ integration, ...slot }) => ({
                ...slot,
                ...(integration ? { integrationId: resolve(integration) } : {}),
              })),
            }
          : {}),
        skills: resource.skills.map(ref =>
          ref.kind === 'builtin'
            ? { id: ref.id, revision: ref.revision }
            : { id: resolve(ref), revision: ref.kind === 'resource' ? revisions[ref.key] : ref.revision },
        ),
      },
      owningTeamId: resource.owningTeam ? binding(resource.owningTeam.key, 'team') : null,
      policy: {
        grants: (resource.policy?.grants ?? []).map(({ team, permissions }) => ({
          teamId: resolve(team),
          permissions,
        })),
        personGrants: (resource.policy?.personGrants ?? []).map(({ member, permissions }) => ({
          membershipId: resolve(member),
          permissions,
        })),
      },
      enrollment: resource.enrollment.map(resolve),
      scope: scope(resource.scope),
      limits: scope(resource.limits ?? resource.scope),
      taskLimits: resource.taskLimits,
      slackSender: resource.slackSender,
      slackChannels: resource.slackChannels.map(({ channel, replaceAgent, detach }) => ({
        channel: resolve(channel),
        expectedVersion: 0,
        replaceAgentId: replaceAgent ? resolve(replaceAgent) : null,
        ...(detach === undefined ? {} : { detach }),
      })),
      schedules: resource.schedules.map(schedule => ({
        id: packageIdentity(installationId, `schedule:${resource.key}:${schedule.key}`),
        trigger:
          schedule.trigger.kind === 'cron'
            ? { ...schedule.trigger, timezone: timezone(schedule.trigger.timezone) }
            : schedule.trigger,
        action: schedule.action,
        sponsorMembershipId: resolve(schedule.sponsor),
      })),
    });
  }
  function file(resource: Extract<PackageResource, { kind: 'file' }>) {
    const asset = assets.get(resource.asset);
    if (!asset) throw new Error(`Unknown asset: ${resource.asset}`);
    return { name: resource.name, mimeType: resource.mimeType, bytes: packageAssetBytes(asset) };
  }
  return {
    id,
    fieldId,
    optionId,
    table,
    binding,
    inputValue,
    resolve,
    definition,
    rows,
    skill,
    file,
    workflow,
    integration,
    agent,
  };
}
export function validatePackage(value: unknown, inputBindings: unknown) {
  const pkg = systemPackageSchema.parse(value);
  const bindings = packageBindingsSchema.parse(inputBindings);
  const issues: z.infer<typeof packageIssueSchema>[] = [];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  const unique = (items: { key: string }[], path: string) => {
    if (new Set(items.map(item => item.key)).size !== items.length) issue('duplicate-key', path, 'Keys must be unique');
  };
  unique(pkg.resources, 'resources');
  unique(pkg.inputs, 'inputs');
  unique(pkg.assets, 'assets');
  unique(pkg.outputs, 'outputs');
  if (new Set(pkg.assets.map(asset => asset.path)).size !== pkg.assets.length)
    issue('duplicate-path', 'assets', 'Asset paths must be unique');
  if (new Set(pkg.requires.capabilities).size !== pkg.requires.capabilities.length)
    issue('duplicate-capability', 'requires.capabilities', 'Capabilities must be unique');
  const resources = new Map(pkg.resources.map(resource => [resource.key, resource]));
  const inputMap = new Map(pkg.inputs.map(input => [input.key, input]));
  for (const input of pkg.inputs) {
    const selected = bindings[input.key];
    if (!selected || selected.kind !== input.kind)
      issue('missing-binding', `inputs.${input.key}`, `Choose a ${input.kind} for ${input.title}`);
    if (selected?.kind === 'timezone') {
      try {
        new Intl.DateTimeFormat('en', { timeZone: selected.value });
      } catch {
        issue('invalid-timezone', `inputs.${input.key}`, 'Use a supported IANA timezone');
      }
    }
  }
  for (const key of Object.keys(bindings))
    if (!inputMap.has(key)) issue('unknown-binding', `bindings.${key}`, 'Binding was not declared');
  let totalBytes = 0;
  for (const asset of pkg.assets) {
    try {
      totalBytes += packageAssetBytes(asset).length;
    } catch (error) {
      issue(
        'asset-digest-mismatch',
        `assets.${asset.key}`,
        error instanceof Error ? error.message : 'Invalid asset bytes',
      );
    }
  }
  if (totalBytes > 32 * 1024 * 1024)
    issue(
      'package-too-large',
      'assets',
      'Bundled files must total at most 32 MiB; each skill retains its native 10 MiB limit',
    );
  const capabilities = {
    table: 'tables',
    'seed-row': 'seed-rows',
    skill: 'skills',
    agent: 'agents',
    workflow: 'workflows',
    integration: 'integration-bindings',
    file: 'files',
  } as const;
  for (const resource of pkg.resources) {
    if (!pkg.requires.capabilities.includes(capabilities[resource.kind]))
      issue('missing-capability', resource.key, `Declare ${capabilities[resource.kind]}`);
    for (const ref of resourceReferences(resource)) {
      if (resources.get(ref.key)?.kind !== ref.resourceKind)
        issue('invalid-reference', resource.key, `Expected ${ref.resourceKind}: ${ref.key}`);
    }
    const refs = declaredReferences(resource).inputs;
    for (const ref of refs)
      if (inputMap.get(ref.key)?.kind !== ref.inputKind)
        issue('invalid-input-reference', resource.key, `Expected ${ref.inputKind} input: ${ref.key}`);
    if (
      resource.kind === 'skill' &&
      resource.sharing &&
      ![...resource.sharing.grants, ...resource.sharing.personGrants].some(grant =>
        grant.permissions.includes('manage'),
      )
    )
      issue(
        'skill-manager-required',
        `${resource.key}.sharing`,
        'Skill sharing replaces existing grants. Explicitly grant manage access to at least one person or team.',
      );
    if (resource.kind === 'table') {
      unique(resource.fields, `${resource.key}.fields`);
      unique(resource.uniqueKeys, `${resource.key}.uniqueKeys`);
      for (const field of resource.fields)
        if ('options' in field) unique(field.options, `${resource.key}.${field.key}.options`);
      for (const field of resource.fields) {
        if (field.kind !== 'relationship' || !field.reverse) continue;
        const target = resources.get(field.target.key);
        const reverseKey = field.reverse.key;
        const reverseCount = pkg.resources
          .filter(item => item.kind === 'table')
          .flatMap(item => item.fields)
          .filter(
            item =>
              item.kind === 'relationship' && item.target.key === field.target.key && item.reverse?.key === reverseKey,
          ).length;
        if ((target?.kind === 'table' && target.fields.some(item => item.key === reverseKey)) || reverseCount > 1)
          issue(
            'duplicate-reverse-field',
            resource.key,
            `Reverse field ${field.target.key}.${reverseKey} conflicts with another field`,
          );
      }
    }
    if (resource.kind === 'agent')
      for (const pin of resource.skills) {
        if (pin.kind !== 'resource') continue;
        const skill = resources.get(pin.key);
        if (skill?.kind === 'skill' && skill.requestedState !== 'enabled')
          issue('skill-review-required', resource.key, `Agent pin ${pin.key} must request enabled state`);
      }
    if (resource.kind === 'workflow')
      for (const step of resource.steps)
        if (step.kind === 'agent' && step.agent.kind === 'resource') {
          const agent = resources.get(step.agent.key);
          if (agent?.kind === 'agent' && agent.requestedState !== 'active')
            issue('agent-activation-required', resource.key, `Workflow agent ${agent.key} must request active state`);
        }
    if (
      resource.kind === 'workflow' &&
      resource.requestedState === 'enabled' &&
      !['manual', 'event'].includes(resource.trigger.kind) &&
      !resource.sponsor
    )
      issue(
        'sponsor-required',
        resource.key,
        'An enabled unattended workflow requires an explicit member input as sponsor',
      );
    if (resource.kind === 'workflow' && resource.trigger.kind === 'provider' && resource.trigger.event === 'updated') {
      const integration = resources.get(resource.trigger.integration.key);
      if (integration?.kind === 'integration' && integration.source.provider !== 'sheets')
        issue('unsupported-provider-operation', resource.key, 'Only Sheets supports updated provider events');
    }
  }
  for (const output of pkg.outputs)
    if (resources.get(output.resource.key)?.kind !== output.resource.resourceKind)
      issue('invalid-output', `outputs.${output.key}`, 'Output must reference a resource of the declared kind');
  const visiting = new Set<string>(),
    visited = new Set<string>(),
    order: string[] = [];
  function visit(key: string) {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      if (resources.get(key)?.kind !== 'table')
        issue('dependency-cycle', key, 'Only table-definition cycles support phased installation');
      return;
    }
    visiting.add(key);
    const resource = resources.get(key);
    if (resource) for (const dependency of resourceDependencies(resource)) visit(dependency);
    visiting.delete(key);
    visited.add(key);
    if (resource) order.push(key);
  }
  for (const resource of pkg.resources) visit(resource.key);
  if (!issues.length) {
    const compiler = packageCompiler(pkg, bindings, '00000000-0000-4000-8000-000000000001');
    const revisions: Record<string, string> = {};
    for (const key of order) {
      const resource = resources.get(key)!;
      try {
        switch (resource.kind) {
          case 'table':
            compiler.definition(resource);
            break;
          case 'seed-row':
            compiler.rows(resource);
            break;
          case 'skill':
            revisions[key] = packageDigest(compiler.skill(resource).definition);
            break;
          case 'agent':
            compiler.agent(resource, revisions);
            break;
          case 'workflow':
            compiler.workflow(resource);
            break;
          case 'integration':
            compiler.integration(resource);
            break;
          case 'file':
            compiler.file(resource);
            break;
        }
      } catch (error) {
        issue('invalid-definition', `resources.${key}`, error instanceof Error ? error.message : 'Invalid definition');
      }
    }
  }
  return {
    valid: !issues.length,
    packageDigest: packageDigest(pkg),
    inputDigest: packageDigest({ package: pkg, bindings }),
    issues,
    order,
  };
}
