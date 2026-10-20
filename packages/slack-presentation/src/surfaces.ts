import type {
  HomeView,
  ModalView,
  PlainTextElement,
  TextObject,
  ImageElement,
  CardBlock,
  TaskCardBlock,
  ActionsBlock,
  AlertBlock,
  ContextBlock,
  ContextActionsBlock,
  DividerBlock,
  FileBlock,
  HeaderBlock,
  ImageBlock,
  InputBlock,
  MarkdownBlock,
  SectionBlock,
  VideoBlock,
} from '@slack/types';
import type { SlackRichText } from './rich-text.ts';

export type SlackTable = {
  type: 'table';
  block_id?: string;
  rows: DataTableBlock['rows'];
  column_settings?: ({ align?: 'left' | 'center' | 'right'; is_wrapped?: boolean } | null)[];
};
export type ContainerChild =
  | ActionsBlock
  | ContextBlock
  | DividerBlock
  | FileBlock
  | HeaderBlock
  | ImageBlock
  | InputBlock
  | SectionBlock
  | VideoBlock
  | SlackRichText
  | SlackTable;
export type ContainerBlock = {
  type: 'container';
  block_id?: string;
  child_blocks: ContainerChild[];
  subtitle?: TextObject;
  width?: 'narrow' | 'standard' | 'wide' | 'full';
  icon?: ImageElement;
  is_collapsible?: boolean;
  default_collapsed?: boolean;
  has_header_divider?: boolean;
} & (
  | { title: PlainTextElement; rich_text_title?: SlackRichText }
  | { title?: PlainTextElement; rich_text_title: SlackRichText }
);
export type DataTableBlock = {
  type: 'data_table';
  block_id?: string;
  caption: string;
  page_size?: number;
  row_header_column_index?: number;
  rows: (SlackRichText | { type: 'raw_text'; text: string } | { type: 'raw_number'; value: number; text: string })[][];
};
export type DataVisualizationBlock = {
  type: 'data_visualization';
  block_id?: string;
  title: string;
  chart:
    | { type: 'pie'; segments: { label: string; value: number }[] }
    | {
        type: 'bar' | 'area' | 'line';
        series: { name: string; data: { label: string; value: number }[] }[];
        axis_config: { categories: string[]; x_label?: string; y_label?: string };
      };
};
export type SlackCard = Omit<CardBlock, 'title' | 'subtitle' | 'body'> & {
  title?: TextObject;
  subtitle?: TextObject;
  body?: TextObject;
  subtext?: TextObject;
  slack_icon?: {
    type: 'icon';
    name:
      | 'archive'
      | 'book'
      | 'bookmark'
      | 'bot'
      | 'bug'
      | 'calendar'
      | 'call'
      | 'caret-left'
      | 'caret-right'
      | 'check'
      | 'clipboard'
      | 'code'
      | 'comment'
      | 'compass'
      | 'copy'
      | 'cube'
      | 'download'
      | 'edit'
      | 'email'
      | 'eye-closed'
      | 'eye-open'
      | 'file'
      | 'flag'
      | 'folder'
      | 'gear'
      | 'globe'
      | 'heart'
      | 'help'
      | 'image'
      | 'info'
      | 'key'
      | 'lightbulb'
      | 'link'
      | 'map'
      | 'mobile'
      | 'new-window'
      | 'pin'
      | 'plus'
      | 'refine'
      | 'refresh'
      | 'rocket'
      | 'save'
      | 'screen'
      | 'share'
      | 'sparkle'
      | 'star'
      | 'star-filled'
      | 'tag'
      | 'thumbs-down'
      | 'thumbs-up'
      | 'trash'
      | 'upload'
      | 'user'
      | 'warning';
  };
};
export type SlackTask = Omit<TaskCardBlock, 'details' | 'output'> & { details?: SlackRichText; output?: SlackRichText };
export type SlackBlock =
  | ContainerChild
  | AlertBlock
  | ContextActionsBlock
  | MarkdownBlock
  | SlackCard
  | SlackTask
  | { type: 'carousel'; block_id?: string; elements: SlackCard[] }
  | { type: 'plan'; block_id?: string; title: string; tasks: Omit<SlackTask, 'type'>[] }
  | ContainerBlock
  | DataTableBlock
  | DataVisualizationBlock;
export type SlackMessage = { kind: 'message'; text: string; blocks: SlackBlock[] };
export type SlackModal = { kind: 'modal'; view: Omit<ModalView, 'blocks'> & { blocks: SlackBlock[] } };
export type SlackHome = { kind: 'home'; view: Omit<HomeView, 'blocks'> & { blocks: SlackBlock[] } };
export type SlackSurface = SlackMessage | SlackModal | SlackHome;

export const blockSurfaces = {
  actions: ['message', 'modal', 'home'],
  alert: ['message', 'modal', 'home'],
  card: ['message', 'modal', 'home'],
  carousel: ['message', 'modal', 'home'],
  container: ['message', 'home'],
  context: ['message', 'modal', 'home'],
  context_actions: ['message'],
  data_table: ['message', 'home'],
  data_visualization: ['message', 'home'],
  divider: ['message', 'modal', 'home'],
  file: [],
  header: ['message', 'modal', 'home'],
  image: ['message', 'modal', 'home'],
  input: ['message', 'modal', 'home'],
  markdown: ['message'],
  plan: ['message'],
  rich_text: ['message', 'modal', 'home'],
  section: ['message', 'modal', 'home'],
  table: ['message', 'home'],
  task_card: ['message'],
  video: ['message', 'modal', 'home'],
} satisfies Record<SlackBlock['type'], readonly SlackSurface['kind'][]>;
