import { Popover } from '@base-ui/react/popover';
import { Button } from '@tulipfarm/sprout/button';

export function PopoverClose(props: Omit<Popover.Close.Props, 'render'>) {
  return <Popover.Close {...props} render={<Button size="icon-sm" variant="ghost" />} />;
}
