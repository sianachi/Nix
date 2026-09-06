import type { PetProfile } from '@nix/api-client';

export const petCatalog = [
  {
    appearance: 'owl',
    name: 'Owl',
    personality: 'calm',
    description: 'Calm and thoughtful. Measured explanations and gentle encouragement.',
  },
] as const;

export const personalityDescriptions = {
  calm: 'Calm and thoughtful. Measured explanations and gentle encouragement.',
  playful: 'Playful and inventive. Fresh suggestions with a little humour.',
  encouraging: 'Encouraging and practical. Friendly, steady help to get things done.',
  concise: 'Concise and composed. Direct answers with the details that matter.',
} as const;

export function newPet(): PetProfile {
  const preset = petCatalog[0];
  return {
    id: crypto.randomUUID(),
    name: preset.name,
    appearance: 'owl',
    personality: preset.personality,
    responseLength: 'balanced',
    instructions: '',
  };
}
