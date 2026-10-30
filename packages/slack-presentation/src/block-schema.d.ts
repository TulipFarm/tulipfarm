export const validateSurface: ((value: unknown) => boolean) & {
  errors?: { instancePath: string; message?: string }[] | null;
};
