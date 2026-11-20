// Whether the chat agent picks the right tool, and no tool when none is needed.
import { chatPaths, leadsPins } from '../paths.mjs';

export default {
  name: 'tool-choice',
  tolerance: 5,
  paths: chatPaths,
  harness: {},
  cases: [
    {
      id: 'fetch-a-page',
      name: 'Reads a page the person links',
      message: 'What plans are listed on https://example.com/pricing?',
      pinnedReads: [
        {
          tool: 'web.fetch',
          result: { url: 'https://example.com/pricing', text: 'Plans: Starter $10, Team $30, Business $90.' },
        },
      ],
      checks: [
        { kind: 'tool-called', tool: 'web.fetch' },
        { kind: 'text-contains', text: 'Team' },
      ],
    },
    {
      id: 'search-the-web',
      name: 'Searches the web for current facts',
      message: 'Search the web: what is the current Node.js LTS release line?',
      pinnedReads: [
        {
          tool: 'web.search',
          result: { results: [{ title: 'Node.js releases', snippet: 'Node.js 26 is the Active LTS line.' }] },
        },
      ],
      checks: [
        { kind: 'tool-called', tool: 'web.search' },
        { kind: 'text-contains', text: '26' },
      ],
    },
    {
      id: 'list-tables',
      name: 'Looks up tables instead of guessing',
      message: 'Which tables do I have in this workspace?',
      pinnedReads: leadsPins([]),
      // Only a table lookup can name the table, so the name shows that the agent looked instead of guessing.
      checks: [{ kind: 'text-contains', text: 'Leads' }],
    },
    {
      id: 'no-tool-for-small-talk',
      name: 'Answers small talk without tools',
      message: 'Thanks, that is all for today!',
      checks: [
        { kind: 'tool-not-called', tool: 'web.search' },
        { kind: 'tool-not-called', tool: 'tables.list' },
        { kind: 'tool-not-called', tool: 'knowledge.search' },
      ],
    },
    {
      id: 'no-tool-for-arithmetic',
      name: 'Answers arithmetic without tools',
      message: 'What is 17 times 23?',
      checks: [
        { kind: 'tool-not-called', tool: 'web.search' },
        { kind: 'text-contains', text: '391' },
      ],
    },
  ],
};
