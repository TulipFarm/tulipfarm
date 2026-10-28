import { tableGroups, resourceDependencies } from './system-package-compiler.ts';
import type { PackageResource, SystemPackage } from './system-package-contracts.ts';

export function cyclicTableGroup(pkg: SystemPackage, key: string) {
  const group = tableGroups(pkg).find(group => group.some(table => table.key === key));
  if (!group || (group.length === 1 && !resourceDependencies(group[0]!).includes(key))) return null;
  return group;
}

export function installationDependencies(pkg: SystemPackage, resource: PackageResource) {
  const group = resource.kind === 'table' ? cyclicTableGroup(pkg, resource.key) : null;
  const dependencies = (group ?? [resource]).flatMap(resourceDependencies);
  return [...new Set(dependencies.flatMap(key => cyclicTableGroup(pkg, key)?.map(table => table.key) ?? [key]))].filter(
    key => !group?.some(table => table.key === key),
  );
}

export function tableShell(resource: Extract<PackageResource, { kind: 'table' }>) {
  const fields = resource.fields.filter(field => field.kind !== 'relationship');
  const fieldKeys = new Set(fields.map(field => field.key));
  return {
    ...resource,
    fields,
    uniqueKeys: resource.uniqueKeys.filter(key => key.fields.every(field => fieldKeys.has(field))),
  };
}
