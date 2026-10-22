import type {
  RichTextElement,
  RichTextBlock,
  RichTextList,
  RichTextSection,
  RichTextQuote,
  RichTextPreformatted,
} from '@slack/types';

type ReferenceStyle = {
  style?: {
    bold?: boolean;
    italic?: boolean;
    strike?: boolean;
    highlight?: boolean;
    client_highlight?: boolean;
    underline?: boolean;
    unlink?: boolean;
  };
};
export type WebsiteRichTextElement = ReferenceStyle &
  (
    | {
        type: 'attachment_mention';
        url: string;
        text?: string;
        app_id?: string;
        entity_id?: string;
        icon_url?: string;
        channel_id?: string;
        ts?: string;
        full_size_preview_enabled?: boolean;
        icon_name?: string;
        reference_object_type?: string;
        product_name?: string;
      }
    | {
        type: 'canvas';
        file_id: string;
        label?: string;
        hide_title?: boolean;
        section_id?: string;
        text?: string;
        url?: string;
        is_skill_invocation?: boolean;
      }
    | { type: 'canvas_user_mention'; user_id: string; thread_id?: string }
    | { type: 'canvas_message_unfurl'; root_message_ts: string; root_message_channel: string }
    | { type: 'file'; file_id: string; text?: string; url?: string; is_skill_invocation?: boolean }
    | { type: 'list_record'; file_id: string; record_id?: string; view_id?: string; text?: string; url?: string }
    | {
        type: 'message_mention';
        channel_id: string;
        message_ts: string;
        author_id?: string;
        thread_ts?: string;
        text?: string;
        url?: string;
      }
    | {
        type: 'salesforce_data_field';
        salesforce_record_id: string;
        salesforce_field_label?: string;
        salesforce_field_api_name?: string;
        salesforce_include_field_label?: boolean;
      }
    | {
        type: 'tag';
        text: string;
        color?: 'gray' | 'brown' | 'purple' | 'indigo' | 'blue' | 'green' | 'yellow' | 'orange' | 'red';
      }
    | {
        type: 'work_object_mention';
        entity_id: string;
        app_id: string;
        text: string;
        url: string;
        icon_url?: string;
        full_size_preview_enabled?: boolean;
        product_name?: string;
      }
    | {
        type: 'workflow_mention';
        workflow_id: string;
        function_trigger_id: string;
        text: string;
        url?: string;
        channel_id?: string;
        ts?: string;
      }
  );
export type CitationElement = {
  type: 'citation';
  url: string;
  text: string;
  index: number;
  from_llm?: boolean;
  is_slack_url?: boolean;
  details:
    | { citation_type: 'file'; descriptor: string; file_id: string }
    | { citation_type: 'external'; app_name: string; app_icon_url: string }
    | { citation_type: 'web'; display_name: string; title: string; snippet: string }
    | { citation_type: 'message'; channel: string; message_ts: string }
    | { citation_type: 'memory'; memory_id: string };
};
export type SlackRichElement = RichTextElement | WebsiteRichTextElement | CitationElement;
export type SlackRichSection = Omit<RichTextSection, 'elements'> & { elements: SlackRichElement[] };
export type SlackRichList = Omit<RichTextList, 'elements'> & { elements: SlackRichSection[]; offset?: number };
export type SlackRichBlockElement =
  | RichTextPreformatted
  | SlackRichSection
  | SlackRichList
  | (Omit<RichTextQuote, 'elements'> & { elements: SlackRichElement[] });
export type SlackRichText = Omit<RichTextBlock, 'elements'> & { elements: SlackRichBlockElement[] };
