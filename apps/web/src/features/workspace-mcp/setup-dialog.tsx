import type { ReactNode } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tulipfarm/sprout/dialog';

/** The frame every MCP setup form opens in, so adding a server never pushes content down the page. It opens
 * from the top, so fields that appear grow it downwards and nothing above them moves. */
export function SetupDialog({
  title,
  description,
  close,
  footer,
  children,
}: {
  title: string;
  description: ReactNode;
  close: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={open => !open && close()}>
      <DialogContent size="form" placement="top" data-steady-width="">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
