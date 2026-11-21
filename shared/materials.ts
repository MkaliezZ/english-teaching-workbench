export const materialExtensions = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.png', '.jpg', '.jpeg', '.webp'] as const;
export type MaterialExtension = typeof materialExtensions[number];
export const maxMaterialBytes = 32 * 1024 * 1024;

export function materialExtension(name: string): MaterialExtension | undefined {
  const match = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return materialExtensions.find(extension => extension === match);
}
