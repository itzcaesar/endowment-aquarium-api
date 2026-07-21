import type { FishMood } from '@telu/contracts';

const HUNGER_DECAY_PER_HOUR = 5;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

export function calculateHunger(storedHunger: number, since: Date, now: Date): number {
  const elapsedMilliseconds = Math.max(0, now.getTime() - since.getTime());
  const elapsedWholeHours = Math.floor(elapsedMilliseconds / MILLISECONDS_PER_HOUR);
  return Math.max(0, storedHunger - elapsedWholeHours * HUNGER_DECAY_PER_HOUR);
}

export function moodForHunger(hunger: number): FishMood {
  if (hunger >= 70) return 'happy';
  if (hunger >= 30) return 'neutral';
  return 'hungry';
}
