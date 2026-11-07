export const workspaceAdminsLabel = 'Workspace admins';

// The internal team of workspace admins is stored as _admin; people see it by its role instead.
export const teamLabel = (name: string) => (name === '_admin' ? workspaceAdminsLabel : name);
