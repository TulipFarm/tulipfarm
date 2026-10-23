import type { ReactNode } from 'react';
import { Body, Container, Head, Html, Link, Preview, Section, Tailwind, Text } from 'react-email';
import { emailTheme } from '../../theme.ts';

export interface EmailShellProps {
  preview: string;
  children: ReactNode;
  /** TulipFarm web origin shown in the footer; omitted when unknown. */
  appUrl?: string | undefined;
}

export function EmailShell({ preview, children, appUrl }: EmailShellProps) {
  return (
    <Html lang="en" dir="ltr">
      <Tailwind theme={emailTheme}>
        <Head>
          <meta name="color-scheme" content="light dark" />
          <meta name="supported-color-schemes" content="light dark" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </Head>
        <Preview>{preview}</Preview>
        <Body className="m-0 bg-background dark:bg-background-dark">
          <Section className="w-full bg-background px-4 py-8 font-sans text-foreground sm:py-12 dark:bg-background-dark dark:text-foreground-dark">
            <Container className="mx-auto w-full max-w-[560px] overflow-hidden rounded-xl border border-solid border-border bg-card dark:border-border-dark dark:bg-card-dark">
              {children}
              <Section className="border-0 border-t border-solid border-border px-6 py-8 text-center dark:border-border-dark">
                <Text className="m-0 text-sm text-muted-foreground dark:text-muted-foreground-dark">
                  Your agents, at work in TulipFarm.
                </Text>
                {appUrl ? (
                  <Text className="m-0 mt-4 text-xs text-muted-foreground dark:text-muted-foreground-dark">
                    <Link href={appUrl} className="text-muted-foreground underline dark:text-muted-foreground-dark">
                      {new URL(appUrl).host}
                    </Link>
                  </Text>
                ) : null}
              </Section>
            </Container>
          </Section>
        </Body>
      </Tailwind>
    </Html>
  );
}
