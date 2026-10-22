const context =
  'The pitch uses the current approved operating plan. Keep the source wording when presenting business facts. ';

export const retrievalCorpus = [
  {
    id: 'product',
    title: 'Pitch product',
    sections: [
      { heading: 'Product', fact: 'The product is a shared purchasing workspace for independent shops.' },
      { heading: 'Workflow', fact: 'The ordering workflow includes a manager approval before purchase.' },
      { heading: 'Scope', fact: 'The product does not provide consumer lending.' },
    ],
  },
  {
    id: 'customers',
    title: 'Pitch customers',
    sections: [
      { heading: 'Customers', fact: 'The initial customer group is grocery shops with two to ten locations.' },
      { heading: 'Region', fact: 'The first supported region is the fictional North Coast market.' },
      { heading: 'Problem', fact: 'Shop managers currently copy supplier orders between spreadsheets.' },
    ],
  },
  {
    id: 'results',
    title: 'Pitch results',
    sections: [
      { heading: 'Pilot', fact: 'The pilot involved 18 shops.' },
      { heading: 'Evidence', fact: 'The measured order preparation time fell from 50 minutes to 32 minutes.' },
      { heading: 'Limitations', fact: 'The pilot did not measure changes in revenue.' },
    ],
  },
  {
    id: 'pricing',
    title: 'Pitch pricing',
    sections: [
      { heading: 'Price', fact: 'The approved price is 120 fictional credits per shop per month.' },
      { heading: 'Trial', fact: 'The trial lasts 21 days.' },
      { heading: 'Contract', fact: 'The agreement renews monthly and has no annual commitment.' },
    ],
  },
].map(document => ({
  ...document,
  text: document.sections
    .map(section => `# ${section.heading}\n\n${context.repeat(7)}\n\n${section.fact}`)
    .join('\n\n'),
}));

export const retrievalCases = [
  {
    id: 'whole-pitch',
    question: 'Understand the pitch and prepare the source facts for a slide deck.',
    queries: ['pitch', 'workflow region evidence trial', 'scope problem limitations contract'],
    requiredFacts: retrievalCorpus.flatMap(document => document.sections.map(section => section.fact)),
  },
  {
    id: 'precise-price',
    question: 'What is the approved monthly price?',
    queries: ['approved price'],
    requiredFacts: [retrievalCorpus.find(document => document.id === 'pricing').sections[0].fact],
  },
  {
    id: 'missing-revenue',
    question: 'How much did revenue increase in the pilot?',
    queries: ['revenue'],
    requiredFacts: [retrievalCorpus.find(document => document.id === 'results').sections[2].fact],
    unavailableFacts: ['a measured revenue increase'],
  },
];
