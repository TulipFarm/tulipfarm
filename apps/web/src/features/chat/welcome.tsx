import { useFirstSession } from '@/lib/user-visit';
import { pickGreeting } from './greeting';

export function Welcome({ name }: { name: string | undefined }) {
  return pickGreeting(name, useFirstSession());
}
