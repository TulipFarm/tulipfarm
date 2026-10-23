import { Column, Row, Section, Text } from 'react-email';

export interface EmailChecklistItem {
  label: string;
  detail: string;
}

export function EmailChecklist({ items }: { items: EmailChecklistItem[] }) {
  return (
    <Section className="mb-6 rounded-xl border border-solid border-border bg-card dark:border-border-dark dark:bg-card-dark">
      {items.map((item, index) => (
        <Row
          key={item.label}
          className={
            index === 0 ? 'px-4 py-3' : 'border-0 border-t border-solid border-border px-4 py-3 dark:border-border-dark'
          }
        >
          <Column className="w-7 align-top">
            <Text className="m-0 text-sm font-semibold text-primary-text dark:text-primary-text-dark">✓</Text>
          </Column>
          <Column className="align-top">
            <Text className="m-0 text-sm font-semibold text-foreground dark:text-foreground-dark">{item.label}</Text>
            <Text className="m-0 text-sm text-muted-foreground dark:text-muted-foreground-dark">{item.detail}</Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}
