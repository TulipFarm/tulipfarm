export const shippedModelFamilies = 'claude-haiku,claude-sonnet';

export function useModelFamilies(families = shippedModelFamilies) {
  const previous = process.env.MODEL_FAMILIES;
  process.env.MODEL_FAMILIES = families;
  return () => {
    if (previous === undefined) delete process.env.MODEL_FAMILIES;
    else process.env.MODEL_FAMILIES = previous;
  };
}
