import type { Definition } from '@tulipfarm/workflows/contracts';

export type CodeLanguage = Extract<Definition['steps'][number], { kind: 'code' }>['language'];

export const codeLanguages: Record<CodeLanguage, { name: string; extension: string; starter: string }> = {
  javascript: {
    name: 'JavaScript',
    extension: 'js',
    starter: '// `input` holds the value chosen in Input. Return JSON for later steps.\nreturn { result: input };\n',
  },
  typescript: {
    name: 'TypeScript',
    extension: 'ts',
    starter: '// `input` holds the value chosen in Input. Return JSON for later steps.\nreturn { result: input };\n',
  },
  python: {
    name: 'Python',
    extension: 'py',
    starter: '# `input` holds the value chosen in Input. Return JSON for later steps.\nreturn {"result": input}\n',
  },
  bash: {
    name: 'Bash',
    extension: 'sh',
    starter: '# $INPUT holds the value chosen in Input, as JSON. Print the result.\necho "$INPUT"\n',
  },
};

export const codeLanguageOrder: CodeLanguage[] = ['javascript', 'typescript', 'python', 'bash'];
